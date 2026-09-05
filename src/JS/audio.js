// ============================================
// audio.js — Audio pipeline, transmit modes, device selection
// ============================================

// ---- AudioContext setup ----

function initAudioContext() {
	if (audioContext && audioContext.state !== 'closed') return audioContext;
	log('[Audio] Initializing AudioContext');
	audioContext    = new (window.AudioContext || window.webkitAudioContext)();
	micGainNode     = audioContext.createGain();
	speakerGainNode = audioContext.createGain();
	analyserNode    = audioContext.createAnalyser();
	analyserNode.fftSize = 256;

	micGainNode.gain.value     = parseFloat(localStorage.getItem('offcom_mic_gain')     || '1');
	speakerGainNode.gain.value = parseFloat(localStorage.getItem('offcom_speaker_gain') || '1');
	return audioContext;
}

function processLocalStream(stream) {
	initAudioContext();
	if (audioContext.state === 'suspended') audioContext.resume();
	if (localSource) { try { localSource.disconnect(); } catch(e) {} }

	const destination = audioContext.createMediaStreamDestination();
	localSource = audioContext.createMediaStreamSource(stream);
	localSource.connect(analyserNode);
	analyserNode.connect(micGainNode);
	micGainNode.connect(destination);

	applyTransmitMode();
	return destination.stream;
}

function attachRemoteStream(peerId, stream) {
	initAudioContext();
	if (audioContext.state === 'suspended') audioContext.resume();

	let audioEl = document.getElementById('remoteAudio_' + peerId);
	if (!audioEl) {
		log(`[Audio] Creating <audio> element for ${peerId}`);
		audioEl = document.createElement('audio');
		audioEl.id = 'remoteAudio_' + peerId;
		audioEl.autoplay = true;
		audioEl.setAttribute('playsinline', '');
		document.body.appendChild(audioEl);
	}

	audioEl.srcObject = stream;
	// el.volume is clamped to [0,1]; amplification above 1x is via the gain node
	audioEl.volume = Math.min(1, Math.max(0, speakerGainNode.gain.value));
	audioEl.play().catch(e => logError('[Audio] Remote play failed:', e));

	const savedSpkr = localStorage.getItem('offcom_speaker_device_id') || '';
	if (savedSpkr && typeof audioEl.setSinkId === 'function') {
		audioEl.setSinkId(savedSpkr).catch(() => {});
	}

	if (peers[peerId]) peers[peerId].audioEl = audioEl;
}

// ---- Gain controls ----

function updateMicGain(val) {
	const v = parseFloat(val);
	const display = document.getElementById('micGainValue');
	if (display) display.textContent = v.toFixed(1) + 'x';
	const settingsDisplay = document.getElementById('settingsMicGainValue');
	if (settingsDisplay) settingsDisplay.textContent = v.toFixed(1) + 'x';
	if (micGainNode) micGainNode.gain.value = v;
	localStorage.setItem('offcom_mic_gain', val);
}

function updateSpeakerGain(val) {
	const v = parseFloat(val);
	const display = document.getElementById('speakerGainValue');
	if (display) display.textContent = v.toFixed(1) + 'x';
	const settingsDisplay = document.getElementById('settingsSpeakerGainValue');
	if (settingsDisplay) settingsDisplay.textContent = v.toFixed(1) + 'x';
	if (speakerGainNode) speakerGainNode.gain.value = v;
	// HTMLMediaElement.volume only accepts [0, 1] — gain node handles the rest
	const clamped = Math.min(1, Math.max(0, v));
	document.querySelectorAll('audio[id^="remoteAudio"]').forEach(el => el.volume = clamped);
	localStorage.setItem('offcom_speaker_gain', val);
}

// ---- Mute ----

function toggleLocalMute() {
	if (transmitMode === 'ptt') return;
	isLocalMuted = !isLocalMuted;
	if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isLocalMuted);
	log(`[Audio] Mic manually ${isLocalMuted ? 'MUTED' : 'UNMUTED'}`);
	updateMuteButtonUI();
}

function updateMuteButtonUI() {
	const btn = document.getElementById('muteToggleBtn');
	if (!btn) return;
	btn.classList.remove('btn-primary');
	btn.classList.add('btn-secondary');

	if (transmitMode === 'ptt') {
		btn.disabled        = true;
		btn.style.opacity   = '0.4';
		btn.style.color     = '';
		btn.style.background = '';
		btn.innerHTML       = 'Mic: PTT';
	} else {
		btn.disabled        = false;
		btn.style.opacity   = '1';
		btn.style.background = '';
		btn.style.color     = isLocalMuted ? 'var(--red)' : 'var(--accent)';
		btn.innerHTML       = isLocalMuted ? 'Mic: MUTED' : 'Mic: ON';
	}
}

// ---- Transmit mode ----

function setTransmitMode(mode) {
	log('[Transmit] Setting mode to:', mode);
	transmitMode = mode;
	localStorage.setItem('offcom_transmit_mode', mode);

	document.querySelectorAll('.transmit-btn').forEach(b => b.classList.remove('active'));
	document.getElementById('transmit-' + mode)?.classList.add('active');

	const voxSet = document.getElementById('voxSettings');
	const pttSet = document.getElementById('pttContainer');
	if (voxSet) voxSet.classList.toggle('hidden', mode !== 'vox');
	if (pttSet) pttSet.classList.toggle('hidden', mode !== 'ptt');

	if (voxCheckInterval) { clearInterval(voxCheckInterval); voxCheckInterval = null; }
	if (voxHoldTimer)     { clearTimeout(voxHoldTimer);     voxHoldTimer = null; }
	voxActive        = false;
	pttLatchedActive = false;

	if (mode !== 'ptt') {
		pttLatchEnabled = false;
		const latchBtn = document.getElementById('pttLatchBtn');
		if (latchBtn) {
			latchBtn.textContent = 'Latch: OFF';
			latchBtn.className   = 'btn btn-secondary';
		}
	}

	const savedGain = parseFloat(localStorage.getItem('offcom_mic_gain') || '1');
	switch (mode) {
		case 'open': if (micGainNode) micGainNode.gain.value = savedGain; break;
		case 'vox':  if (micGainNode) micGainNode.gain.value = 0; startVOXMonitoring(); break;
		case 'ptt':
			if (micGainNode) micGainNode.gain.value = 0;
			document.getElementById('pttButton')?.classList.remove('ptt-active');
			break;
	}

	updateMuteButtonUI();
}

function applyTransmitMode() {
	setTransmitMode(localStorage.getItem('offcom_transmit_mode') || 'open');
}

// ---- VOX ----

function startVOXMonitoring() {
	if (!analyserNode) return;
	voxCheckInterval = setInterval(() => {
		const data = new Uint8Array(analyserNode.frequencyBinCount);
		analyserNode.getByteFrequencyData(data);
		let sum = 0;
		for (let i = 0; i < data.length; i++) sum += data[i];
		const level = sum / data.length / 255;

		const meter  = document.getElementById('volumeMeter');
		const marker = document.getElementById('voxThresholdMarker');
		if (meter)  meter.style.width  = (level * 100) + '%';
		if (marker) marker.style.left  = (voxThreshold * 100) + '%';

		if (level > voxThreshold) {
			if (!voxActive) {
				voxActive = true;
				if (micGainNode) micGainNode.gain.value = parseFloat(localStorage.getItem('offcom_mic_gain') || '1');
			}
			if (voxHoldTimer) { clearTimeout(voxHoldTimer); voxHoldTimer = null; }
		} else if (voxActive) {
			if (!voxHoldTimer) {
				voxHoldTimer = setTimeout(() => {
					voxActive    = false;
					voxHoldTimer = null;
					if (micGainNode) micGainNode.gain.value = 0;
				}, voxHoldMs);
			}
		}
	}, 30);
}

function updateVoxThreshold(v) {
	voxSensitivity = parseInt(v);
	voxThreshold   = 0.51 - (voxSensitivity * 0.005);
	localStorage.setItem('offcom_vox_sensitivity', voxSensitivity);
	const el = document.getElementById('voxThresholdValue');
	if (el) el.textContent = voxSensitivity + '%';
}

function updateVoxHold(ms) {
	voxHoldMs = parseInt(ms);
	localStorage.setItem('offcom_vox_hold_ms', voxHoldMs);
	const el = document.getElementById('voxHoldValue');
	if (el) el.textContent = (voxHoldMs / 1000).toFixed(1) + 's';
}

function loadVoxSettings() {
	voxSensitivity = parseInt(localStorage.getItem('offcom_vox_sensitivity') || '80');
	voxThreshold   = 0.51 - (voxSensitivity * 0.005);
	voxHoldMs      = parseInt(localStorage.getItem('offcom_vox_hold_ms') || '600');

	const s  = document.getElementById('voxThreshold');
	const hs = document.getElementById('voxHoldTime');
	if (s)  s.value  = voxSensitivity;
	if (hs) hs.value = voxHoldMs;

	const tv = document.getElementById('voxThresholdValue');
	const hv = document.getElementById('voxHoldValue');
	if (tv) tv.textContent = voxSensitivity + '%';
	if (hv) hv.textContent = (voxHoldMs / 1000).toFixed(1) + 's';
}

// ---- PTT ----

function pttStart(e) {
	if (e) e.preventDefault();
	if (transmitMode !== 'ptt') return;

	if (pttLatchEnabled) {
		pttLatchedActive = !pttLatchedActive;
		if (pttLatchedActive) {
			if (micGainNode) micGainNode.gain.value = parseFloat(localStorage.getItem('offcom_mic_gain') || '1');
			document.getElementById('pttButton')?.classList.add('ptt-active');
			playSound('pttOn');
		} else {
			if (micGainNode) micGainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
			document.getElementById('pttButton')?.classList.remove('ptt-active');
			playSound('pttOff');
		}
	} else {
		if (isPttActive) return;
		isPttActive = true;
		if (micGainNode) micGainNode.gain.value = parseFloat(localStorage.getItem('offcom_mic_gain') || '1');
		document.getElementById('pttButton')?.classList.add('ptt-active');
		playSound('pttOn');
	}
}

function pttStop(e) {
	if (e) e.preventDefault();
	if (transmitMode !== 'ptt' || pttLatchEnabled || !isPttActive) return;
	isPttActive = false;
	if (micGainNode) micGainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
	document.getElementById('pttButton')?.classList.remove('ptt-active');
	playSound('pttOff');
}

function togglePttLatchButton() {
	pttLatchEnabled = !pttLatchEnabled;
	const btn = document.getElementById('pttLatchBtn');
	if (btn) {
		btn.textContent = pttLatchEnabled ? 'Latch: ON' : 'Latch: OFF';
		btn.className   = pttLatchEnabled ? 'btn btn-primary' : 'btn btn-secondary';
	}
	log(`[PTT] Latch mode ${pttLatchEnabled ? 'ON' : 'OFF'}`);

	if (!pttLatchEnabled && pttLatchedActive) {
		pttLatchedActive = false;
		if (micGainNode) micGainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
		document.getElementById('pttButton')?.classList.remove('ptt-active');
		playSound('pttOff');
	}
}

// ---- Device selection ----

async function populateDeviceLists() {
	try {
		if (!localStream || !localStream.active) {
			try {
				const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
				tmp.getTracks().forEach(t => t.stop());
			} catch(e) {}
		}
		const devices      = await navigator.mediaDevices.enumerateDevices();
		const audioInputs  = [...new Map(devices.filter(d => d.kind === 'audioinput').map(d => [d.deviceId, d])).values()];
		const audioOutputs = [...new Map(devices.filter(d => d.kind === 'audiooutput').map(d => [d.deviceId, d])).values()];

		const savedMicId      = localStorage.getItem('offcom_mic_device_id')     || '';
		const savedSpeakerId  = localStorage.getItem('offcom_speaker_device_id') || '';

		const micSel = document.getElementById('settingsAudioDeviceSelect') || document.getElementById('audioDeviceSelect');
		if (micSel) {
			micSel.innerHTML = '';
			const defOpt = new Option('Default', '');
			if (!savedMicId) defOpt.selected = true;
			micSel.add(defOpt);
			audioInputs.forEach((d, i) => {
				const opt = new Option(d.label || ('Mic ' + (i + 1)), d.deviceId);
				if (d.deviceId === savedMicId) opt.selected = true;
				micSel.add(opt);
			});
		}

		const rAudio = document.querySelector('audio[id^="remoteAudio"]') || document.createElement('audio');
		const sRow   = document.getElementById('settingsSpeakerSelectRow');
		const sWarn  = document.getElementById('settingsSpeakerWarning');
		const sSel   = document.getElementById('settingsSpeakerSelect');

		if (('setSinkId' in rAudio) && audioOutputs.length > 0) {
			if (sRow)  sRow.style.display  = '';
			if (sWarn) sWarn.style.display = 'none';
			if (sSel) {
				sSel.innerHTML = '';
				const defOpt = new Option('Default', '');
				if (!savedSpeakerId) defOpt.selected = true;
				sSel.add(defOpt);
				audioOutputs.forEach((d, i) => {
					const opt = new Option(d.label || ('Speaker ' + (i + 1)), d.deviceId);
					if (d.deviceId === savedSpeakerId) opt.selected = true;
					sSel.add(opt);
				});
			}
		} else {
			if (sRow)  sRow.style.display  = 'none';
			if (sWarn) sWarn.style.display = audioOutputs.length > 0 ? 'none' : 'block';
		}
	} catch (e) { logError('[Device]', e); }
}

async function applyAudioDevice() {
	const sel = document.getElementById('settingsAudioDeviceSelect') || document.getElementById('audioDeviceSelect');
	if (!sel) return;
	localStorage.setItem('offcom_mic_device_id', sel.value);

	const activePeers = Object.values(peers).filter(p => p.pc?.connectionState === 'connected');
	if (activePeers.length === 0) return showToast('Device saved', false);

	showToast('Applying microphone...', false);
	try {
		if (localStream) localStream.getTracks().forEach(t => t.stop());
		const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 };
		if (sel.value) constraints.deviceId = { exact: sel.value };
		localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
		const audioTrack = processLocalStream(localStream).getAudioTracks()[0];

		for (const p of activePeers) {
			const sender = p.pc.getSenders().find(s => s.track?.kind === 'audio');
			if (sender) await sender.replaceTrack(audioTrack);
		}
		if (isLocalMuted && transmitMode !== 'ptt') {
			localStream.getAudioTracks().forEach(t => t.enabled = false);
		}
		showToast('Mic applied', false);
	} catch (e) { showToast('Error: ' + e.message, true); }
}

async function applySpeakerDevice() {
	const sel = document.getElementById('settingsSpeakerSelect');
	if (!sel) return;
	localStorage.setItem('offcom_speaker_device_id', sel.value);
	document.querySelectorAll('audio[id^="remoteAudio"]').forEach(async el => {
		if (sel.value && typeof el.setSinkId === 'function') {
			try { await el.setSinkId(sel.value); } catch(e) {}
		}
	});
	showToast('Speaker changed', false);
}

// ---- Sound system ----

function loadCustomSounds() {
	SOUND_KEYS.forEach(key => {
		customSounds[key] = localStorage.getItem(`offcom_sound_${key}`) || null;
	});
}

function handleSoundUpload(type, file) {
	if (!file) return;
	const reader = new FileReader();
	reader.onload = (e) => {
		const dataURL = e.target.result;
		localStorage.setItem(`offcom_sound_${type}`, dataURL);
		customSounds[type] = dataURL;
		showToast(`${type} sound saved`, false);
	};
	reader.readAsDataURL(file);
}

function resetSound(type) {
	localStorage.removeItem(`offcom_sound_${type}`);
	customSounds[type] = null;
	const input = document.getElementById(`sound${type.charAt(0).toUpperCase() + type.slice(1)}Input`);
	if (input) input.value = '';
	showToast(`${type} sound reset`, false);
}

function previewSound(type) { playSound(type); }

function playSound(type) {
	const custom = customSounds[type];
	if (custom) {
		const audio = new Audio(custom);
		audio.volume = 0.5;
		audio.play().catch(() => {});
		return;
	}

	const soundFileMap = {
		join:      'assets/audio/join.wav',
		leave:     'assets/audio/leave.wav',
		peerJoin:  'assets/audio/peer-join.wav',
		peerLeave: 'assets/audio/peer-leave.wav',
		pttOn:     'assets/audio/ptt-on.wav',
		pttOff:    'assets/audio/ptt-off.wav',
	};

	const file = soundFileMap[type];
	if (file) {
		const audio = new Audio(file);
		audio.volume = 0.5;
		audio.play().catch(() => playBeep(type));
		return;
	}

	playBeep(type);
}

function playBeep(type) {
	const ctx  = new (window.AudioContext || window.webkitAudioContext)();
	const osc  = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.connect(gain);
	gain.connect(ctx.destination);

	const map = {
		join: [880, 0.15], leave: [440, 0.15],
		peerJoin: [660, 0.08], peerLeave: [330, 0.08],
		pttOn: [1200, 0.05], pttOff: [1000, 0.05],
	};
	const [freq, dur] = map[type] || [800, 0.1];
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.3, ctx.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
	osc.start();
	osc.stop(ctx.currentTime + dur);
	setTimeout(() => ctx.close(), dur * 1000 + 50);
}

// ---- Wake lock ----

async function requestWakeLock() {
	try {
		if ('wakeLock' in navigator) {
			wakeLock = await navigator.wakeLock.request('screen');
			wakeLock.addEventListener('release', () => { wakeLock = null; });
			log('[WakeLock] Acquired');
		}
	} catch(e) { logError('[WakeLock] Error:', e); }
}

function releaseWakeLock() {
	if (wakeLock) {
		log('[WakeLock] Released');
		wakeLock.release();
		wakeLock = null;
	}
}
