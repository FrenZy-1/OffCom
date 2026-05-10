// ============================================
// room.js — Role selection, room management, disconnect, init
// ============================================

// ---- Role selection ----

async function selectRole(role) {
	log('[Init] Selecting role:', role);
	isHost = role === 'host';
	intentionalDisconnect = false;

	try {
		showToast('Requesting microphone...', false);
		const savedMicId  = localStorage.getItem('offcom_mic_device_id') || '';
		const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 };
		if (savedMicId) constraints.deviceId = { exact: savedMicId };

		localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
		log('[Audio] Mic granted. Tracks:', localStream.getAudioTracks().length);

		// Kick off screenCall fetch in background — it'll be in the DOM before ICE finishes
		preloadScreen('screenCall');

		isLocalMuted = false;
		applyTransmitMode();
		updateMuteButtonUI();

		showToast('Microphone ready!', false);
		await showScreen(isHost ? 'screenHost' : 'screenGuest');
	} catch (err) {
		logError('[Audio] Mic error:', err);
		showToast('ERROR: Allow microphone in Chrome!');
	}
}

// ---- Host: create room ----

async function createHostRoom() {
	const btn = document.getElementById('createOfferBtn');
	intentionalDisconnect = false;
	try {
		log('[Init] createHostRoom clicked');
		btn.disabled  = true;
		btn.innerHTML = '<span class="loading"></span>Creating...';

		currentRoomId = generateRandomId(16);
		signalingUrl  = window.location.origin;

		const myIdDisplay = document.getElementById('myIdDisplay');
		if (myIdDisplay) myIdDisplay.textContent = `${myUsername} (${myDeviceId})`;

		document.getElementById('qrDisplayCard')?.classList.remove('hidden');
		document.getElementById('waitForGuestCard')?.classList.remove('hidden');

		const qrData    = `OFFCOM:ROOM:${signalingUrl}::${currentRoomId}`;
		savedRoomQrData = qrData;
		generateQRCode('hostQRContainer', qrData);

		const roomIdDisplay = document.getElementById('roomIdDisplay');
		if (roomIdDisplay) roomIdDisplay.textContent = currentRoomId;

		const ok = await registerGuest(currentRoomId);
		if (!ok) {
			logError('[Init] Server unreachable.');
			showToast('Cannot reach server. Is it running?', true);
			btn.disabled  = false;
			btn.innerHTML = 'Create Room';
			currentRoomId = null;
			document.getElementById('qrDisplayCard')?.classList.add('hidden');
			document.getElementById('waitForGuestCard')?.classList.add('hidden');
			return;
		}

		btn.innerHTML = 'Room Created';
		showToast(`Room ${currentRoomId} created!`, false);
		startMesh();
		playSound('join');
	} catch(err) {
		logError('[Init] createHostRoom error:', err);
		showToast('Error: ' + err.message, true);
		btn.disabled  = false;
		btn.innerHTML = 'Create Room';
	}
}

async function startCallWithPeers() {
	await showScreen('screenCall');
	refreshCallScreen();
}

// ---- Guest: join room ----

async function joinRoom(url, roomId) {
	intentionalDisconnect = false;
	signalingUrl          = url;
	currentRoomId         = roomId;

	const myIdDisplay = document.getElementById('myIdDisplay');
	if (myIdDisplay) myIdDisplay.textContent = `${myUsername} (${myDeviceId})`;

	try {
		log(`[Init] Joining room ${roomId} at ${url}`);
		showToast('Joining room...', false);

		const ok = await registerGuest(roomId);
		if (!ok) {
			logError('[Init] Registration failed.');
			showToast('Cannot reach server. Is it running?', true);
			currentRoomId = null;
			return;
		}

		savedRoomQrData = `OFFCOM:ROOM:${url}::${roomId}`;
		await showScreen('screenCall');
		refreshCallScreen();
		showToast('Connected to room!', false);

		startMesh();
		requestWakeLock();
		playSound('join');
	} catch(err) {
		logError('[Init] joinRoom error:', err);
		showToast('Error joining: ' + err.message, true);
	}
}

async function guestEnterCall() {
	await showScreen('screenCall');
	refreshCallScreen();
}

function joinRoomManual() {
	const roomId = document.getElementById('manualRoomId')?.value.trim().toUpperCase();
	if (!roomId) return showToast('Enter room ID!', true);
	joinRoom(window.location.origin, roomId);
}

// ---- Disconnect ----

async function disconnect() {
	log(`[Cleanup] disconnect() called — room=${currentRoomId} isHost=${isHost} peers=${Object.keys(peers).join(',')}`);

	playSound('leave');
	intentionalDisconnect = true;

	// Send leave BEFORE closing the socket so the server can notify other peers
	if (currentRoomId && myDeviceId) postLeave(currentRoomId, myDeviceId);
	closeWebSocket();

	for (const peerId of Object.keys(peers)) cleanupPeer(peerId);

	if (voxCheckInterval)   { clearInterval(voxCheckInterval);   voxCheckInterval   = null; }
	if (voxHoldTimer)       { clearTimeout(voxHoldTimer);       voxHoldTimer       = null; }
	if (hostVanishedTimer)  { clearTimeout(hostVanishedTimer);  hostVanishedTimer  = null; }

	if (localStream)   { localStream.getTracks().forEach(t => t.stop()); localStream   = null; }
	if (audioContext)  { audioContext.close(); audioContext = null; micGainNode = speakerGainNode = analyserNode = localSource = null; }

	voxActive = false; isPttActive = false; isLocalMuted = false;
	pttLatchedActive = false; pttLatchEnabled = false;
	savedRoomQrData  = null;
	currentRoomId    = null;
	transmitMode     = 'open';

	updateMuteButtonUI();

	const btn = document.getElementById('createOfferBtn');
	if (btn) { btn.disabled = false; btn.innerHTML = 'Create Room'; }

	document.getElementById('qrDisplayCard')?.classList.add('hidden');
	document.getElementById('waitForGuestCard')?.classList.add('hidden');
	document.getElementById('reconnectCard')?.classList.add('hidden');

	const chatContainer = document.getElementById('chatMessages');
	if (chatContainer) chatContainer.innerHTML = '';

	const peersList = document.getElementById('peersList');
	if (peersList) peersList.innerHTML = '';

	const manualDropdown = document.getElementById('reconnectDropdown');
	if (manualDropdown) manualDropdown.innerHTML = '<option value="">Select peer...</option>';

	const startBtn = document.getElementById('startCallBtn');
	if (startBtn) startBtn.style.display = 'none';

	releaseWakeLock();
	await showScreen('screenRole');
}

async function goBack() { await disconnect(); }

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
	log('=== OffCom Initializing ===');
	loadCustomSounds();
	loadVoxSettings();
	if (typeof qrcode === 'undefined')         showToast('ERROR: QR library not loaded!', true);
	if (typeof jsQR === 'undefined')           showToast('ERROR: Scanner library not loaded!', true);
	if (!navigator.mediaDevices?.getUserMedia) showToast('ERROR: WebRTC not supported!', true);
	requestWakeLock();
	
	// Boot the first screen dynamically
	await showScreen('screenRole');
	
	log('=== OffCom Ready ===');
});

document.addEventListener('visibilitychange', () => {
	if (!document.hidden) {
		log('[System] Tab visible — resuming WakeLock & AudioContext');
		requestWakeLock();
		if (audioContext?.state === 'suspended') audioContext.resume();
	}
});
