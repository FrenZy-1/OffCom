// ============================================
// state.js — Global state & logging
// ============================================

let DEBUG = localStorage.getItem('offcom_debug') === 'true';
let isFileLoggingEnabled = localStorage.getItem('offcom_file_logging') === 'true';
let fileLogs =[];

function _logSerialize(args) {
	return args.map(a => {
		if (a === null)            return 'null';
		if (typeof a === 'object') return JSON.stringify(a);
		return String(a);
	}).join(' ');
}

function log(...args) { 
	if (DEBUG) console.log('[OffCom]', ...args); 
	if (isFileLoggingEnabled) fileLogs.push(new Date().toISOString() + ' [INFO] ' + _logSerialize(args));
}
function logError(...args) { 
	if (DEBUG) console.error('[OffCom ERROR]', ...args); 
	if (isFileLoggingEnabled) fileLogs.push(new Date().toISOString() + ' [ERR] ' + _logSerialize(args));
}
function logWebRTC(peerId, msg) { 
	if (DEBUG) console.log(`[WebRTC - ${peerId}]`, msg); 
	if (isFileLoggingEnabled) fileLogs.push(new Date().toISOString() + ` [WebRTC ${peerId}] ` + msg);
}


// ---- Audio pipeline ----
let localStream     = null;
let audioContext    = null;
let micGainNode     = null;
let speakerGainNode = null;
let localSource     = null;
let analyserNode    = null;

// ---- Session ----
let isHost                = false;
let currentRoomId         = null;
let signalingUrl          = window.location.origin;
let wakeLock              = null;
let savedRoomQrData       = null;
let intentionalDisconnect = false;

// ---- ICE candidate buffer (keyed by peerId) ----
let iceCandidateBuffer = {};

// ---- Identity (persisted across sessions) ----
function generateRandomId(len) {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

let myDeviceId = localStorage.getItem('offcom_device_id');
if (!myDeviceId) {
	myDeviceId = generateRandomId(6); // Device ID stays short
	localStorage.setItem('offcom_device_id', myDeviceId);
}

let myUsername = localStorage.getItem('offcom_username');
if (!myUsername) {
	myUsername = 'Rider-' + Math.floor(1000 + Math.random() * 9000);
	localStorage.setItem('offcom_username', myUsername);
}

// ---- Multi-peer state ----
const peers = {};   // peerId → { pc, name, role, ver, reconnectAttempts, iceRestartTimer, audioEl }

// ---- VOX / PTT / Mute ----
let transmitMode     = 'open';
let voxSensitivity   = 80;
let voxThreshold     = 0.11;
let voxHoldMs        = 600;
let voxHoldTimer     = null;
let voxActive        = false;
let isPttActive      = false;
let voxCheckInterval = null;
let isLocalMuted     = false;

// ---- PTT Latch ----
let pttLatchEnabled  = false;
let pttLatchedActive = false;

// ---- Sound Customization ----
const SOUND_KEYS = ['join', 'leave', 'peerJoin', 'peerLeave', 'pttOn', 'pttOff'];
let customSounds = {};

// ---- WebSocket signaling state ----
let ws            = null;
let wsReady       = false;
let wsPingTimer   = null;
let wsReconnTimer = null;
const WS_PING_MS  = 10000;

// ---- Settings ----
let settingsScreenLoaded = false;

// ---- Host-vanished grace period ----
// Don't hard-disconnect on the first missing-host roster push.
// Network blips on Android hotspot cause brief host WS drops.
let hostVanishedTimer = null;
const HOST_VANISHED_GRACE_MS = 8000;
