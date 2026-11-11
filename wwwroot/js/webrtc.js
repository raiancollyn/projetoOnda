/*
 * Onda WebRTC mesh.
 *
 * Architecture
 * ------------
 * Each browser gets one peer connection per other participant.
 * Every connection always has three fixed transceivers, in this order:
 *   1. microphone audio
 *   2. camera OR screen video
 *   3. screen-share audio
 *
 * Media is switched with RTCRtpSender.replaceTrack(), so joining, muting,
 * camera changes and screen sharing never require a renegotiation. Silent
 * placeholder tracks are used initially so that every receiver gets its
 * ontrack event immediately and can start receiving later replacements.
 *
 * The participant whose id is lexicographically smaller creates the offer.
 * That deterministic role avoids glare between the two browsers.
 */

const DEFAULT_SCREEN_QUALITY = Object.freeze({
    preset: "balanced",
    height: 1080,
    width: 1920,
    frameRate: 30,
    bitrateKbps: 5000,
    codec: "auto",
    contentMode: "detail"
});

const ICE_CONFIG = {
    iceServers: [
        {
            urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        },
        { urls: "stun:stun.cloudflare.com:3478" }
    ],
    bundlePolicy: "max-bundle",
    iceCandidatePoolSize: 2
};

const DEFAULT_VOLUME = 0.8;
const SPEAKING_THRESHOLD = 0.023;
const SPEAKING_HANGOVER_MS = 420;
const HEARTBEAT_MS = 20000;
const REMOTE_AUDIO_ELEMENT_CLASS = "onda-remote-audio";

let dotnetRef = null;
let roomId = "";
let selfId = "";
let initialized = false;
let heartbeatTimer = null;
let visibilityHandler = null;
let pageHideHandler = null;
let gestureHandler = null;
let micAcquirePromise = null;
let screenQuality = { ...DEFAULT_SCREEN_QUALITY };
let peerConnectionConfig = ICE_CONFIG;

const peers = new Map();
const pendingSignals = new Map();
const remoteAudio = new Map();
const volumePrefs = new Map();

let local = createLocalState();

function createLocalState() {
    return {
        audioContext: null,
        microphoneContextSource: null,
        microphoneAnalyser: null,
        speakingFrameData: null,
        speakingTimer: null,
        speaking: false,
        lastVoiceAt: 0,

        placeholderMicTrack: null,
        placeholderScreenAudioTrack: null,
        placeholderVideoTrack: null,
        placeholderCanvas: null,
        silentNodes: [],

        micStream: null,
        micTrack: null,
        micTransmitTrack: null,
        micOn: false,
        hasMic: false,

        cameraStream: null,
        cameraTrack: null,
        cameraOn: false,

        screenStream: null,
        screenVideoTrack: null,
        screenAudioTrack: null,
        screenOn: false,
        screenWithAudio: false,

        presentationStream: null,
        presentationKind: null,

        cameraBusy: false,
        screenBusy: false,
        audioBlocked: false
    };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

export function initialize(ref, room, guestId, config = {}) {
    if (initialized) {
        disposeRoom();
    }

    dotnetRef = ref;
    roomId = room || "";
    selfId = guestId || "";
    screenQuality = normalizeScreenQuality(config?.quality);
    peerConnectionConfig = buildPeerConnectionConfig(config?.iceServers);
    local = createLocalState();
    initialized = true;

    if (!roomId || !selfId) {
        notifyError("connection", "Não foi possível identificar esta sala.");
        return false;
    }

    if (!window.isSecureContext) {
        notifyError(
            "secure-context",
            "Áudio e vídeo precisam de uma conexão segura (HTTPS ou localhost). O chat continua funcionando."
        );
    }

    try {
        createPlaceholderMedia();
    } catch (error) {
        console.warn("Onda: placeholder media could not be created", error);
    }

    setupHeartbeat();
    setupPageLifecycle();
    installGestureUnlock();

    // Let the room paint before the browser permission prompt appears.
    window.setTimeout(() => {
        if (initialized) {
            void acquireMicrophone(true);
        }
    }, 180);

    return true;
}

export function disposeRoom() {
    initialized = false;
    stopHeartbeat();
    removePageLifecycle();
    removeGestureUnlock();
    stopSpeakingMonitor(false);

    for (const peerId of Array.from(peers.keys())) {
        closePeer(peerId);
    }

    for (const key of Array.from(remoteAudio.keys())) {
        removeRemoteAudio(key);
    }

    stopTrack(local.cameraTrack);
    stopTrack(local.screenVideoTrack);
    stopTrack(local.screenAudioTrack);
    stopTrack(local.micTrack);
    stopTrack(local.placeholderMicTrack);
    stopTrack(local.placeholderScreenAudioTrack);
    stopTrack(local.placeholderVideoTrack);

    for (const node of local.silentNodes) {
        try {
            node.stop?.();
        } catch {
            // Already stopped.
        }
    }

    local.cameraStream = null;
    local.screenStream = null;
    local.presentationStream = null;
    local.presentationKind = null;

    if (local.audioContext) {
        try {
            local.audioContext.close();
        } catch {
            // Already closed.
        }
    }

    local = createLocalState();
    micAcquirePromise = null;
    dotnetRef = null;
    roomId = "";
    selfId = "";
}

/* ------------------------------------------------------------------ */
/* Presence                                                           */
/* ------------------------------------------------------------------ */

function setupHeartbeat() {
    stopHeartbeat();
    sendHeartbeat();
    heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_MS);

    visibilityHandler = () => {
        if (document.visibilityState === "visible" && initialized) {
            sendHeartbeat();
        }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
    }
}

function setupPageLifecycle() {
    removePageLifecycle();
    pageHideHandler = (event) => {
        if (event.persisted || !initialized) {
            return;
        }

        stopHeartbeat();
        sendLeaveBeacon();
    };
    window.addEventListener("pagehide", pageHideHandler);
}

function removePageLifecycle() {
    if (pageHideHandler) {
        window.removeEventListener("pagehide", pageHideHandler);
        pageHideHandler = null;
    }
}

function sendHeartbeat() {
    if (!initialized || !roomId || !selfId) {
        return;
    }

    fetch("/api/presence/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, guestId: selfId }),
        cache: "no-store",
        keepalive: true
    }).catch(() => {
        // Presence recovers on the next heartbeat.
    });
}

function sendLeaveBeacon() {
    if (!roomId || !selfId) {
        return;
    }

    try {
        const body = new Blob(
            [JSON.stringify({ roomId, guestId: selfId })],
            { type: "application/json" }
        );
        navigator.sendBeacon("/api/presence/leave", body);
    } catch {
        // The connection teardown and stale-presence cleanup are the fallback.
    }
}

/* ------------------------------------------------------------------ */
/* Placeholder media and audio context                                */
/* ------------------------------------------------------------------ */

function getAudioContext() {
    if (!local.audioContext || local.audioContext.state === "closed") {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            throw new Error("Web Audio API indisponível");
        }

        local.audioContext = new AudioContextCtor();
    }

    return local.audioContext;
}

function createPlaceholderMedia() {
    try {
        local.placeholderMicTrack = createSilentAudioTrack("mic_placeholder");
        local.placeholderScreenAudioTrack = createSilentAudioTrack("screen_placeholder");
        local.micTransmitTrack = local.placeholderMicTrack;
    } catch (error) {
        console.warn("Onda: silent microphone tracks unavailable", error);
    }

    try {
        local.placeholderVideoTrack = createPlaceholderVideoTrack();
    } catch (error) {
        console.warn("Onda: placeholder video track unavailable", error);
    }
}

function createSilentAudioTrack(name) {
    const context = getAudioContext();
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    const oscillator = context.createOscillator();

    gain.gain.value = 0;
    oscillator.frequency.value = 220;
    oscillator.type = "sine";
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    const track = destination.stream.getAudioTracks()[0];
    if (track) {
        track.contentHint = "speech";
    }

    local.silentNodes.push(oscillator);

    return track || null;
}

function createPlaceholderVideoTrack() {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    if (context) {
        context.fillStyle = "#07110e";
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (typeof canvas.captureStream !== "function") {
        return null;
    }

    const stream = canvas.captureStream(1);
    const track = stream.getVideoTracks()[0] || null;
    if (track) {
        track.contentHint = "motion";
    }

    local.placeholderCanvas = canvas;
    return track;
}

function resumeAudioContexts() {
    if (local.audioContext && local.audioContext.state === "suspended") {
        local.audioContext.resume().catch(() => {
            // Another user gesture will retry.
        });
    }
}

function installGestureUnlock() {
    removeGestureUnlock();
    gestureHandler = () => {
        resumeAudioContexts();
        void playAllRemoteAudio();
    };

    document.addEventListener("pointerdown", gestureHandler, { capture: true, passive: true });
    document.addEventListener("keydown", gestureHandler, { capture: true });
}

function removeGestureUnlock() {
    if (!gestureHandler) {
        return;
    }

    document.removeEventListener("pointerdown", gestureHandler, { capture: true });
    document.removeEventListener("keydown", gestureHandler, { capture: true });
    gestureHandler = null;
}

/* ------------------------------------------------------------------ */
/* Microphone                                                         */
/* ------------------------------------------------------------------ */

async function acquireMicrophone(enable) {
    if (!initialized) {
        return false;
    }

    if (local.micTrack && local.micTrack.readyState === "live") {
        setMicrophoneEnabled(enable, true);
        return true;
    }

    if (micAcquirePromise) {
        return micAcquirePromise;
    }

    if (!window.isSecureContext) {
        notifyMediaState();
        return false;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        notifyError(
            "microphone",
            "Seu navegador não disponibiliza acesso ao microfone nesta página."
        );
        notifyMediaState();
        return false;
    }

    micAcquirePromise = (async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            if (!initialized) {
                stream.getTracks().forEach(stopTrack);
                return false;
            }

            stopTrack(local.micTrack);
            local.micStream = stream;
            local.micTrack = stream.getAudioTracks()[0] || null;
            local.micTransmitTrack = local.micTrack || local.placeholderMicTrack;
            local.hasMic = Boolean(local.micTrack);

            if (!local.micTrack) {
                throw new Error("Nenhuma faixa de áudio foi encontrada.");
            }

            local.micTrack.addEventListener("ended", handleMicrophoneEnded, { once: true });

            for (const peer of peers.values()) {
                replaceSenderTrack(peer.micSender, local.micTransmitTrack);
            }

            setMicrophoneEnabled(enable !== false, false);
            startSpeakingMonitor();
            notifyMediaState();
            return true;
        } catch (error) {
            local.hasMic = false;
            local.micOn = false;
            stopSpeakingMonitor(true);
            notifyMediaState();
            notifyError("microphone", microphoneErrorMessage(error));
            return false;
        } finally {
            micAcquirePromise = null;
        }
    })();

    return micAcquirePromise;
}

function setMicrophoneEnabled(enabled, notify) {
    const canEnable = enabled && local.micTrack && local.micTrack.readyState === "live";
    local.micOn = Boolean(canEnable);

    if (local.micTrack) {
        local.micTrack.enabled = local.micOn;
    }

    if (local.micOn) {
        startSpeakingMonitor();
    } else {
        stopSpeakingMonitor(true);
    }

    if (notify) {
        notifyMediaState();
    }
}

function handleMicrophoneEnded() {
    if (!initialized) {
        return;
    }

    local.hasMic = false;
    setMicrophoneEnabled(false, false);
    for (const peer of peers.values()) {
        replaceSenderTrack(peer.micSender, local.placeholderMicTrack);
    }

    notifyMediaState();
    notifyError("microphone", "O microfone foi desconectado. Conecte-o novamente para falar.");
}

export async function toggleMicrophone() {
    if (!initialized) {
        return;
    }

    resumeAudioContexts();

    if (local.micOn) {
        setMicrophoneEnabled(false, true);
        return;
    }

    if (micAcquirePromise) {
        await micAcquirePromise;
        return;
    }

    if (local.micTrack && local.micTrack.readyState === "live") {
        setMicrophoneEnabled(true, true);
        return;
    }

    await acquireMicrophone(true);
}

function startSpeakingMonitor() {
    stopSpeakingMonitor(false);

    if (!local.micOn || !local.micStream || !local.micTrack) {
        return;
    }

    try {
        const context = getAudioContext();
        resumeAudioContexts();
        const source = context.createMediaStreamSource(local.micStream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.35;
        source.connect(analyser);

        local.microphoneContextSource = source;
        local.microphoneAnalyser = analyser;
        local.speakingFrameData = new Uint8Array(analyser.fftSize);
        local.lastVoiceAt = 0;

        local.speakingTimer = window.setInterval(() => {
            if (!local.micOn || !local.microphoneAnalyser) {
                return;
            }

            const data = local.speakingFrameData;
            local.microphoneAnalyser.getByteTimeDomainData(data);

            let sum = 0;
            for (let i = 0; i < data.length; i += 1) {
                const value = (data[i] - 128) / 128;
                sum += value * value;
            }

            const rms = Math.sqrt(sum / data.length);
            const now = performance.now();
            if (rms > SPEAKING_THRESHOLD) {
                local.lastVoiceAt = now;
            }

            const isSpeaking = now - local.lastVoiceAt < SPEAKING_HANGOVER_MS;
            setLocalSpeaking(isSpeaking);
        }, 110);
    } catch (error) {
        console.warn("Onda: speaking detection unavailable", error);
    }
}

function stopSpeakingMonitor(notifyServer) {
    if (local.speakingTimer) {
        window.clearInterval(local.speakingTimer);
        local.speakingTimer = null;
    }

    if (local.microphoneContextSource) {
        try {
            local.microphoneContextSource.disconnect();
        } catch {
            // Already disconnected.
        }
        local.microphoneContextSource = null;
    }

    local.microphoneAnalyser = null;
    local.speakingFrameData = null;

    if (local.speaking) {
        local.speaking = false;
        if (notifyServer) {
            notify("OnSpeakingChanged", false);
        }
    }
}

function setLocalSpeaking(value) {
    if (local.speaking === value) {
        return;
    }

    local.speaking = value;
    notify("OnSpeakingChanged", value);
}

/* ------------------------------------------------------------------ */
/* Camera and screen                                                  */
/* ------------------------------------------------------------------ */

export async function toggleCamera() {
    if (!initialized || local.cameraBusy) {
        return;
    }

    resumeAudioContexts();

    if (local.cameraOn) {
        stopCameraSession(true);
        return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        notifyError("camera", "Seu navegador não disponibiliza acesso à câmera nesta página.");
        return;
    }

    local.cameraBusy = true;
    try {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: "user"
                },
                audio: false
            });
        } catch (error) {
            notifyError("camera", cameraErrorMessage(error));
            return;
        }

        if (!initialized) {
            stream.getTracks().forEach(stopTrack);
            return;
        }

        const track = stream.getVideoTracks()[0];
        if (!track) {
            stream.getTracks().forEach(stopTrack);
            notifyError("camera", "Nenhuma câmera foi encontrada.");
            return;
        }

        // Switching to the camera stops an ongoing screen share only after
        // the camera was acquired successfully.
        if (local.screenOn) {
            stopScreenSession(false);
        }

        stopCameraSession(false);
        local.cameraStream = stream;
        local.cameraTrack = track;
        local.cameraOn = true;
        local.presentationStream = new MediaStream([track]);
        local.presentationKind = "camera";
        track.addEventListener("ended", handleCameraEnded, { once: true });

        replaceAllVideoTracks(track);
        await applyCameraQualityToPeers();
        notifyMediaState();
        syncMediaElements();
    } finally {
        local.cameraBusy = false;
    }
}

function handleCameraEnded() {
    if (initialized && local.cameraOn) {
        stopCameraSession(true);
    }
}

function stopCameraSession(notifyServer) {
    if (!local.cameraOn && !local.cameraStream) {
        return;
    }

    if (local.cameraTrack) {
        local.cameraTrack.removeEventListener("ended", handleCameraEnded);
        stopTrack(local.cameraTrack);
    }

    local.cameraStream = null;
    local.cameraTrack = null;
    local.cameraOn = false;

    if (local.presentationKind === "camera") {
        local.presentationStream = null;
        local.presentationKind = null;
    }

    replaceAllVideoTracks(local.placeholderVideoTrack);

    if (notifyServer) {
        notifyMediaState();
        syncMediaElements();
    }
}

export async function toggleScreenShare() {
    if (!initialized || local.screenBusy) {
        return;
    }

    resumeAudioContexts();

    if (local.screenOn) {
        stopScreenSession(true);
        return;
    }

    if (!window.isSecureContext ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getDisplayMedia !== "function") {
        notifyError(
            "screen",
            "Seu navegador não permite compartilhar a tela nesta página. Tente Chrome, Edge ou Firefox."
        );
        return;
    }

    local.screenBusy = true;
    try {
        let displayStream;
        const captureConstraints = {
            frameRate: {
                ideal: screenQuality.frameRate,
                max: screenQuality.frameRate
            },
            width: { ideal: screenQuality.width },
            height: { ideal: screenQuality.height }
        };

        try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: captureConstraints,
                audio: true
            });
        } catch (error) {
            // Closing the browser picker is not an application error.
            if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
                notifyError("screen", screenErrorMessage(error));
            }
            return;
        }

        if (!initialized) {
            displayStream.getTracks().forEach(stopTrack);
            return;
        }

        const videoTrack = displayStream.getVideoTracks()[0];
        if (!videoTrack) {
            displayStream.getTracks().forEach(stopTrack);
            notifyError("screen", "Nenhuma tela foi compartilhada.");
            return;
        }

        videoTrack.contentHint = screenQuality.contentMode === "motion" ? "motion" : "detail";
        const audioTrack = displayStream.getAudioTracks()[0] || null;

        // The camera is replaced only after the screen was acquired.
        if (local.cameraOn) {
            stopCameraSession(false);
        }

        local.screenStream = displayStream;
        local.screenVideoTrack = videoTrack;
        local.screenAudioTrack = audioTrack;
        local.screenOn = true;
        local.screenWithAudio = Boolean(audioTrack);
        local.presentationStream = new MediaStream([videoTrack]);
        local.presentationKind = "screen";

        videoTrack.addEventListener("ended", handleScreenEnded, { once: true });
        if (audioTrack) {
            audioTrack.addEventListener("ended", handleScreenAudioEnded, { once: true });
            audioTrack.contentHint = "music";
        }

        replaceAllVideoTracks(videoTrack);
        replaceAllScreenAudioTracks(audioTrack || local.placeholderScreenAudioTrack);
        await applyScreenQualityToPeers();
        notifyMediaState();
        syncMediaElements();
    } finally {
        local.screenBusy = false;
    }
}

function handleScreenEnded() {
    if (initialized && local.screenOn) {
        stopScreenSession(true);
    }
}

function handleScreenAudioEnded() {
    if (!initialized || !local.screenOn) {
        return;
    }

    local.screenAudioTrack = null;
    local.screenWithAudio = false;
    replaceAllScreenAudioTracks(local.placeholderScreenAudioTrack);
    notifyMediaState();
}

function stopScreenSession(notifyServer) {
    if (!local.screenOn && !local.screenStream) {
        return;
    }

    if (local.screenVideoTrack) {
        local.screenVideoTrack.removeEventListener("ended", handleScreenEnded);
        stopTrack(local.screenVideoTrack);
    }

    if (local.screenAudioTrack) {
        local.screenAudioTrack.removeEventListener("ended", handleScreenAudioEnded);
        stopTrack(local.screenAudioTrack);
    }

    if (local.screenStream) {
        local.screenStream.getTracks().forEach(stopTrack);
    }

    local.screenStream = null;
    local.screenVideoTrack = null;
    local.screenAudioTrack = null;
    local.screenOn = false;
    local.screenWithAudio = false;

    if (local.presentationKind === "screen") {
        local.presentationStream = null;
        local.presentationKind = null;
    }

    replaceAllVideoTracks(local.placeholderVideoTrack);
    replaceAllScreenAudioTracks(local.placeholderScreenAudioTrack);

    if (notifyServer) {
        notifyMediaState();
        syncMediaElements();
    }
}

function replaceAllVideoTracks(track) {
    for (const peer of peers.values()) {
        replaceSenderTrack(peer.videoSender, track);
    }
}

function replaceAllScreenAudioTracks(track) {
    for (const peer of peers.values()) {
        replaceSenderTrack(peer.screenAudioSender, track);
    }
}

async function replaceSenderTrack(sender, track) {
    if (!sender) {
        return;
    }

    try {
        await sender.replaceTrack(track || null);
    } catch (error) {
        console.warn("Onda: could not replace outgoing track", error);
    }
}

/* ------------------------------------------------------------------ */
/* Screen-share quality                                               */
/* ------------------------------------------------------------------ */

function normalizeScreenQuality(value) {
    const input = value && typeof value === "object" ? value : {};
    const height = Number(input.height);
    const frameRate = Number(input.frameRate);
    const bitrateKbps = Number(input.bitrateKbps);
    const width = Number(input.width);
    const codec = String(input.codec || "auto").toLowerCase();
    const contentMode = String(input.contentMode || "detail").toLowerCase();

    const normalizedHeight = [720, 1080, 1440].includes(height) ? height : 1080;
    return {
        preset: typeof input.preset === "string" ? input.preset : "custom",
        height: normalizedHeight,
        width: width > 0 ? Math.round(width) : Math.round(normalizedHeight * 16 / 9 / 2) * 2,
        frameRate: [15, 24, 30, 60].includes(frameRate) ? frameRate : 30,
        bitrateKbps: Math.min(20000, Math.max(800, Number.isFinite(bitrateKbps) ? bitrateKbps : 5000)),
        codec: ["vp8", "vp9", "h264", "av1"].includes(codec) ? codec : "auto",
        contentMode: contentMode === "motion" ? "motion" : "detail"
    };
}

function buildPeerConnectionConfig(iceServers) {
    const servers = Array.isArray(iceServers)
        ? iceServers
            .filter((server) => server && Array.isArray(server.urls) && server.urls.length > 0)
            .map((server) => {
                const entry = { urls: server.urls };
                if (server.username) {
                    entry.username = server.username;
                }
                if (server.credential) {
                    entry.credential = server.credential;
                }
                return entry;
            })
        : [];

    return {
        ...ICE_CONFIG,
        iceServers: servers.length > 0 ? servers : ICE_CONFIG.iceServers
    };
}

function applyPreferredVideoCodec(transceiver) {
    if (!transceiver?.setCodecPreferences || !screenQuality.codec || screenQuality.codec === "auto") {
        return;
    }

    if (typeof RTCRtpSender === "undefined" || typeof RTCRtpSender.getCapabilities !== "function") {
        return;
    }

    const capabilities = RTCRtpSender.getCapabilities("video");
    if (!capabilities?.codecs?.length) {
        return;
    }

    const mimeTypes = {
        vp8: "video/vp8",
        vp9: "video/vp9",
        h264: "video/h264",
        av1: "video/av1"
    };
    const targetMime = mimeTypes[screenQuality.codec];
    if (!targetMime) {
        return;
    }

    const preferred = capabilities.codecs.filter(
        (codec) => codec.mimeType?.toLowerCase() === targetMime
    );
    if (preferred.length === 0) {
        return;
    }

    const rest = capabilities.codecs.filter((codec) => !preferred.includes(codec));
    try {
        transceiver.setCodecPreferences([...preferred, ...rest]);
    } catch (error) {
        console.warn("Onda: could not apply codec preference", error);
    }
}

async function applyVideoSenderParameters(peer, maxBitrateKbps, maxFramerate, degradationPreference) {
    const sender = peer.videoSender;
    if (!sender || peer.pc.signalingState === "closed") {
        return;
    }

    try {
        const parameters = sender.getParameters();
        if (!parameters.encodings || parameters.encodings.length === 0) {
            parameters.encodings = [{}];
        }

        for (const encoding of parameters.encodings) {
            encoding.maxBitrate = Math.round(maxBitrateKbps * 1000);
            encoding.maxFramerate = maxFramerate;
            encoding.scaleResolutionDownBy = 1;
        }

        if ("degradationPreference" in parameters) {
            parameters.degradationPreference = degradationPreference;
        }

        await sender.setParameters(parameters);
    } catch (error) {
        console.warn("Onda: could not apply outgoing video parameters", error);
    }
}

async function applyScreenQualityToPeers() {
    for (const peer of peers.values()) {
        await applyVideoSenderParameters(
            peer,
            screenQuality.bitrateKbps,
            screenQuality.frameRate,
            screenQuality.contentMode === "motion" ? "maintain-framerate" : "maintain-resolution"
        );
    }
}

async function applyCameraQualityToPeers() {
    for (const peer of peers.values()) {
        await applyVideoSenderParameters(peer, 1500, 30, "balanced");
    }
}

export async function setScreenQuality(nextQuality) {
    screenQuality = normalizeScreenQuality(nextQuality);

    if (!initialized || !local.screenOn || !local.screenVideoTrack) {
        return;
    }

    try {
        await local.screenVideoTrack.applyConstraints({
            frameRate: {
                ideal: screenQuality.frameRate,
                max: screenQuality.frameRate
            },
            width: { ideal: screenQuality.width },
            height: { ideal: screenQuality.height }
        });
    } catch (error) {
        console.warn("Onda: screen capture constraints could not be updated live", error);
    }

    local.screenVideoTrack.contentHint = screenQuality.contentMode === "motion" ? "motion" : "detail";
    await applyScreenQualityToPeers();
}

/* ------------------------------------------------------------------ */
/* Peer connections                                                   */
/* ------------------------------------------------------------------ */

export async function connectPeer(peerId) {
    if (!initialized || !peerId || peerId === selfId || peers.has(peerId)) {
        return;
    }

    if (typeof RTCPeerConnection !== "function") {
        notifyError("connection", "Este navegador não oferece suporte a chamadas em tempo real.");
        return;
    }

    let pc;
    try {
        pc = new RTCPeerConnection(peerConnectionConfig);
    } catch (error) {
        notifyError("connection", "Não foi possível abrir a conexão de áudio com esta pessoa.");
        return;
    }

    // Both sides compute the same offerer role. Only the offerer pre-creates
    // transceivers; the answerer wires its tracks into the transceivers that
    // setRemoteDescription creates from the offer. This is important: browsers
    // do not reliably recycle manually pre-created transceivers on the
    // answering side, which would otherwise make the answer receive-only.
    const iAmInitiator = String(selfId) < String(peerId);

    const peer = {
        id: peerId,
        pc,
        micSender: null,
        videoSender: null,
        screenAudioSender: null,
        pendingCandidates: [],
        remote: {
            micStream: null,
            videoStream: null,
            screenAudioStream: null
        },
        failureNotified: false
    };

    if (iAmInitiator) {
        const currentVideoTrack = local.cameraOn
            ? local.cameraTrack
            : local.screenOn
                ? local.screenVideoTrack
                : local.placeholderVideoTrack;
        const currentScreenAudioTrack = local.screenOn && local.screenAudioTrack
            ? local.screenAudioTrack
            : local.placeholderScreenAudioTrack;

        const micTransceiver = addTransceiver(pc, "audio", local.micTransmitTrack, "mic");
        const videoTransceiver = addTransceiver(pc, "video", currentVideoTrack, "video");
        const screenAudioTransceiver = addTransceiver(
            pc,
            "audio",
            currentScreenAudioTrack,
            "screen-audio"
        );

        peer.micSender = micTransceiver?.sender || null;
        peer.videoSender = videoTransceiver?.sender || null;
        peer.screenAudioSender = screenAudioTransceiver?.sender || null;
        applyPreferredVideoCodec(videoTransceiver);
    }

    peers.set(peerId, peer);

    if (local.screenOn) {
        await applyVideoSenderParameters(
            peer,
            screenQuality.bitrateKbps,
            screenQuality.frameRate,
            screenQuality.contentMode === "motion" ? "maintain-framerate" : "maintain-resolution"
        );
    } else if (local.cameraOn) {
        await applyVideoSenderParameters(peer, 1500, 30, "balanced");
    }

    pc.addEventListener("track", (event) => handleRemoteTrack(peer, event));
    pc.addEventListener("icecandidate", (event) => {
        if (event.candidate && initialized) {
            void sendSignal(peerId, {
                type: "ice",
                candidate: event.candidate.toJSON()
            });
        }
    });
    pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed" && !peer.failureNotified) {
            peer.failureNotified = true;
            notifyError(
                "connection",
                "A conexão de áudio com uma pessoa falhou. Recarregue a página se ela não se recuperar."
            );
        }
    });

    await flushPeerSignals(peerId);

    if (iAmInitiator && pc.signalingState === "stable" && !pc.remoteDescription) {
        await createAndSendOffer(peer);
    }
}

function addTransceiver(pc, kind, track, slot) {
    try {
        if (track) {
            const stream = new MediaStream([track]);
            const transceiver = pc.addTransceiver(track, {
                direction: "sendrecv",
                streams: [stream]
            });
            transceiver.__ondaSlot = slot;
            return transceiver;
        }

        const transceiver = pc.addTransceiver(kind, { direction: "sendrecv" });
        transceiver.__ondaSlot = slot;
        return transceiver;
    } catch (error) {
        console.warn(`Onda: could not add ${slot} transceiver`, error);
        return null;
    }
}

async function createAndSendOffer(peer) {
    try {
        if (peer.pc.signalingState !== "stable") {
            return;
        }

        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        await sendSignal(peer.id, {
            type: "offer",
            sdp: peer.pc.localDescription?.sdp || offer.sdp
        });
    } catch (error) {
        console.warn("Onda: offer creation failed", error);
        notifyError("connection", "Não foi possível iniciar a transmissão com uma pessoa da sala.");
    }
}

export async function receiveSignal(peerId, rawPayload) {
    if (!initialized || !peerId || peerId === selfId) {
        return;
    }

    let payload;
    try {
        payload = JSON.parse(rawPayload);
    } catch {
        return;
    }

    const peer = peers.get(peerId);
    if (!peer) {
        bufferSignal(peerId, payload);
        return;
    }

    await handlePeerSignal(peer, payload);
}

function bufferSignal(peerId, payload) {
    const list = pendingSignals.get(peerId) || [];
    if (list.length >= 96) {
        list.shift();
    }

    list.push(payload);
    pendingSignals.set(peerId, list);
}

async function flushPeerSignals(peerId) {
    const peer = peers.get(peerId);
    const list = pendingSignals.get(peerId);
    if (!peer || !list || list.length === 0) {
        return;
    }

    pendingSignals.delete(peerId);
    for (const payload of list) {
        await handlePeerSignal(peer, payload);
    }
}

async function handlePeerSignal(peer, payload) {
    if (!payload || !peer || peer.pc.signalingState === "closed") {
        return;
    }

    const pc = peer.pc;

    try {
        if (payload.type === "offer") {
            if (!payload.sdp) {
                return;
            }

            await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
            await configureAnswererTransceivers(peer);
            await flushRemoteCandidates(peer);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal(peer.id, {
                type: "answer",
                sdp: pc.localDescription?.sdp || answer.sdp
            });
            return;
        }

        if (payload.type === "answer") {
            if (!payload.sdp || pc.signalingState !== "have-local-offer") {
                return;
            }

            await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
            await flushRemoteCandidates(peer);
            return;
        }

        if (payload.type === "ice" && payload.candidate) {
            if (!pc.remoteDescription) {
                peer.pendingCandidates.push(payload.candidate);
                return;
            }

            try {
                await pc.addIceCandidate(payload.candidate);
            } catch (error) {
                console.warn("Onda: could not add ICE candidate", error);
            }
        }
    } catch (error) {
        console.warn("Onda: signalling error", error);
    }
}

async function flushRemoteCandidates(peer) {
    if (!peer.pc.remoteDescription || peer.pendingCandidates.length === 0) {
        return;
    }

    const candidates = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
    for (const candidate of candidates) {
        try {
            await peer.pc.addIceCandidate(candidate);
        } catch (error) {
            console.warn("Onda: could not flush ICE candidate", error);
        }
    }
}

/**
 * The answering side does not pre-create transceivers: Chrome creates fresh
 * recvonly transceivers from the offer. We label those, attach our outgoing
 * tracks and flip them to sendrecv before generating the answer. setStreams()
 * ensures the answer carries an msid so the offerer can surface the tracks.
 */
async function configureAnswererTransceivers(peer) {
    if (!peer.pc.remoteDescription || peer.micSender) {
        return;
    }

    const transceivers = peer.pc.getTransceivers().filter((transceiver) => !transceiver.stopped);
    const bySlot = new Map();
    let audioIndex = 0;

    for (const transceiver of transceivers) {
        const kind = transceiver.receiver?.track?.kind || transceiver.sender?.track?.kind;
        let slot = null;

        if (kind === "video") {
            slot = "video";
        } else if (kind === "audio") {
            slot = audioIndex === 0 ? "mic" : "screen-audio";
            audioIndex += 1;
        }

        if (slot) {
            transceiver.__ondaSlot = slot;
            bySlot.set(slot, transceiver);
        }
    }

    const localVideoTrack = local.cameraOn
        ? local.cameraTrack
        : local.screenOn
            ? local.screenVideoTrack
            : local.placeholderVideoTrack;

    const localScreenAudioTrack = local.screenOn && local.screenAudioTrack
        ? local.screenAudioTrack
        : local.placeholderScreenAudioTrack;

    await attachAnswererTrack(bySlot.get("mic"), local.micTransmitTrack);
    await attachAnswererTrack(bySlot.get("video"), localVideoTrack);
    await attachAnswererTrack(bySlot.get("screen-audio"), localScreenAudioTrack);

    peer.micSender = bySlot.get("mic")?.sender || null;
    peer.videoSender = bySlot.get("video")?.sender || null;
    peer.screenAudioSender = bySlot.get("screen-audio")?.sender || null;
    applyPreferredVideoCodec(bySlot.get("video"));

    if (local.screenOn) {
        await applyVideoSenderParameters(
            peer,
            screenQuality.bitrateKbps,
            screenQuality.frameRate,
            screenQuality.contentMode === "motion" ? "maintain-framerate" : "maintain-resolution"
        );
    } else if (local.cameraOn) {
        await applyVideoSenderParameters(peer, 1500, 30, "balanced");
    }
}

async function attachAnswererTrack(transceiver, track) {
    if (!transceiver || !track) {
        return;
    }

    try {
        await transceiver.sender.replaceTrack(track);
        transceiver.direction = "sendrecv";

        // setStreams is what keeps the outgoing track addressable by msid in
        // the SDP answer. It is supported by all browsers that support WebRTC
        // with transceivers.
        if (typeof transceiver.sender.setStreams === "function") {
            transceiver.sender.setStreams(new MediaStream([track]));
        }
    } catch (error) {
        console.warn("Onda: could not attach answerer media", error);
    }
}

async function sendSignal(peerId, payload) {
    if (!dotnetRef || !initialized) {
        return;
    }

    try {
        await dotnetRef.invokeMethodAsync("OnWebRtcSignal", peerId, JSON.stringify(payload));
    } catch {
        // The circuit or the target may already be gone.
    }
}

function handleRemoteTrack(peer, event) {
    const transceiver = event.transceiver;
    let slot = transceiver?.__ondaSlot || null;
    const track = event.track;
    if (!track) {
        return;
    }

    if (!slot) {
        // This can happen on the answering side before we have labelled the
        // auto-created transceivers. Audio m-lines are ordered mic then screen
        // audio, so their arrival order is deterministic.
        if (track.kind === "video") {
            slot = "video";
        } else if (track.kind === "audio") {
            slot = peer.remote.micStream ? "screen-audio" : "mic";
        }
    }

    if (slot === "mic") {
        peer.remote.micStream = new MediaStream([track]);
        setRemoteAudio(peer.id, "voice", track);
        return;
    }

    if (slot === "screen-audio") {
        peer.remote.screenAudioStream = new MediaStream([track]);
        setRemoteAudio(peer.id, "screen", track);
        return;
    }

    if (slot === "video" || !peer.remote.videoStream) {
        peer.remote.videoStream = new MediaStream([track]);
        syncMediaElements();
    }
}

function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) {
        return;
    }

    peers.delete(peerId);
    pendingSignals.delete(peerId);

    try {
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.close();
    } catch {
        // Already closed.
    }

    removeRemoteAudio(`${peerId}:voice`);
    removeRemoteAudio(`${peerId}:screen`);

    document.querySelectorAll(`video[data-peer-id="${cssEscape(peerId)}"]`).forEach((video) => {
        video.srcObject = null;
    });
}

export function disconnectPeer(peerId) {
    closePeer(peerId);
}

/* ------------------------------------------------------------------ */
/* Remote audio                                                       */
/* ------------------------------------------------------------------ */

function setRemoteAudio(peerId, channel, track) {
    if (!track) {
        return;
    }

    const key = `${peerId}:${channel}`;
    let item = remoteAudio.get(key);

    if (!item) {
        const element = document.createElement("audio");
        element.autoplay = true;
        element.playsInline = true;
        element.preload = "auto";
        element.className = REMOTE_AUDIO_ELEMENT_CLASS;
        element.setAttribute("aria-hidden", "true");
        element.style.display = "none";
        document.body.appendChild(element);
        item = { element, channel };
        remoteAudio.set(key, item);
    }

    try {
        item.element.srcObject = new MediaStream([track]);
        item.element.volume = getVolumePreference(peerId, channel);
        tryPlayRemoteAudio(item.element);
    } catch (error) {
        console.warn("Onda: could not attach remote audio", error);
    }
}

function getVolumePreference(peerId, channel) {
    const prefs = volumePrefs.get(peerId) || {
        voice: DEFAULT_VOLUME,
        screen: DEFAULT_VOLUME
    };
    const value = Number(prefs[channel]);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
}

export function setPeerVolume(peerId, channel, value) {
    if (!peerId) {
        return;
    }

    const numericValue = Math.min(1, Math.max(0, Number(value)));
    if (!Number.isFinite(numericValue)) {
        return;
    }

    const normalizedChannel = channel === "screen" ? "screen" : "voice";
    const prefs = volumePrefs.get(peerId) || {
        voice: DEFAULT_VOLUME,
        screen: DEFAULT_VOLUME
    };
    prefs[normalizedChannel] = numericValue;
    volumePrefs.set(peerId, prefs);

    const item = remoteAudio.get(`${peerId}:${normalizedChannel}`);
    if (item) {
        item.element.volume = numericValue;
    }
}

function tryPlayRemoteAudio(element) {
    const promise = element.play();
    if (!promise || typeof promise.catch !== "function") {
        return;
    }

    promise.catch((error) => {
        if (error?.name === "NotAllowedError") {
            local.audioBlocked = true;
            notify("OnAudioPlaybackBlocked", true);
        }
    });
}

async function playAllRemoteAudio() {
    if (remoteAudio.size === 0) {
        return;
    }

    let blocked = false;
    for (const item of remoteAudio.values()) {
        try {
            await item.element.play();
        } catch (error) {
            if (error?.name === "NotAllowedError") {
                blocked = true;
            }
        }
    }

    local.audioBlocked = blocked;
    notify("OnAudioPlaybackBlocked", blocked);
}

export async function resumeAudioPlayback() {
    resumeAudioContexts();
    await playAllRemoteAudio();
}

function removeRemoteAudio(key) {
    const item = remoteAudio.get(key);
    if (!item) {
        return;
    }

    try {
        item.element.pause();
        item.element.srcObject = null;
    } catch {
        // Element is already detached.
    }

    item.element.remove();
    remoteAudio.delete(key);

    if (remoteAudio.size === 0 && local.audioBlocked) {
        local.audioBlocked = false;
        notify("OnAudioPlaybackBlocked", false);
    }
}

/* ------------------------------------------------------------------ */
/* Video elements and DOM                                             */
/* ------------------------------------------------------------------ */

export function syncMediaElements() {
    if (!initialized) {
        return;
    }

    const videos = document.querySelectorAll("video[data-peer-id]");
    for (const video of videos) {
        const peerId = video.dataset.peerId;
        if (!peerId) {
            continue;
        }

        let stream = null;
        if (peerId === selfId) {
            stream = local.presentationStream;
        } else {
            stream = peers.get(peerId)?.remote.videoStream || null;
        }

        if (video.srcObject !== stream) {
            try {
                video.srcObject = stream;
                if (stream) {
                    video.play().catch(() => {
                        // The media element is muted, so this is rare.
                    });
                }
            } catch {
                // Element may be in the middle of being replaced.
            }
        }
    }
}

function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
    }

    return String(value).replace(/"/g, '\\"');
}

/**
 * Small, read-only snapshot used by the room UI's automated checks and by
 * anyone debugging media problems from the browser console.
 */
export function getDiagnostics() {
    return {
        initialized,
        roomId,
        selfId,
        provider: "mesh",
        quality: { ...screenQuality },
        local: {
            hasMic: local.hasMic,
            micOn: local.micOn,
            cameraOn: local.cameraOn,
            screenOn: local.screenOn,
            screenWithAudio: local.screenWithAudio,
            hasPresentation: Boolean(local.presentationStream),
            screenSettings: local.screenVideoTrack?.getSettings?.() || null
        },
        peers: Array.from(peers.values()).map((peer) => {
            let senderEncodings = null;
            try {
                senderEncodings = peer.videoSender?.getParameters?.()?.encodings?.map((encoding) => ({
                    maxBitrate: encoding.maxBitrate || null,
                    maxFramerate: encoding.maxFramerate || null,
                    scaleResolutionDownBy: encoding.scaleResolutionDownBy || null
                })) || null;
            } catch {
                senderEncodings = null;
            }

            return {
                id: peer.id,
                connectionState: peer.pc.connectionState,
                iceConnectionState: peer.pc.iceConnectionState,
                signalingState: peer.pc.signalingState,
                hasRemoteVideo: Boolean(peer.remote.videoStream),
                hasRemoteMic: Boolean(peer.remote.micStream),
                senderEncodings,
                senders: {
                    mic: peer.micSender?.track?.kind || null,
                    video: peer.videoSender?.track?.kind || null,
                    screenAudio: peer.screenAudioSender?.track?.kind || null
                },
                transceivers: peer.pc.getTransceivers().map((transceiver, index) => ({
                    index,
                    slot: transceiver.__ondaSlot || null,
                    mid: transceiver.mid,
                    direction: transceiver.direction,
                    currentDirection: transceiver.currentDirection,
                    stopped: transceiver.stopped,
                    senderTrack: transceiver.sender?.track
                        ? {
                            kind: transceiver.sender.track.kind,
                            enabled: transceiver.sender.track.enabled,
                            readyState: transceiver.sender.track.readyState
                        }
                        : null,
                    receiverTrack: transceiver.receiver?.track
                        ? {
                            kind: transceiver.receiver.track.kind,
                            muted: transceiver.receiver.track.muted,
                            readyState: transceiver.receiver.track.readyState
                        }
                        : null
                })),
                localDescription: peer.pc.localDescription
                    ? { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp }
                    : null,
                remoteDescription: peer.pc.remoteDescription
                    ? { type: peer.pc.remoteDescription.type, sdp: peer.pc.remoteDescription.sdp }
                    : null
            };
        }),
        remoteAudioSinks: Array.from(remoteAudio.entries()).map(([key, item]) => ({
            key,
            volume: item.element.volume,
            paused: item.element.paused,
            hasStream: Boolean(item.element.srcObject)
        }))
    };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                      */
/* ------------------------------------------------------------------ */

function notify(method, ...args) {
    if (!dotnetRef) {
        return;
    }

    dotnetRef.invokeMethodAsync(method, ...args).catch(() => {
        // The Blazor circuit may be reconnecting or gone.
    });
}

function notifyMediaState() {
    if (!initialized) {
        return;
    }

    notify(
        "OnLocalMediaStateChanged",
        Boolean(local.micOn),
        Boolean(local.hasMic),
        Boolean(local.cameraOn),
        Boolean(local.screenOn),
        Boolean(local.screenWithAudio)
    );
}

function notifyError(context, message) {
    notify("OnMediaError", context, message);
}

function microphoneErrorMessage(error) {
    switch (error?.name) {
        case "NotAllowedError":
        case "SecurityError":
            return "Permissão de microfone negada. Autorize o acesso no navegador e tente novamente.";
        case "NotFoundError":
        case "DevicesNotFoundError":
            return "Nenhum microfone foi encontrado neste dispositivo.";
        case "NotReadableError":
        case "TrackStartError":
            return "Não foi possível acessar o microfone. Ele pode estar em uso por outro app.";
        case "OverconstrainedError":
            return "O microfone encontrado não atende aos requisitos do navegador.";
        default:
            return "Não foi possível acessar o microfone. Verifique as permissões do navegador.";
    }
}

function cameraErrorMessage(error) {
    switch (error?.name) {
        case "NotAllowedError":
        case "SecurityError":
            return "Permissão de câmera negada. Autorize o acesso no navegador e tente novamente.";
        case "NotFoundError":
        case "DevicesNotFoundError":
            return "Nenhuma câmera foi encontrada neste dispositivo.";
        case "NotReadableError":
        case "TrackStartError":
            return "Não foi possível acessar a câmera. Ela pode estar em uso por outro app.";
        case "OverconstrainedError":
            return "A câmera encontrada não atende aos requisitos do navegador.";
        default:
            return "Não foi possível abrir a câmera. Verifique as permissões do navegador.";
    }
}

function screenErrorMessage(error) {
    switch (error?.name) {
        case "NotSupportedError":
            return "Este navegador não oferece compartilhamento de tela.";
        case "NotReadableError":
            return "Não foi possível capturar a tela. Feche outros apps que possam estar usando a captura.";
        case "InvalidStateError":
            return "A tela não pôde ser compartilhada agora. Tente novamente.";
        default:
            return "Não foi possível compartilhar a tela. Verifique as permissões do navegador.";
    }
}

function stopTrack(track) {
    if (!track) {
        return;
    }

    try {
        track.stop();
    } catch {
        // Already stopped.
    }
}
