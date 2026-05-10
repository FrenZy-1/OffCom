// ============================================
// webrtc.js — RTCPeerConnection, ICE, reconnection
// ============================================

// ---- ICE restart constants ----
const ICE_RESTART_TIMEOUT_MS = 8000;  // wait this long for ICE restart before full teardown
const MAX_RECONNECT_ATTEMPTS = 3;

// ---- PeerConnection factory ----

function createPeerConnection(peerId) {
	logWebRTC(peerId, 'Creating new RTCPeerConnection');
	const pc = new RTCPeerConnection({
		iceServers:          [],
		iceCandidatePoolSize: 4,
		iceTransportPolicy:  'all',
	});

	if (localStream) {
		const processed = processLocalStream(localStream);
		processed.getTracks().forEach(track => {
			logWebRTC(peerId, `Adding local track: ${track.kind}`);
			pc.addTrack(track, processed);
		});
	} else {
		logError(`[WebRTC] localStream is null when creating PC for ${peerId}!`);
	}

	pc.ontrack = async (event) => {
		logWebRTC(peerId, `Remote track received: ${event.track.kind}`);
		attachRemoteStream(peerId, event.streams[0]);
		updatePeerBadge(peerId, 'connected');
		updateCallStatus();
		// Guest auto-enters call screen on first audio track
		if (!isHost && document.getElementById('screenGuest')?.classList.contains('active')) {
			await showScreen('screenCall');
			refreshCallScreen();
		}
	};

	pc.onconnectionstatechange = () => {
		logWebRTC(peerId, `Connection state -> ${pc.connectionState} (ICE: ${pc.iceConnectionState}, signaling: ${pc.signalingState})`);
		const p = peers[peerId];
		if (!p) return;

		updatePeerBadge(peerId, pc.connectionState);

		if (pc.connectionState === 'connected') {
			// Successful (re)connect — cancel any pending recovery timers
			if (p.iceRestartTimer) {
				clearTimeout(p.iceRestartTimer);
				p.iceRestartTimer = null;
			}
			p.reconnectAttempts = 0;
			updateCallStatus();
			return;
		}

		if (intentionalDisconnect || p.peerDisconnected) return;

		if (pc.connectionState === 'disconnected') {
			// Soft failure — try ICE restart first (keeps DTLS alive, finds new path)
			logError(`[WebRTC] ${peerId} disconnected, attempting ICE restart`);
			attemptIceRestart(peerId);
		} else if (pc.connectionState === 'failed') {
			// Hard failure — go straight to full PC teardown
			logError(`[WebRTC] ${peerId} failed, doing full reconnect`);
			if (p.iceRestartTimer) { clearTimeout(p.iceRestartTimer); p.iceRestartTimer = null; }
			doFullReconnect(peerId);
		}
	};

	pc.onsignalingstatechange    = () => logWebRTC(peerId, `Signaling state -> ${pc.signalingState}`);
	pc.onicegatheringstatechange = () => logWebRTC(peerId, `ICE gathering state -> ${pc.iceGatheringState}`);
	pc.oniceconnectionstatechange = () => logWebRTC(peerId, `ICE connection state -> ${pc.iceConnectionState}`);

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			logWebRTC(peerId, `ICE candidate (type=${event.candidate.type} proto=${event.candidate.protocol})`);
			postMessage(peerId, 'candidate', { candidate: event.candidate });
		} else {
			logWebRTC(peerId, 'ICE gathering complete.');
		}
	};

	return pc;
}

// ---- Peer lifecycle ----

function initPeer(peerObj) {
	log('[Mesh] Init Peer:', peerObj);
	peers[peerObj.id] = {
		pc:                 createPeerConnection(peerObj.id),
		name:               peerObj.name,
		role:               peerObj.role,
		ver:                peerObj.ver || 0,
		reconnectAttempts:  0,
		iceRestartTimer:    null,
		peerDisconnected:   false,
		audioEl:            null,
		locallyMuted:       false,   // muted only on this device
		globallyMuted:      false,   // host muted them for the whole room
	};
	addPeerToUI(peerObj);
	updateHostUI();
	playSound('peerJoin');
}

function cleanupPeer(peerId) {
	const p = peers[peerId];
	if (!p) return;
	log(`[Cleanup] Removing peer ${peerId} (role=${p.role}, state=${p.pc?.connectionState})`);
	playSound('peerLeave');
	if (p.iceRestartTimer) { clearTimeout(p.iceRestartTimer); p.iceRestartTimer = null; }
	if (p.pc)      { try { p.pc.close(); } catch(e) {} }
	if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
	delete iceCandidateBuffer[peerId];
	removePeerFromUI(peerId);
	delete peers[peerId];
	updateCallStatus();
}

// ---- Offer / Answer ----

async function initiateOffer(targetPeerId, iceRestart = false) {
	const p = peers[targetPeerId];
	if (!p) return;
	const pc = p.pc;
	try {
		const opts = iceRestart ? { iceRestart: true } : {};
		logWebRTC(targetPeerId, `Creating offer${iceRestart ? ' (ICE restart)' : ''}...`);
		const offer = await pc.createOffer(opts);
		offer.sdp = enforceOpusFEC(offer.sdp);
		await pc.setLocalDescription(offer);
		logWebRTC(targetPeerId, 'Offer set as local description, posting to server.');
		postMessage(targetPeerId, 'offer', { sdp: offer });
	} catch(err) {
		logError(`[Mesh] Offer failed for ${targetPeerId}:`, err);
	}
}

// ---- Reconnection ----

/**
 * Stage 1 — ICE restart: reuse the existing PC, send a new offer with iceRestart:true.
 * The DTLS session stays alive; only ICE credentials are refreshed.
 * If recovery doesn't happen within ICE_RESTART_TIMEOUT_MS, escalate to full teardown.
 */
function attemptIceRestart(peerId) {
	const p = peers[peerId];
	if (!p || intentionalDisconnect) return;

	// Only do one ICE restart attempt before escalating
	if (p.reconnectAttempts > 0) {
		doFullReconnect(peerId);
		return;
	}

	p.reconnectAttempts++;
	log(`[Reconnect] ICE restart attempt for ${peerId}`);
	updatePeerBadge(peerId, 'reconnecting');

	// Arm a fallback timer
	if (p.iceRestartTimer) clearTimeout(p.iceRestartTimer);
	p.iceRestartTimer = setTimeout(() => {
		p.iceRestartTimer = null;
		const current = peers[peerId];
		if (current && current.pc.connectionState !== 'connected') {
			log(`[Reconnect] ICE restart timed out for ${peerId}, escalating to full reconnect`);
			doFullReconnect(peerId);
		}
	}, ICE_RESTART_TIMEOUT_MS);

	// Guest sends ICE restart offer; host just waits for it on the same PC
	if (!isHost) {
		initiateOffer(peerId, true);
	}
}

/**
 * Stage 2 — Full teardown: close the old PC, create a fresh one, guest sends a new offer.
 */
function doFullReconnect(peerId) {
	const p = peers[peerId];
	if (!p || intentionalDisconnect) return;

	if (p.iceRestartTimer) { clearTimeout(p.iceRestartTimer); p.iceRestartTimer = null; }

	if (p.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
		showToast(`${p.name} disconnected`, true);
		cleanupPeer(peerId);
		return;
	}

	p.reconnectAttempts++;
	log(`[Reconnect] Full reconnect attempt ${p.reconnectAttempts} for ${peerId}`);
	updatePeerBadge(peerId, 'reconnecting');

	p.pc.close();
	p.pc = createPeerConnection(peerId);

	// Guest always initiates the fresh offer
	if (!isHost) {
		initiateOffer(peerId, false);
	}
}

// Public alias used by the manual reconnect button in the UI
function handlePeerReconnection(peerId, force = false) {
	if (force) doFullReconnect(peerId);
	else       attemptIceRestart(peerId);
}

// ---- ICE candidate buffering ----
// Candidates can arrive before the remote description is set; buffer them.

async function flushIceCandidateBuffer(peerId) {
	const buf = iceCandidateBuffer[peerId];
	if (!buf || buf.length === 0) return;
	logWebRTC(peerId, `Flushing ${buf.length} buffered ICE candidate(s).`);
	const pc = peers[peerId]?.pc;
	if (!pc) { logError(`[ICE Buffer] No PC for ${peerId}, discarding.`); delete iceCandidateBuffer[peerId]; return; }
	for (const candidate of buf) {
		try {
			await pc.addIceCandidate(new RTCIceCandidate(candidate));
			logWebRTC(peerId, 'Applied buffered ICE candidate.');
		} catch(e) {
			logError(`[ICE Buffer] Failed to apply candidate for ${peerId}:`, e);
		}
	}
	delete iceCandidateBuffer[peerId];
}

// ---- Signaling message handler ----

async function handleSignalingMessage(msg) {
	const fromId = msg.from;
	log(`[Mesh] Received ${msg.type} from ${fromId}`);

	if (!peers[fromId]) {
		logError(`[Mesh] Message from unknown peer: ${fromId}. Creating fallback entry.`);
		initPeer({ id: fromId, name: `Unknown (${fromId})`, role: 'guest', ver: 0 });
	}

	const p = peers[fromId];

	if (msg.type === 'offer') {
		const sigState  = p.pc.signalingState;
		const connState = p.pc.connectionState;
		log(`[Mesh] Offer from ${fromId}: signalingState=${sigState} connectionState=${connState}`);

		// ICE restart offer arrives on a disconnected/failed PC — keep the same PC, don't recreate
		const isIceRestartOffer = connState === 'disconnected' || connState === 'failed';

		if (!isIceRestartOffer && (sigState !== 'stable' || connState === 'connected')) {
			logError(`[Mesh] Glare or stale state (sig=${sigState} conn=${connState}), recreating PC`);
			p.pc.close();
			p.pc = createPeerConnection(fromId);
		}

		// Cancel any pending ICE restart timer — the offer itself IS the restart
		if (p.iceRestartTimer) {
			clearTimeout(p.iceRestartTimer);
			p.iceRestartTimer = null;
		}
	}

	const pc = peers[fromId].pc;

	try {
		if (msg.type === 'offer') {
			logWebRTC(fromId, 'Applying remote offer...');
			await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp));
			const answer = await pc.createAnswer();
			answer.sdp = enforceOpusFEC(answer.sdp);  // Enable Opus FEC for better reconnection robustness
			await pc.setLocalDescription(answer);
			logWebRTC(fromId, 'Sent answer back.');
			postMessage(fromId, 'answer', { sdp: answer });
			await flushIceCandidateBuffer(fromId);

		} else if (msg.type === 'answer') {
			logWebRTC(fromId, 'Applying remote answer...');
			await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp));
			await flushIceCandidateBuffer(fromId);

		} else if (msg.type === 'candidate') {
			if (!pc.remoteDescription?.type) {
				logWebRTC(fromId, 'ICE candidate arrived before remote description — buffering.');
				if (!iceCandidateBuffer[fromId]) iceCandidateBuffer[fromId] = [];
				iceCandidateBuffer[fromId].push(msg.payload.candidate);
			} else {
				logWebRTC(fromId, 'Applying ICE candidate...');
				await pc.addIceCandidate(new RTCIceCandidate(msg.payload.candidate));
			}
		}
	} catch(e) {
		logError(`[Mesh] Error handling ${msg.type} from ${fromId}:`, e);
	}
}

// ---- Mesh entry point ----

function startMesh() {
	// No polling needed — server pushes roster updates over the open WebSocket
	log('[Mesh] WS-driven mesh active (no polling)');
}

// ---- Connection Quality Improvement ----

function enforceOpusFEC(sdp) {
	// Find the Opus payload type (usually 111)
	const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
	if (!match) return sdp;
	const pt = match[1];

	const fmtpRegex = new RegExp(`a=fmtp:${pt} (.*)`);
	if (fmtpRegex.test(sdp)) {
		return sdp.replace(fmtpRegex, `a=fmtp:${pt} $1;useinbandfec=1;usedtx=0;cbr=1`);
	} else {
		return sdp + `a=fmtp:${pt} useinbandfec=1;usedtx=0;cbr=1\r\n`;
	}
}