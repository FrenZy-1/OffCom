// ============================================
// ui.js — UI helpers, peer badges, QR, scanner, settings
// ============================================

// ---- Toast & screen navigation ----

function showToast(message, isError = true) {
	log(isError ? '[Toast ERROR]' : '[Toast INFO]', message);
	const toast = document.getElementById('toast');
	if (!toast) return;
	toast.textContent = message;
	toast.className   = isError ? 'toast' : 'toast success';
	toast.classList.add('show');
	setTimeout(() => toast.classList.remove('show'), 3000);
}

async function showScreen(screenId) {
	log('[UI] Showing screen:', screenId);

	// If the screen isn't in the DOM yet, fetch it dynamically
	if (!document.getElementById(screenId)) {
		try {
			// Converts "screenRole" to "screen-role.html" automatically
			const fileName = screenId.replace(/([A-Z])/g, '-$1').toLowerCase() + '.html';
			log('[UI] Fetching dynamically:', fileName);
			
			const response = await fetch(`HTML/${fileName}`);
			if (!response.ok) throw new Error('File not found');
			const html = await response.text();
			
			// Inject it into the main content container
			document.getElementById('mainContent').insertAdjacentHTML('afterbegin', html);
		} catch(e) {
			logError('[UI] Failed to load screen dynamically:', screenId, e);
			showToast('Error loading screen layout', true);
			return; // Stop execution if it failed
		}
	}

	// Hide all screens, then show the requested one
	document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
	document.getElementById(screenId)?.classList.add('active');
}

// ---- Screen preloader ----
// Fetches and injects a screen partial into the DOM without switching to it.
// Call fire-and-forget so the HTML is ready when showScreen() needs it.

async function preloadScreen(screenId) {
	if (document.getElementById(screenId)) return; // already in DOM
	try {
		const fileName = screenId.replace(/([A-Z])/g, '-$1').toLowerCase() + '.html';
		log('[UI] Preloading screen:', fileName);
		const response = await fetch(`HTML/${fileName}`);
		if (!response.ok) throw new Error('Not found');
		const html = await response.text();
		document.getElementById('mainContent').insertAdjacentHTML('afterbegin', html);
	} catch(e) {
		logError('[UI] Preload failed for', screenId, e);
	}
}

// ---- Call screen refresh ----
// screenCall is fetched lazily, so UI state written before it existed
// (peer badges, myIdDisplay, transmit mode) is lost. Call this every time
// screenCall becomes active to replay all live state into its fresh DOM.

function refreshCallScreen() {
	// Identity
	const myIdDisplay = document.getElementById('myIdDisplay');
	if (myIdDisplay) myIdDisplay.textContent = `${myUsername} (${myDeviceId})`;

	// Rebuild peer badges from live state
	const list = document.getElementById('peersList');
	if (list) {
		list.innerHTML = '';  // wipe so addPeerToUI duplicate-guard passes cleanly
		for (const [pid, p] of Object.entries(peers)) {
			addPeerToUI({ id: pid, name: p.name, role: p.role });
			updatePeerBadge(pid, p.pc?.connectionState);
			const badge = document.getElementById('peer_badge_' + pid);
			if (!badge) continue;
			if (p.locallyMuted) {
				badge.classList.add('muted');
				const nameEl = badge.querySelector('.peer-name');
				if (nameEl && !nameEl.querySelector('.mute-icon-local')) {
					const icon = document.createElement('span');
					icon.className = 'mute-icon-local';
					icon.textContent = ' 🔇';
					icon.title = 'Muted locally';
					nameEl.appendChild(icon);
				}
			}
			if (p.globallyMuted && isHost) {
				badge.classList.add('globally-muted');
				const nameEl = badge.querySelector('.peer-name');
				if (nameEl && !nameEl.querySelector('.mute-icon-global')) {
					const icon = document.createElement('span');
					icon.className = 'mute-icon-global';
					icon.textContent = ' 🔕';
					icon.title = 'Muted for room';
					nameEl.appendChild(icon);
				}
			}
		}
	}

	// Transmit mode — restore buttons and panels without resetting VOX/PTT state
	document.querySelectorAll('.transmit-btn').forEach(b => b.classList.remove('active'));
	document.getElementById('transmit-' + transmitMode)?.classList.add('active');
	document.getElementById('voxSettings')?.classList.toggle('hidden', transmitMode !== 'vox');
	document.getElementById('pttContainer')?.classList.toggle('hidden', transmitMode !== 'ptt');

	updateMuteButtonUI();
	updateCallStatus();
	updateReconnectDropdown();
}

// ---- Profile ----

function updateUsername(val) {
	myUsername = val.trim() || ('Rider-' + Math.floor(1000 + Math.random() * 9000));
	localStorage.setItem('offcom_username', myUsername);
	const display = document.getElementById('myIdDisplay');
	if (display) display.textContent = `${myUsername} (${myDeviceId})`;
	log('[Profile] Username updated to:', myUsername);
}

// ---- Peer badge UI ----

function updatePeerBadge(peerId, state) {
	const badge = document.getElementById('peer_badge_' + peerId);
	if (!badge) return;
	badge.classList.remove('connected', 'disconnected', 'reconnecting');

	let statusText = '';
	switch (state) {
		case 'connected':    badge.classList.add('connected');    statusText = '● Connected';       break;
		case 'reconnecting': badge.classList.add('reconnecting'); statusText = '↻ Reconnecting...'; break;
		case 'disconnected':
		case 'failed':       badge.classList.add('disconnected'); statusText = '✕ Disconnected';    break;
		default:                                                   statusText = '◌ Connecting...';   break;
	}
	const statusEl = badge.querySelector('.peer-status');
	if (statusEl) statusEl.textContent = statusText;
}

function removePeerFromUI(peerId) {
	document.getElementById('peer_badge_' + peerId)?.remove();
	updateReconnectDropdown();
}

function updateReconnectDropdown() {
	const sel = document.getElementById('reconnectDropdown');
	if (!sel) return;
	const currentVal = sel.value;
	sel.innerHTML = '<option value="">Select peer...</option>';
	for (const pid of Object.keys(peers)) {
		const label = peers[pid].role === 'host' ? `${peers[pid].name} (Host)` : peers[pid].name;
		sel.add(new Option(label, pid));
	}
	if (peers[currentVal]) sel.value = currentVal;
}

function updateCallStatus() {
	const connectedCount = Object.values(peers).filter(p => p.pc?.connectionState === 'connected').length;
	const el = document.getElementById('connState');
	if (!el) return;
	if (connectedCount > 0) {
		el.textContent   = `Audio active — ${connectedCount} peer(s)`;
		el.style.color   = 'var(--accent)';
	} else {
		el.textContent   = 'Waiting for connection...';
		el.style.color   = 'var(--text-dim)';
	}
}

function updateHostUI() {
	if (isHost && document.getElementById('screenHost')?.classList.contains('active')) {
		const count = Object.keys(peers).length;
		if (count > 0) {
			const cd = document.getElementById('peerCountDisplay');
			const sb = document.getElementById('startCallBtn');
			if (cd) cd.textContent    = `${count} peer(s) detected`;
			if (sb) sb.style.display  = '';
		}
	}
}

function manualReconnect() {
	const sel    = document.getElementById('reconnectDropdown');
	const peerId = sel?.value;
	if (!peerId) return showToast('Select a peer', true);
	handlePeerReconnection(peerId, true);
}

// ---- QR popup (in-call) ----

function toggleQrPopup() {
	const popup = document.getElementById('qrPopupCard');
	if (!popup) return;
	if (popup.classList.contains('hidden')) {
		if (savedRoomQrData && currentRoomId) {
			generateQRCode('callQrContainer', savedRoomQrData);
			const rc = document.getElementById('callRoomCode');
			if (rc) rc.textContent = currentRoomId;
		}
		popup.classList.remove('hidden');
	} else {
		popup.classList.add('hidden');
	}
}

function generateQRCode(containerId, data) {
	const container = document.getElementById(containerId);
	if (!container || typeof qrcode === 'undefined') return;
	container.innerHTML = '';
	try {
		const qr = qrcode(0, 'L');
		qr.addData(data);
		qr.make();
		const mc = qr.getModuleCount(), cs = 6, m = 24, size = mc * cs + m * 2;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = size;
		canvas.style.maxWidth = '100%';
		canvas.style.height   = 'auto';
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = '#0a0a0f';
		for (let r = 0; r < mc; r++) {
			for (let c = 0; c < mc; c++) {
				if (qr.isDark(r, c)) ctx.fillRect(m + c * cs, m + r * cs, cs, cs);
			}
		}
		container.appendChild(canvas);
	} catch(err) { logError('[QR] Generation failed:', err); }
}

// ---- Lazy overlay loader ----
// Overlays/modals live in HTML/ partials and are injected into #overlayContainer on first use.

const _overlayLoaded = {};

async function loadOverlay(filename) {
	if (_overlayLoaded[filename]) return;
	try {
		const res  = await fetch(`HTML/${filename}`);
		if (!res.ok) throw new Error(`${filename} not found`);
		const html = await res.text();
		document.getElementById('overlayContainer').insertAdjacentHTML('beforeend', html);
		_overlayLoaded[filename] = true;
		log('[UI] Overlay loaded:', filename);
	} catch(e) {
		logError('[UI] Failed to load overlay:', filename, e);
		showToast('Error loading UI component', true);
		throw e;
	}
}

// ---- QR scanner ----

let scannerStream  = null;
let scanInterval   = null;

async function openScanner() {
	await loadOverlay('overlay-scanner.html');
	document.getElementById('scannerOverlay').classList.remove('hidden');
	document.getElementById('scannerStatus').textContent = 'Starting camera...';
	startScanner();
}

async function startScanner() {
	try {
		const video  = document.getElementById('scannerVideo');
		const canvas = document.getElementById('scannerCanvas');
		const ctx    = canvas.getContext('2d', { willReadFrequently: true });

		scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
		video.srcObject = scannerStream;
		await video.play();

		canvas.width  = video.videoWidth  || 640;
		canvas.height = video.videoHeight || 480;
		document.getElementById('scannerStatus').textContent = 'Scanning...';

		scanInterval = setInterval(() => {
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			if (typeof jsQR === 'undefined') return;
			const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
			if (code) handleScannedQR(code.data);
		}, 100);
	} catch(err) {
		document.getElementById('scannerStatus').textContent = 'Camera error: ' + (err.message || err);
	}
}

function handleScannedQR(data) {
	if (!data.startsWith('OFFCOM:ROOM:')) {
		document.getElementById('scannerStatus').textContent = 'Invalid QR format';
		return;
	}
	const parts = data.slice('OFFCOM:ROOM:'.length).split('::');
	if (parts.length !== 2) {
		document.getElementById('scannerStatus').textContent = 'Invalid QR format';
		return;
	}
	closeScanner();
	joinRoom(parts[0], parts[1]);
}

function closeScanner() {
	if (scanInterval)   { clearInterval(scanInterval);  scanInterval  = null; }
	if (scannerStream)  { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
	const overlay = document.getElementById('scannerOverlay');
	if (overlay) {
		overlay.classList.add('closing');
		setTimeout(() => { overlay.classList.add('hidden'); overlay.classList.remove('closing'); }, 200);
	}
}

// ---- Settings screen ----

async function loadSettingsScreen() {
	if (settingsScreenLoaded) return;
	try {
		const response = await fetch('HTML/screen-settings.html');
		const html     = await response.text();
		document.getElementById('dynamicScreenContainer').innerHTML = html;
		settingsScreenLoaded = true;
		log('[UI] Settings screen loaded dynamically');
	} catch(e) {
		logError('[UI] Failed to load settings screen:', e);
		showToast('Failed to load settings', true);
	}
}

async function openSettings() {
	// Guard: don't re-open if already in settings (gear icon is always visible in header)
	if (document.getElementById('dynamicScreenContainer').classList.contains('active')) return;
	await loadSettingsScreen();
	// Capture the currently active real screen (never dynamicScreenContainer itself)
	const active = document.querySelector('.screen.active:not(#dynamicScreenContainer)');
	window.previousScreen = active ? active.id : 'screenRole';
	document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
	document.getElementById('dynamicScreenContainer').classList.add('active');
	populateSettingsValues();
	populateDeviceLists();
}

async function goBackFromSettings() {
	document.getElementById('dynamicScreenContainer').classList.remove('active');
	await showScreen(window.previousScreen || 'screenRole');
}

function populateSettingsValues() {
	const userInp = document.getElementById('settingsUsernameInput');
	if (userInp) userInp.value = myUsername;

	const debugTog = document.getElementById('settingsDebugToggle');
	if (debugTog) debugTog.checked = DEBUG;

	// --- NEW: Add the file logging toggle state ---
	const logFileTog = document.getElementById('settingsLogFileToggle');
	if (logFileTog) logFileTog.checked = isFileLoggingEnabled;
	
	const dlLogsBtn = document.getElementById('downloadLogsBtn');
	if (dlLogsBtn) dlLogsBtn.style.display = isFileLoggingEnabled ? 'block' : 'none';
	// ----------------------------------------------

	const micGain     = micGainNode     ? micGainNode.gain.value     : parseFloat(localStorage.getItem('offcom_mic_gain')     || '1');
	const speakerGain = speakerGainNode ? speakerGainNode.gain.value : parseFloat(localStorage.getItem('offcom_speaker_gain') || '1');

	const micSlider = document.getElementById('settingsMicGain');
	const spkSlider = document.getElementById('settingsSpeakerGain');
	if (micSlider) {
		micSlider.value = micGain;
		const v = document.getElementById('settingsMicGainValue');
		if (v) v.textContent = micGain.toFixed(1) + 'x';
	}
	if (spkSlider) {
		spkSlider.value = speakerGain;
		const v = document.getElementById('settingsSpeakerGainValue');
		if (v) v.textContent = speakerGain.toFixed(1) + 'x';
	}
}

// ---- Chat System ----
const CHAT_MAX_LEN = 300;

function sendChatMessage() {
	const inp = document.getElementById('chatInput');
	const text = inp.value.trim().slice(0, CHAT_MAX_LEN);
	if (!text) return;
	if (!currentRoomId) return showToast('Not in a room', true);
	inp.value = '';
	
	appendChatMessage(myUsername, text, true); // Render locally
	wsSend({ type: 'chat', room: currentRoomId, name: myUsername, text: text }); // Send to server
}

function appendChatMessage(name, text, isSelf) {
	const container = document.getElementById('chatMessages');
	if (!container) return;
	const msgDiv = document.createElement('div');
	msgDiv.className = isSelf ? 'chat-msg self' : 'chat-msg';
	const now = new Date();
	const ts  = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const safeText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	msgDiv.innerHTML = `<div class="chat-name">${name} <span class="chat-ts">${ts}</span></div><div class="chat-text">${safeText}</div>`;
	container.appendChild(msgDiv);
	container.scrollTop = container.scrollHeight;
}

// ---- Peer Profile Modal (Kick & Mute) ----
let currentSelectedPeerId = null;

function addPeerToUI(peerObj) {
	if (peerObj.id === myDeviceId) return;
	const list = document.getElementById('peersList');
	if (!list || document.getElementById('peer_badge_' + peerObj.id)) return;

	const label = peerObj.role === 'host' ? `${peerObj.name} (Host)` : peerObj.name;
	const badge = document.createElement('div');
	badge.className = 'peer-badge remote';
	badge.id        = 'peer_badge_' + peerObj.id;
	badge.innerHTML = `<span class="peer-name">${label}</span><span class="peer-status">◌ Connecting...</span>`;
	badge.style.cursor = 'pointer'; // Make it clickable
	badge.onclick = () => openPeerModal(peerObj.id);
	list.appendChild(badge);

	updateReconnectDropdown();
}

async function openPeerModal(peerId) {
	await loadOverlay('modal-peer.html');
	const p = peers[peerId];
	if (!p) return;
	currentSelectedPeerId = peerId;
	
	document.getElementById('peerModalName').textContent = p.name;

	// --- Local mute button (everyone can use) ---
	const localMuteBtn = document.getElementById('peerModalLocalMuteBtn');
	localMuteBtn.textContent = p.locallyMuted ? '🔊 Unmute Locally' : '🔇 Mute Locally';

	// --- Room mute button (host only) ---
	const roomMuteBtn = document.getElementById('peerModalRoomMuteBtn');
	if (isHost) {
		roomMuteBtn.style.display = '';
		roomMuteBtn.textContent = p.globallyMuted ? '🎙️ Unmute for Room' : '🔕 Mute for Room';
		roomMuteBtn.className = p.globallyMuted ? 'btn btn-secondary' : 'btn btn-warning';
	} else {
		roomMuteBtn.style.display = 'none';
	}

	// --- Kick button (host only) ---
	document.getElementById('peerModalKickBtn').style.display = isHost ? '' : 'none';

	const overlay = document.getElementById('peerModalOverlay');
	overlay.classList.remove('hidden');
	overlay.onclick = (e) => { if (e.target === overlay) closePeerModal(); };
}

function closePeerModal() {
	document.getElementById('peerModalOverlay').classList.add('hidden');
	currentSelectedPeerId = null;
}

function togglePeerMute() {
	if (!currentSelectedPeerId) return;
	const p = peers[currentSelectedPeerId];
	if (!p) return;

	p.locallyMuted = !p.locallyMuted;
	if (p.audioEl) p.audioEl.muted = p.locallyMuted;

	const badge = document.getElementById('peer_badge_' + currentSelectedPeerId);
	if (badge) {
		badge.querySelector('.mute-icon-local')?.remove();
		if (p.locallyMuted) {
			badge.classList.add('muted');
			const nameEl = badge.querySelector('.peer-name');
			if (nameEl) {
				const icon = document.createElement('span');
				icon.className = 'mute-icon-local';
				icon.textContent = ' 🔇';
				icon.title = 'Muted locally';
				nameEl.appendChild(icon);
			}
		} else {
			badge.classList.remove('muted');
		}
	}

	showToast(p.locallyMuted ? `${p.name} muted on your device` : `${p.name} unmuted`, false);
	closePeerModal();
}

function muteForRoom() {
	if (!currentSelectedPeerId || !isHost) return;
	const p = peers[currentSelectedPeerId];
	if (!p) return;

	p.globallyMuted = !p.globallyMuted;
	const msgType = p.globallyMuted ? 'mute' : 'unmute';
	postMessage(currentSelectedPeerId, msgType, {});

	// Update the host-side badge to reflect global mute state
	const badge = document.getElementById('peer_badge_' + currentSelectedPeerId);
	if (badge) {
		badge.querySelector('.mute-icon-global')?.remove();
		if (p.globallyMuted) {
			badge.classList.add('globally-muted');
			const nameEl = badge.querySelector('.peer-name');
			if (nameEl) {
				const icon = document.createElement('span');
				icon.className = 'mute-icon-global';
				icon.textContent = ' 🔕';
				icon.title = 'Muted for room';
				nameEl.appendChild(icon);
			}
		} else {
			badge.classList.remove('globally-muted');
		}
	}

	showToast(p.globallyMuted ? `${p.name} muted for the room` : `${p.name} unmuted for the room`, false);
	closePeerModal();
}

function kickPeer() {
	if (!currentSelectedPeerId || !isHost) return;
	postMessage(currentSelectedPeerId, 'kick', {});
	showToast(`Kicked ${peers[currentSelectedPeerId]?.name}`, false);
	closePeerModal();
}

// ---- File Logging ----
function toggleFileLogging(enabled) {
	isFileLoggingEnabled = enabled;
	localStorage.setItem('offcom_file_logging', enabled);
	document.getElementById('downloadLogsBtn').style.display = enabled ? 'block' : 'none';
	showToast(enabled ? 'File logging enabled' : 'File logging disabled', false);
}

function downloadLogs() {
	if (fileLogs.length === 0) return showToast('No logs to download', true);
	const blob = new Blob([fileLogs.join('\n')], { type: 'text/plain' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `offcom-logs-${new Date().toISOString().split('T')[0]}.txt`;
	a.click();
	URL.revokeObjectURL(url);
}