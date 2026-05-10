// ============================================
// signaling.js — WebSocket signaling layer
// ============================================

function wsUrl() {
	return signalingUrl.replace(/^http/, 'ws') + '/ws';
}

// Open WebSocket, register with server. Returns a Promise that resolves on 'registered'.
function openWebSocket(roomId) {
	return new Promise((resolve, reject) => {
		if (ws) { try { ws.close(); } catch(e) {} }

		log(`[WS] Connecting to ${wsUrl()}`);
		ws = new WebSocket(wsUrl());

		const timeout = setTimeout(() => {
			logError('[WS] Connection timeout');
			ws.close();
			reject(new Error('WebSocket connection timed out'));
		}, 12000);

		ws.onopen = () => {
			log('[WS] Connected — registering...');
			clearTimeout(timeout);
			wsSend({
				type: 'register',
				room: roomId,
				peer: myDeviceId,
				name: myUsername,
				role: isHost ? 'host' : 'guest',
			});
		};

		ws.onmessage = (evt) => {
			let msg;
			try { msg = JSON.parse(evt.data); } catch(e) { return; }
			log(`[WS] ← ${msg.type}`, msg);

			if (msg.type === 'registered') {
				wsReady = true;
				startWsPing();
				resolve(true);
				return;
			}
			handleServerMessage(msg);
		};

		ws.onerror = (e) => {
			logError('[WS] Error', e);
			clearTimeout(timeout);
			reject(new Error('WebSocket error'));
		};

		ws.onclose = (e) => {
			log(`[WS] Closed (code=${e.code} intentional=${intentionalDisconnect})`);
			wsReady = false;
			stopWsPing();
			if (!intentionalDisconnect) scheduleWsReconnect(roomId);
		};
	});
}

function wsSend(obj) {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		logError('[WS] Cannot send — socket not open:', obj.type);
		return;
	}
	ws.send(JSON.stringify(obj));
}

function startWsPing() {
	stopWsPing();
	wsPingTimer = setInterval(() => {
		if (ws && ws.readyState === WebSocket.OPEN) wsSend({ type: 'ping' });
	}, WS_PING_MS);
}

function stopWsPing() {
	if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
}

function scheduleWsReconnect(roomId, delayMs = 1000) {
	if (wsReconnTimer) return;
	log(`[WS] Scheduling reconnect in ${delayMs}ms...`);
	wsReconnTimer = setTimeout(async () => {
		wsReconnTimer = null;
		if (intentionalDisconnect || !currentRoomId) return;
		log('[WS] Attempting reconnect...');
		try {
			await openWebSocket(roomId);
			log('[WS] Reconnected');
		} catch(e) {
			logError('[WS] Reconnect failed:', e);
			// Back off slightly on repeated failures (max 5s)
			scheduleWsReconnect(roomId, Math.min(delayMs * 1.5, 5000));
		}
	}, delayMs);
}

function closeWebSocket() {
	stopWsPing();
	if (wsReconnTimer) { clearTimeout(wsReconnTimer); wsReconnTimer = null; }
	wsReady = false;
	if (ws) { try { ws.close(); } catch(e) {} ws = null; }
}

// Wrap openWebSocket for call-site compatibility
async function registerGuest(roomId) {
	try {
		await openWebSocket(roomId);
		return true;
	} catch(e) {
		logError('[WS] registerGuest failed:', e);
		showToast('Cannot connect to server. Is it running?', true);
		return false;
	}
}

// Send a WebRTC signaling message to a specific peer via the server relay
function postMessage(toPeer, type, payload) {
	wsSend({ type, room: currentRoomId, from: myDeviceId, to: toPeer, payload });
}

function postLeave(roomId, peerId) {
	wsSend({ type: 'leave', room: roomId, peer: peerId });
}

function toggleDebugMode(enabled) {
	DEBUG = enabled;
	localStorage.setItem('offcom_debug', enabled);
	wsSend({ type: 'debug', enable: enabled });
	showToast(enabled ? 'Debug Enabled (Check Console)' : 'Debug Disabled', false);
}

// ---- Incoming server message router ----

function handleServerMessage(msg) {
	if (msg.type === 'pong') return;

	if (msg.type === 'roster') {
		processRoster(msg.peers || []);
		return;
	}

	if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'candidate') {
		handleSignalingMessage(msg);
		return;
	}

	if (msg.type === 'room_closed') {
		showToast('Host ended the room', true);
		// Cancel any pending grace-period timer — the host explicitly left, no point waiting
		if (hostVanishedTimer) { clearTimeout(hostVanishedTimer); hostVanishedTimer = null; }
		disconnect();
		return;
	}

	if (msg.type === 'kick') {
		logError('[Mesh] Received kick signal');
		showToast('You were kicked by the host!', true);
		disconnect();
		return;
	}

	if (msg.type === 'mute') {
		isLocalMuted = true;
		if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
		updateMuteButtonUI();
		showToast('🔇 You were muted by the host', true);
		return;
	}

	if (msg.type === 'unmute') {
		isLocalMuted = false;
		if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
		updateMuteButtonUI();
		showToast('🎙️ You were unmuted by the host', false);
		return;
	}

	if (msg.type === 'chat') {
		appendChatMessage(msg.name, msg.text, false);
		return;
	}
}

// Process a roster push from the server
function processRoster(roster) {
	log(`[Roster] ${roster.length} peer(s): ${JSON.stringify(roster.map(p => `${p.id}/${p.role}/v${p.ver}`))}`);

	if (!isHost) {
		const hostActive = roster.some(p => p.role === 'host');
		if (!hostActive && roster.length > 0 && !intentionalDisconnect) {
			// Don't hard-disconnect immediately — the host's WS might have just blipped
			// (Android hotspot network shuffle). Give it a grace period to come back.
			if (!hostVanishedTimer) {
				log(`[Mesh] Host missing from roster — grace period started (${HOST_VANISHED_GRACE_MS}ms)`);
				hostVanishedTimer = setTimeout(() => {
					hostVanishedTimer = null;
					if (!intentionalDisconnect && !Object.values(peers).some(p => p.role === 'host')) {
						logError('[Mesh] Host vanished — grace period expired, disconnecting');
						showToast('Host ended the room!', true);
						disconnect();
					}
				}, HOST_VANISHED_GRACE_MS);
			}
			// Don't process peer adds/removes while waiting — roster may be mid-transition
			return;
		} else if (hostActive && hostVanishedTimer) {
			clearTimeout(hostVanishedTimer);
			hostVanishedTimer = null;
			log('[Mesh] Host reappeared — grace period cancelled');
		}
	}

	const activeIds = roster.map(p => p.id);

	// Remove peers no longer in roster, or that have rejoined with a higher ver
	for (const pid of Object.keys(peers)) {
		const remote      = roster.find(p => p.id === pid);
		const hasRejoined = remote && remote.ver > (peers[pid].ver || 0);
		if (!activeIds.includes(pid) || hasRejoined) {
			if (hasRejoined) {
				log(`[Mesh] ${pid} rejoined (ver ${peers[pid].ver} → ${remote.ver})`);
				showToast(`${peers[pid].name} rejoined`, false);
			} else {
				showToast(`${peers[pid].name} left`, false);
			}
			cleanupPeer(pid);
		}
	}

	// Init new peers and decide who sends the offer
	for (const peerObj of roster) {
		if (peerObj.id === myDeviceId) continue;
		if (!peers[peerObj.id]) {
			log(`[Mesh] New peer in roster: ${peerObj.id}`);
			initPeer(peerObj);

			if (!isHost) {
				// Offer initiation rules:
				//  • Guest always offers to the host (host never initiates)
				//  • Between two guests, only the one whose ID sorts HIGHER sends the offer.
				//    Both sides use the same comparison so exactly one offer is sent (no glare).
				const shouldOffer = peerObj.role === 'host' || myDeviceId > peerObj.id;
				if (shouldOffer) {
					log(`[Mesh] ${myDeviceId} > ${peerObj.id} — I send the offer`);
					initiateOffer(peerObj.id);
				} else {
					log(`[Mesh] ${myDeviceId} < ${peerObj.id} — waiting for their offer`);
				}
			}
		}
	}
}
