#!/usr/bin/env python3
"""
OffCom Signaling Server — WebSocket edition
Pure stdlib: asyncio + ssl. Zero pip dependencies.
Serves static files over HTTPS and WebSocket signaling over WSS on the same port.
"""
import asyncio
import ssl
import json
import hashlib
import base64
import struct
import time
import os
import signal
import urllib.parse

PORT    = 8443
WS_PATH = "/ws"
DEBUG   = True

# ── Shared state ─────────────────────────────────────────────────────────────
rooms      = {}   # room_id → { "peers": { peer_id → PeerState }, "leave": bool }
rooms_lock = None # asyncio.Lock() created inside main()

def log(*a):
    if DEBUG:
        print("[Server]", *a, flush=True)

# ── Peer state ────────────────────────────────────────────────────────────────
class PeerState:
    def __init__(self, peer_id, name, role):
        self.id        = peer_id
        self.name      = name
        self.role      = role
        self.ver       = 1
        self.last_seen = time.time()
        self.writer    = None
        self.left      = False

    def to_dict(self):
        return {"id": self.id, "name": self.name, "role": self.role, "ver": self.ver}

# ── Room helpers ──────────────────────────────────────────────────────────────
async def get_or_create_room(room_id):
    async with rooms_lock:
        if room_id not in rooms:
            rooms[room_id] = {"peers": {}, "leave": False}
            log(f"Room created: {room_id}")
        return rooms[room_id]

async def register_peer(room_id, peer_id, name, role):
    await get_or_create_room(room_id)
    async with rooms_lock:
        room = rooms[room_id]
        if peer_id in room["peers"]:
            p = room["peers"][peer_id]
            p.name = name; p.role = role
            p.ver += 1; p.last_seen = time.time(); p.left = False
        else:
            p = PeerState(peer_id, name, role)
            room["peers"][peer_id] = p
        if role == "host":
            room["leave"] = False
        log(f"Registered {name} ({peer_id}) as {role} ver={p.ver} in {room_id}")
        return p.ver

async def mark_left(room_id, peer_id):
    async with rooms_lock:
        room = rooms.get(room_id)
        if room and peer_id in room["peers"]:
            peer = room["peers"][peer_id]
            if peer.left:
                return  # already marked — ignore duplicate (client leave + WS finally)
            peer.left   = True
            peer.writer = None
            log(f"Peer left: {peer_id} in {room_id}")

async def get_active_peers(room_id, touch_id=None):
    async with rooms_lock:
        room = rooms.get(room_id, {})
        peers_map = room.get("peers", {})
        if touch_id and touch_id in peers_map:
            peers_map[touch_id].last_seen = time.time()
        return [p.to_dict() for p in peers_map.values() if not p.left]

async def relay(room_id, to_id, msg_obj):
    async with rooms_lock:
        room  = rooms.get(room_id, {})
        peer  = room.get("peers", {}).get(to_id)
        if not peer or peer.left or not peer.writer:
            log(f"Cannot relay to {to_id}: unavailable")
            return
        writer = peer.writer
    try:
        await ws_send(writer, json.dumps(msg_obj))
        log(f"Relayed [{msg_obj.get('type')}] to {to_id}")
    except Exception as e:
        log(f"Relay write error for {to_id}: {e}")

async def broadcast_roster(room_id):
    roster = await get_active_peers(room_id)
    msg    = json.dumps({"type": "roster", "peers": roster})
    async with rooms_lock:
        room   = rooms.get(room_id, {})
        writers = [(pid, p.writer) for pid, p in room.get("peers", {}).items()
                   if not p.left and p.writer]
    for pid, writer in writers:
        try:
            await ws_send(writer, msg)
        except Exception as e:
            log(f"Broadcast error for {pid}: {e}")

# ── WebSocket framing (RFC 6455) ──────────────────────────────────────────────
MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def ws_accept_header(key):
    digest = base64.b64encode(hashlib.sha1((key + MAGIC).encode()).digest()).decode()
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {digest}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n"
    ).encode()

async def ws_send(writer, text):
    data = text.encode()
    n    = len(data)
    if   n < 126:    hdr = struct.pack("!BB",  0x81, n)
    elif n < 65536:  hdr = struct.pack("!BBH", 0x81, 126, n)
    else:            hdr = struct.pack("!BBQ", 0x81, 127, n)
    writer.write(hdr + data)
    await writer.drain()

async def ws_recv(reader):
    try:
        h = await reader.readexactly(2)
    except Exception:
        return None, None
    opcode = h[0] & 0x0F
    masked = bool(h[1] & 0x80)
    n      = h[1] & 0x7F
    if   n == 126: n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127: n = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b""
    data = await reader.readexactly(n)
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data

# ── Static file serving ───────────────────────────────────────────────────────
MIME = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css",   ".json": "application/json",
    ".wav": "audio/wav",  ".png": "image/png",
    ".otf": "font/otf",   ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
}

def build_http_response(status, ctype, body):
    return (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Access-Control-Allow-Origin: *\r\n"
        f"Connection: close\r\n\r\n"
    ).encode() + body

def serve_static_sync(path, writer):
    clean = urllib.parse.urlparse(path).path
    if clean in ("/", ""):
        clean = "/index.html"
    fpath = "." + clean
    if not os.path.isfile(fpath):
        writer.write(build_http_response("404 Not Found", "text/plain", b"Not Found"))
        return
    ext   = os.path.splitext(fpath)[1].lower()
    ctype = MIME.get(ext, "application/octet-stream")
    with open(fpath, "rb") as f:
        body = f.read()
    writer.write(build_http_response("200 OK", ctype, body))

# ── Connection dispatcher ─────────────────────────────────────────────────────
async def handle_connection(reader, writer):
    peer_id = None
    room_id = None
    try:
        # Read HTTP request headers
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = await reader.read(4096)
            if not chunk:
                return
            raw += chunk
        header_text = raw.split(b"\r\n\r\n")[0].decode("latin-1")
        lines       = header_text.splitlines()
        req_line    = lines[0].split()
        path        = req_line[1] if len(req_line) > 1 else "/"

        hdrs = {}
        for line in lines[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                hdrs[k.strip().lower()] = v.strip()

        # WebSocket upgrade?
        if hdrs.get("upgrade", "").lower() == "websocket" and path.split("?")[0] == WS_PATH:
            writer.write(ws_accept_header(hdrs.get("sec-websocket-key", "")))
            await writer.drain()
            # ── WebSocket session loop ──────────────────────────────────
            try:
                while True:
                    opcode, payload = await ws_recv(reader)
                    if opcode is None or opcode == 8:
                        break
                    if opcode == 9:  # ping → pong
                        writer.write(struct.pack("!BB", 0x8A, 0))
                        await writer.drain()
                        continue
                    if opcode not in (1, 2):
                        continue
                    try:
                        msg = json.loads(payload.decode())
                    except Exception:
                        continue

                    mtype = msg.get("type", "")
                    if mtype != "ping":
                        log(f"WS [{mtype}] from={msg.get('from','?')} room={msg.get('room','?')}")

                    if mtype == "register":
                        room_id = msg["room"]
                        peer_id = msg["peer"]
                        ver     = await register_peer(room_id, peer_id, msg.get("name", peer_id), msg.get("role", "guest"))
                        async with rooms_lock:
                            rooms[room_id]["peers"][peer_id].writer = writer
                        await ws_send(writer, json.dumps({"type": "registered", "ver": ver}))
                        await broadcast_roster(room_id)

                    elif mtype in ("offer", "answer", "candidate", "kick", "mute", "unmute"):
                        await relay(msg["room"], msg["to"], msg)
                    
                    elif mtype == "chat":
                        # Broadcast chat to everyone else in the room
                        async with rooms_lock:
                            room = rooms.get(msg["room"], {})
                            writers =[(pid, p.writer) for pid, p in room.get("peers", {}).items()
                                       if pid != peer_id and not p.left and p.writer]
                        for pid, writer in writers:
                            try:
                                await ws_send(writer, json.dumps(msg))
                            except Exception:
                                pass

                    elif mtype == "leave":
                        leaving_id  = msg.get("peer", peer_id)
                        leaving_rid = msg.get("room", room_id)

                        # If the host is explicitly leaving, notify guests immediately
                        # so they don't have to wait out the 8-second grace period.
                        async with rooms_lock:
                            room_obj  = rooms.get(leaving_rid, {})
                            leaver    = room_obj.get("peers", {}).get(leaving_id)
                            is_host   = leaver and leaver.role == "host"
                            if is_host:
                                notify_writers = [
                                    (pid, p.writer)
                                    for pid, p in room_obj.get("peers", {}).items()
                                    if pid != leaving_id and not p.left and p.writer
                                ]
                        if is_host:
                            closed_msg = json.dumps({"type": "room_closed"})
                            for pid, w in notify_writers:
                                try:
                                    await ws_send(w, closed_msg)
                                    log(f"Sent room_closed to {pid}")
                                except Exception:
                                    pass

                        await mark_left(leaving_rid, leaving_id)
                        await broadcast_roster(leaving_rid)

                    elif mtype == "ping":
                        if peer_id and room_id:
                            async with rooms_lock:
                                p = rooms.get(room_id, {}).get("peers", {}).get(peer_id)
                                if p:
                                    p.last_seen = time.time()
                        await ws_send(writer, json.dumps({"type": "pong"}))

                    elif mtype == "debug":
                        global DEBUG
                        DEBUG = bool(msg.get("enable", False))

            except Exception as e:
                log(f"WS session error ({peer_id}): {e}")
            finally:
                if peer_id and room_id:
                    await mark_left(room_id, peer_id)
                    await broadcast_roster(room_id)
                    log(f"WS disconnected: {peer_id}")
        else:
            # Static file
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, serve_static_sync, path, writer)
            await writer.drain()

    except Exception as e:
        log(f"Connection error: {e}")
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

# ── Cleanup loop ──────────────────────────────────────────────────────────────
async def roster_heartbeat():
    """Push roster to all peers every 15s as a safety net for missed events.
    Normal peer join/leave events are pushed immediately via broadcast_roster().
    """
    while True:
        await asyncio.sleep(15)
        async with rooms_lock:
            room_ids = list(rooms.keys())
        for rid in room_ids:
            try:
                await broadcast_roster(rid)
            except Exception:
                pass

async def cleanup_loop():
    while True:
        await asyncio.sleep(15)
        now = time.time()
        async with rooms_lock:
            dead = []
            for rid, room in rooms.items():
                for pid, peer in list(room["peers"].items()):
                    if not peer.left and peer.writer is None and (now - peer.last_seen) > 45:
                        peer.left = True
                        log(f"Timeout (no WS): {pid} in {rid}")
                active = [p for p in room["peers"].values() if not p.left]
                if not active:
                    dead.append(rid)
            for rid in dead:
                log(f"GC: removing empty room {rid}")
                del rooms[rid]

# ── Main ──────────────────────────────────────────────────────────────────────
async def main():
    global rooms_lock
    rooms_lock = asyncio.Lock()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain("cert.pem", "key.pem")

    server = await asyncio.start_server(handle_connection, "0.0.0.0", PORT, ssl=ctx)
    asyncio.create_task(cleanup_loop())
    asyncio.create_task(roster_heartbeat())

    loop      = asyncio.get_running_loop()
    stop_evt  = asyncio.Event()

    def _handle_exit():
        if not stop_evt.is_set():
            print("\n[Server] Shutting down gracefully...", flush=True)
            stop_evt.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _handle_exit)

    print(f"OffCom WebSocket server on port {PORT} (WSS + HTTPS)", flush=True)
    print(f"[Server] Press Ctrl+C once to stop.", flush=True)

    async with server:
        await stop_evt.wait()

    print("[Server] Goodbye.", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
