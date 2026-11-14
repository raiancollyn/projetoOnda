/*
 * Onda LiveKit / SFU media layer.
 *
 * Same public API and .NET callbacks as webrtc.js, but all media flows through
 * a LiveKit SFU. This scales beyond a mesh and lets the publisher choose
 * screen-share codec, capture resolution, frame rate and bitrate.
 */

import {
    Room,
    RoomEvent,
    Track,
    VideoQuality,
    createLocalAudioTrack,
    createLocalVideoTrack,
    createLocalScreenTracks
} from "./vendor/livekit-client.esm.mjs";

const DEFAULT_VOLUME = 0.8;
const SPEAKING_THRESHOLD = 0.023;
const SPEAKING_HANGOVER_MS = 420;
const HEARTBEAT_MS = 20000;
const REMOTE_AUDIO_ELEMENT_CLASS = "onda-remote-audio";
const DEFAULT_SCREEN_QUALITY = Object.freeze({
    preset: "balanced",
    height: 1080,
    width: 1920,
    frameRate: 30,
    bitrateKbps: 5000,
    codec: "auto",
    contentMode: "detail"
});

const DEFAULT_CAMERA_QUALITY = Object.freeze({
    height: 720,
    width: 1280,
    frameRate: 30,
    bitrateKbps: 1500
});

let dotnetRef = null;
let room = null;
let initialized = false;
let viewerMode = false;
let viewerUrl = "";
let viewerToken = "";
let roomId = "";
let selfId = "";
let reconnectInProgress = false;
let heartbeatTimer = null;
let visibilityHandler = null;
let pageHideHandler = null;
let gestureHandler = null;
let viewerVisibilityHandler = null;
let micAcquirePromise = null;
let cameraBusy = false;
let screenBusy = false;
let quality = { ...DEFAULT_SCREEN_QUALITY };
let cameraQuality = { ...DEFAULT_CAMERA_QUALITY };

const remoteVideos = new Map();
const remoteAudios = new Map();
const volumePreferences = new Map();
let inputDeviceId = "";
let outputDeviceId = "";
let inputVolume = 1;
let outputVolume = 1;

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

        micTrack: null,
        micOn: false,
        hasMic: false,

        cameraTrack: null,
        cameraOn: false,

        screenVideoTrack: null,
        screenAudioTrack: null,
        screenOn: false,
        screenWithAudio: false,

        presentationTrack: null,
        presentationKind: null,
        audioBlocked: false
    };
}

function buildCustomIceServers(iceServers) {
    if (!Array.isArray(iceServers)) {
        return [];
    }

    const normalized = iceServers
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
        });

    const hasTurn = normalized.some((server) =>
        server.urls.some((url) => /^turns?:/i.test(url))
    );

    // Without an explicitly configured TURN, keep the ICE servers that the
    // LiveKit server provides (including LiveKit's own optional TURN).
    return hasTurn ? normalized : [];
}

function normalizeScreenQuality(value) {
    const input = value && typeof value === "object" ? value : {};
    const height = Number(input.height);
    const frameRate = Number(input.frameRate);
    const bitrateKbps = Number(input.bitrateKbps);
    const width = Number(input.width);
    const codec = String(input.codec || "auto").toLowerCase();
    const contentMode = String(input.contentMode || "detail").toLowerCase();
    const normalizedHeight = [720, 1080, 1440, 2160].includes(height) ? height : 1080;

    return {
        preset: typeof input.preset === "string" ? input.preset : "custom",
        height: normalizedHeight,
        width: width > 0 ? Math.round(width) : Math.round(normalizedHeight * 16 / 9 / 2) * 2,
        frameRate: frameRate >= 10 && frameRate <= 60 ? Math.round(frameRate) : 30,
        bitrateKbps: Math.min(20000, Math.max(800, Number.isFinite(bitrateKbps) ? bitrateKbps : 5000)),
        codec: ["vp8", "vp9", "h264", "av1"].includes(codec) ? codec : "auto",
        contentMode: contentMode === "motion" ? "motion" : "detail"
    };
}

function normalizeCameraQuality(value) {
    const input = value && typeof value === "object" ? value : {};
    const height = Number(input.height);
    const frameRate = Number(input.frameRate);
    const bitrateKbps = Number(input.bitrateKbps);
    const width = Number(input.width);
    const normalizedHeight = [480, 720, 1080, 1440, 2160].includes(height) ? height : 720;

    return {
        height: normalizedHeight,
        width: width > 0 ? Math.round(width) : Math.round(normalizedHeight * 16 / 9 / 2) * 2,
        frameRate: frameRate >= 10 && frameRate <= 60 ? Math.round(frameRate) : 30,
        bitrateKbps: Math.min(12000, Math.max(300, Number.isFinite(bitrateKbps) ? bitrateKbps : 1500))
    };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

export async function initialize(ref, roomCode, guestId, config = {}) {
    if (initialized) {
        await disposeRoom();
    }

    dotnetRef = ref;
    roomId = roomCode || "";
    selfId = guestId || "";
    viewerMode = Boolean(config?.viewerMode);
    viewerUrl = config?.livekitUrl || "";
    viewerToken = config?.livekitToken || "";
    quality = normalizeScreenQuality(config?.quality);
    cameraQuality = normalizeCameraQuality(config?.cameraQuality);
    local = createLocalState();
    initialized = true;
    reconnectInProgress = false;

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

    if (!config.livekitUrl || !config.livekitToken) {
        notifyError("connection", "O servidor de mídia SFU não está configurado.");
        return false;
    }

    setupHeartbeat();
    setupPageLifecycle();
    installGestureUnlock();

    if (viewerMode) {
        stopHeartbeat();
        installViewerVisibility();
    }

    room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        stopLocalTrackOnUnpublish: true,
        audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        videoCaptureDefaults: {
            resolution: { width: 1280, height: 720, frameRate: 30 }
        },
        publishDefaults: {
            simulcast: true,
            videoEncoding: {
                maxBitrate: 1_500_000,
                maxFramerate: 30
            },
            screenShareEncoding: {
                maxBitrate: quality.bitrateKbps * 1000,
                maxFramerate: quality.frameRate,
                priority: "high"
            }
        }
    });

    bindRoomEvents(room);

    try {
        const connectOptions = { autoSubscribe: true };
        const customIceServers = buildCustomIceServers(config.iceServers);
        if (customIceServers.length > 0) {
            connectOptions.rtcConfig = { iceServers: customIceServers };
        }

        await room.connect(config.livekitUrl, config.livekitToken, connectOptions);
    } catch (error) {
        console.warn("Onda: LiveKit connection failed", error);
        notifyError(
            "connection",
            "Não foi possível conectar ao servidor de mídia. O chat e a lista de pessoas continuam funcionando."
        );
        return false;
    }

    if (!viewerMode) {
        notifyAudioBlocked(!room.canPlaybackAudio);
    }

    // Let the room paint before the browser permission prompt appears.
    if (!viewerMode) {
        window.setTimeout(() => {
            if (initialized && room) {
                void acquireMicrophone(true);
            }
        }, 220);
    }

    return true;
}

function bindRoomEvents(activeRoom) {
    activeRoom.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    activeRoom.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    activeRoom.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    activeRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!initialized || !room) {
            return;
        }

        notifyAudioBlocked(!room.canPlaybackAudio);
    });
    activeRoom.on(RoomEvent.Reconnecting, () => {
        reconnectInProgress = true;
    });
    activeRoom.on(RoomEvent.Reconnected, () => {
        reconnectInProgress = false;
    });
    activeRoom.on(RoomEvent.Disconnected, (reason) => {
        reconnectInProgress = false;
        if (!initialized) {
            return;
        }

        resetLocalMediaState();
        notifyError(
            "connection",
            reason === "duplicate_identity"
                ? "Esta sessão foi aberta em outra janela. A chamada foi desconectada."
                : "A conexão com o servidor de mídia foi encerrada. O chat continua disponível."
        );
    });
}

export async function disposeRoom() {
    initialized = false;
    stopHeartbeat();
    removePageLifecycle();
    removeGestureUnlock();
    stopSpeakingMonitor(false);

    for (const key of Array.from(remoteAudios.keys())) {
        removeRemoteAudio(key);
    }

    for (const entry of Array.from(remoteVideos.values())) {
        try {
            entry.track.detach();
        } catch {
            // Already detached.
        }
    }
    remoteVideos.clear();

    for (const video of document.querySelectorAll("video[data-peer-id]")) {
        const track = video.__ondaLiveKitTrack;
        if (track) {
            try {
                track.detach(video);
            } catch {
                // Already detached.
            }
            video.__ondaLiveKitTrack = null;
        }
    }

    await unpublishLocalTrack(local.screenAudioTrack);
    await unpublishLocalTrack(local.screenVideoTrack);
    await unpublishLocalTrack(local.cameraTrack);
    await unpublishLocalTrack(local.micTrack);

    stopLocalTrack(local.screenAudioTrack);
    stopLocalTrack(local.screenVideoTrack);
    stopLocalTrack(local.cameraTrack);
    stopLocalTrack(local.micTrack);

    if (local.audioContext && local.audioContext.state !== "closed") {
        try {
            local.audioContext.close();
        } catch {
            // Already closed.
        }
    }

    if (room) {
        try {
            room.removeAllListeners();
            await room.disconnect();
        } catch {
            // Connection already gone.
        }
    }

    room = null;
    local = createLocalState();
    micAcquirePromise = null;
    dotnetRef = null;
    roomId = "";
    selfId = "";
}

async function unpublishLocalTrack(track) {
    if (!track || !room || !room.localParticipant) {
        return;
    }

    try {
        await room.localParticipant.unpublishTrack(track, true);
    } catch {
        // The track might already be unpublished.
    }
}

/* ------------------------------------------------------------------ */
/* Presence, lifecycle and audio unlock                               */
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

function installViewerVisibility() {
    removeViewerVisibility();
    viewerVisibilityHandler = () => {
        if (!initialized) {
            return;
        }

        const videos = Array.from(document.querySelectorAll("video[data-peer-id]"));
        if (document.visibilityState !== "visible") {
            for (const video of videos) {
                video.pause();
                video.classList.remove("has-stream");
            }
            return;
        }

        syncMediaElements();
        if (room && room.state === "disconnected" && viewerUrl && viewerToken) {
            room.connect(viewerUrl, viewerToken, { autoSubscribe: true })
                .then(() => {
                    syncMediaElements();
                    for (const video of videos) {
                        video.play()
                            .then(() => video.classList.add("has-stream"))
                            .catch(() => { });
                    }
                })
                .catch(() => {
                    // The next resume will retry.
                });
            return;
        }

        for (const video of videos) {
            video.play()
                .then(() => video.classList.add("has-stream"))
                .catch(() => {
                    // The track may be waiting for a new subscription.
                });
        }
    };
    document.addEventListener("visibilitychange", viewerVisibilityHandler);
}

function removeViewerVisibility() {
    if (viewerVisibilityHandler) {
        document.removeEventListener("visibilitychange", viewerVisibilityHandler);
        viewerVisibilityHandler = null;
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
        // The next heartbeat will retry.
    });
}

function sendLeaveBeacon() {
    if (!roomId || !selfId) {
        return;
    }

    try {
        navigator.sendBeacon(
            "/api/presence/leave",
            new Blob([JSON.stringify({ roomId, guestId: selfId })], { type: "application/json" })
        );
    } catch {
        // Stale-presence cleanup is the fallback.
    }
}

function installGestureUnlock() {
    removeGestureUnlock();
    gestureHandler = () => {
        resumeAudioContext();
        playAllRemoteAudio();
        if (room && !room.canPlaybackAudio) {
            room.startAudio()
                .then(() => notifyAudioBlocked(false))
                .catch(() => notifyAudioBlocked(true));
        }
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

export async function resumeAudioPlayback() {
    resumeAudioContext();
    if (room) {
        try {
            await room.startAudio();
        } catch {
            // The banner remains visible.
        }
    }

    await playAllRemoteAudio();
}

function resumeAudioContext() {
    if (local.audioContext && local.audioContext.state === "suspended") {
        local.audioContext.resume().catch(() => {
            // A future gesture will retry.
        });
    }
}

async function playAllRemoteAudio() {
    let blocked = false;
    for (const item of remoteAudios.values()) {
        try {
            await item.element.play();
        } catch (error) {
            if (error?.name === "NotAllowedError") {
                blocked = true;
            }
        }
    }

    if (room) {
        blocked = blocked || !room.canPlaybackAudio;
    }

    notifyAudioBlocked(blocked);
}

/* ------------------------------------------------------------------ */
/* Microphone                                                         */
/* ------------------------------------------------------------------ */

async function acquireMicrophone(enable) {
    if (!initialized || !room) {
        return false;
    }

    if (local.micTrack?.mediaStreamTrack?.readyState === "live") {
        await setMicrophoneEnabled(enable, true);
        return true;
    }

    if (micAcquirePromise) {
        return micAcquirePromise;
    }

    if (!window.isSecureContext) {
        notifyMediaState();
        return false;
    }

    micAcquirePromise = (async () => {
        try {
            const track = await createLocalAudioTrack({
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {})
            });

            if (!initialized || !room) {
                track.stop();
                return false;
            }

            local.micTrack = track;
            local.hasMic = true;
            applyInputVolumeToTrack(track);
            track.mediaStreamTrack.addEventListener("ended", handleMicrophoneEnded, { once: true });

            await room.localParticipant.publishTrack(track, {
                source: Track.Source.Microphone,
                name: "microphone",
                dtx: true,
                red: true
            });

            await setMicrophoneEnabled(enable !== false, false);
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

async function setMicrophoneEnabled(enabled, notify) {
    const canEnable = enabled && local.micTrack?.mediaStreamTrack?.readyState === "live";
    local.micOn = Boolean(canEnable);

    if (local.micTrack) {
        try {
            if (local.micOn) {
                await local.micTrack.unmute();
            } else {
                await local.micTrack.mute();
            }
        } catch {
            // The track may have ended.
        }
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

export async function toggleMicrophone() {
    if (!initialized) {
        return;
    }

    resumeAudioContext();

    if (local.micOn) {
        await setMicrophoneEnabled(false, true);
        return;
    }

    if (micAcquirePromise) {
        await micAcquirePromise;
        return;
    }

    if (local.micTrack?.mediaStreamTrack?.readyState === "live") {
        await setMicrophoneEnabled(true, true);
        return;
    }

    await acquireMicrophone(true);
}

function clampVolume(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
}

function applyInputVolumeToTrack(track = local.micTrack) {
    const mediaTrack = track?.mediaStreamTrack;
    if (!mediaTrack || typeof mediaTrack.applyConstraints !== "function") {
        return;
    }

    mediaTrack.applyConstraints({ volume: inputVolume }).catch(() => {
        // Some browsers do not expose input gain as a track constraint.
    });
}

export function setAudioInputVolume(value) {
    inputVolume = clampVolume(value);
    applyInputVolumeToTrack();
    return inputVolume;
}

export async function switchAudioInput(deviceId) {
    if (!initialized || !room || !deviceId) {
        return false;
    }

    if (deviceId === inputDeviceId && local.micTrack?.mediaStreamTrack?.readyState === "live") {
        return true;
    }

    const wasOn = local.micOn;
    const oldTrack = local.micTrack;
    inputDeviceId = deviceId;

    try {
        const nextTrack = await createLocalAudioTrack({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            deviceId: { exact: deviceId }
        });

        if (!initialized || !room) {
            stopLocalTrack(nextTrack);
            return false;
        }

        nextTrack.mediaStreamTrack.addEventListener("ended", handleMicrophoneEnded, { once: true });
        await room.localParticipant.publishTrack(nextTrack, {
            source: Track.Source.Microphone,
            name: "microphone",
            dtx: true,
            red: true
        });

        local.micTrack = nextTrack;
        local.hasMic = true;
        applyInputVolumeToTrack(nextTrack);
        await setMicrophoneEnabled(wasOn, false);

        if (oldTrack) {
            oldTrack.mediaStreamTrack.removeEventListener("ended", handleMicrophoneEnded);
            await unpublishLocalTrack(oldTrack);
            stopLocalTrack(oldTrack);
        }

        notifyMediaState();
        return true;
    } catch (error) {
        inputDeviceId = "";
        notifyError("microphone", "Não foi possível trocar o microfone.");
        return false;
    }
}

export function setAudioOutputVolume(value) {
    outputVolume = clampVolume(value);
    for (const item of remoteAudios.values()) {
        applyOutputSettingsToElement(item.element);
    }
    return outputVolume;
}

export async function setAudioOutputDevice(deviceId) {
    outputDeviceId = deviceId || "";
    const results = [];
    for (const item of remoteAudios.values()) {
        results.push(applyOutputSettingsToElement(item.element));
    }
    await Promise.all(results);
    return true;
}

function applyOutputSettingsToElement(element) {
    if (!element) {
        return Promise.resolve();
    }

    element.volume = outputVolume;
    if (outputDeviceId && typeof element.setSinkId === "function") {
        return element.setSinkId(outputDeviceId).catch(() => {
            // The output device may have disappeared or require a new gesture.
        });
    }

    return Promise.resolve();
}

export async function getAudioSettings() {
    let devices = [];
    try {
        devices = await navigator.mediaDevices?.enumerateDevices?.() || [];
    } catch {
        devices = [];
    }

    const inputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Microfone ${index + 1}`
        }));

    const outputs = devices
        .filter((device) => device.kind === "audiooutput")
        .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Saída ${index + 1}`
        }));

    return {
        inputs,
        outputs,
        inputDeviceId,
        outputDeviceId,
        inputVolume,
        outputVolume,
        canSelectOutput: typeof HTMLMediaElement !== "undefined" &&
            typeof HTMLMediaElement.prototype.setSinkId === "function"
    };
}

function handleMicrophoneEnded() {
    if (!initialized) {
        return;
    }

    const track = local.micTrack;
    local.micTrack = null;
    local.hasMic = false;
    local.micOn = false;
    stopSpeakingMonitor(true);
    void unpublishLocalTrack(track);
    stopLocalTrack(track);
    notifyMediaState();
    notifyError("microphone", "O microfone foi desconectado. Conecte-o novamente para falar.");
}

function startSpeakingMonitor() {
    stopSpeakingMonitor(false);

    if (!local.micOn || !local.micTrack?.mediaStreamTrack) {
        return;
    }

    try {
        if (!local.audioContext || local.audioContext.state === "closed") {
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            local.audioContext = new AudioContextCtor();
        }

        const context = local.audioContext;
        resumeAudioContext();
        const stream = new MediaStream([local.micTrack.mediaStreamTrack]);
        const source = context.createMediaStreamSource(stream);
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

            setLocalSpeaking(now - local.lastVoiceAt < SPEAKING_HANGOVER_MS);
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
/* Camera                                                             */
/* ------------------------------------------------------------------ */

export async function toggleCamera() {
    if (!initialized || !room || cameraBusy) {
        return;
    }

    resumeAudioContext();

    if (local.cameraOn) {
        await stopCameraSession(true);
        return;
    }

    await startCameraWithOptions({ facingMode: "user" });
}

async function startCameraWithOptions(videoOptions = {}) {
    if (!initialized || !room || cameraBusy) {
        return false;
    }

    cameraBusy = true;
    try {
        let track;
        try {
            track = await createLocalVideoTrack({
                resolution: {
                    width: cameraQuality.width,
                    height: cameraQuality.height,
                    frameRate: cameraQuality.frameRate
                },
                ...videoOptions
            });
        } catch (error) {
            notifyError("camera", cameraErrorMessage(error));
            return false;
        }

        if (!initialized || !room) {
            track.stop();
            return false;
        }

        if (local.screenOn) {
            await stopScreenSession(false);
        }

        await stopCameraSession(false);
        track.mediaStreamTrack.contentHint = "motion";
        track.mediaStreamTrack.addEventListener("ended", handleCameraEnded, { once: true });

        try {
            await room.localParticipant.publishTrack(track, {
                source: Track.Source.Camera,
                name: "camera",
                simulcast: true,
                videoEncoding: {
                    maxBitrate: cameraQuality.bitrateKbps * 1000,
                    maxFramerate: cameraQuality.frameRate
                },
                degradationPreference: "balanced"
            });
        } catch (error) {
            track.stop();
            notifyError("camera", "Não foi possível publicar a câmera no servidor de mídia.");
            notifyMediaState();
            return false;
        }

        local.cameraTrack = track;
        local.cameraOn = true;
        local.presentationTrack = track;
        local.presentationKind = "camera";
        notifyMediaState();
        syncMediaElements();
        return true;
    } finally {
        cameraBusy = false;
    }
}

export async function switchCamera(deviceId) {
    if (!initialized || !room || cameraBusy || !local.cameraOn || !deviceId) {
        return false;
    }

    await stopCameraSession(true);
    return startCameraWithOptions({ deviceId });
}

export async function getCameraOptions() {
    let devices = [];
    try {
        devices = await navigator.mediaDevices?.enumerateDevices?.() || [];
    } catch {
        devices = [];
    }

    const cameras = devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => {
            const label = (device.label || "").trim() || `Câmera ${index + 1}`;
            const lower = label.toLowerCase();
            const facing = /(back|rear|environment|traseira|trás|tras)/.test(lower)
                ? "environment"
                : /(front|user|frontal|frente)/.test(lower)
                    ? "user"
                    : "";
            return { deviceId: device.deviceId, label, facing };
        });

    const mediaTrack = local.cameraTrack?.mediaStreamTrack;
    const settings = mediaTrack?.getSettings?.() || {};
    const capabilities = mediaTrack?.getCapabilities?.() || {};

    return {
        devices: cameras,
        activeDeviceId: settings.deviceId || "",
        facingMode: settings.facingMode || "",
        torchSupported: Boolean(capabilities.torch),
        torchOn: Boolean(settings.torch)
    };
}

export async function setCameraTorch(enabled) {
    const mediaTrack = local.cameraTrack?.mediaStreamTrack;
    const capabilities = mediaTrack?.getCapabilities?.() || {};
    if (!mediaTrack || !capabilities.torch) {
        return false;
    }

    try {
        await mediaTrack.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
        return Boolean(mediaTrack.getSettings?.().torch);
    } catch (error) {
        console.warn("Onda: could not change camera torch", error);
        return false;
    }
}

function handleCameraEnded() {
    if (initialized && local.cameraOn) {
        void stopCameraSession(true);
    }
}

async function stopCameraSession(notifyServer) {
    if (!local.cameraOn && !local.cameraTrack) {
        return;
    }

    const track = local.cameraTrack;
    if (track?.mediaStreamTrack) {
        track.mediaStreamTrack.removeEventListener("ended", handleCameraEnded);
    }

    local.cameraTrack = null;
    local.cameraOn = false;
    if (local.presentationKind === "camera") {
        local.presentationTrack = null;
        local.presentationKind = null;
    }

    await unpublishLocalTrack(track);
    stopLocalTrack(track);

    if (notifyServer) {
        notifyMediaState();
        syncMediaElements();
    }
}

/* ------------------------------------------------------------------ */
/* Screen share                                                       */
/* ------------------------------------------------------------------ */

function buildScreenCaptureOptions() {
    return {
        audio: true,
        resolution: {
            width: quality.width,
            height: quality.height,
            frameRate: quality.frameRate
        },
        contentHint: quality.contentMode === "motion" ? "motion" : "detail",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: "include"
    };
}

function buildScreenPublishOptions() {
    const options = {
        source: Track.Source.ScreenShare,
        name: "screen",
        simulcast: true,
        screenShareEncoding: {
            maxBitrate: quality.bitrateKbps * 1000,
            maxFramerate: quality.frameRate,
            priority: "high"
        },
        degradationPreference: quality.contentMode === "motion"
            ? "maintain-framerate"
            : "maintain-resolution"
    };

    if (quality.codec !== "auto") {
        options.videoCodec = quality.codec;
    }

    return options;
}

async function publishScreenTracks(videoTrack, audioTrack, audioEnabled = true) {
    try {
        await room.localParticipant.publishTrack(videoTrack, buildScreenPublishOptions());
    } catch (error) {
        console.warn("Onda: screen video publish failed", error);
        stopLocalTrack(videoTrack);
        stopLocalTrack(audioTrack);
        notifyError("screen", "Não foi possível publicar a tela no servidor de mídia.");
        return false;
    }

    let audioPublished = false;
    if (audioTrack) {
        if (audioTrack.mediaStreamTrack) {
            audioTrack.mediaStreamTrack.enabled = audioEnabled;
            audioTrack.mediaStreamTrack.contentHint = "music";
        }

        try {
            await room.localParticipant.publishTrack(audioTrack, {
                source: Track.Source.ScreenShareAudio,
                name: "screen-audio"
            });
            audioPublished = true;
        } catch (error) {
            console.warn("Onda: screen audio publish failed", error);
            stopLocalTrack(audioTrack);
            audioTrack = null;
        }
    }

    local.screenVideoTrack = videoTrack;
    local.screenAudioTrack = audioPublished ? audioTrack : null;
    local.screenOn = true;
    local.screenWithAudio = audioPublished;
    local.presentationTrack = videoTrack;
    local.presentationKind = "screen";

    videoTrack.mediaStreamTrack.addEventListener("ended", handleScreenEnded, { once: true });
    if (audioPublished && audioTrack?.mediaStreamTrack) {
        audioTrack.mediaStreamTrack.addEventListener(
            "ended",
            handleScreenAudioEnded,
            { once: true }
        );
    }

    return true;
}

export async function toggleScreenShare() {
    if (!initialized || !room || screenBusy) {
        return;
    }

    resumeAudioContext();

    if (local.screenOn) {
        await stopScreenSession(true);
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

    screenBusy = true;

    try {
        let tracks;
        try {
            tracks = await createLocalScreenTracks(buildScreenCaptureOptions());
        } catch (error) {
            if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
                notifyError("screen", screenErrorMessage(error));
            }
            return;
        }

        if (!initialized || !room) {
            tracks.forEach((track) => stopLocalTrack(track));
            return;
        }

        const videoTrack = tracks.find((track) => track.kind === "video") || null;
        const audioTrack = tracks.find((track) => track.kind === "audio") || null;

        if (!videoTrack) {
            tracks.forEach((track) => stopLocalTrack(track));
            notifyError("screen", "Nenhuma tela foi compartilhada.");
            return;
        }

        videoTrack.mediaStreamTrack.contentHint =
            quality.contentMode === "motion" ? "motion" : "detail";

        if (local.cameraOn) {
            await stopCameraSession(false);
        }
        await stopScreenSession(false);

        const published = await publishScreenTracks(videoTrack, audioTrack);
        if (!published) {
            notifyMediaState();
            syncMediaElements();
            return;
        }

        notifyMediaState();
        syncMediaElements();
    } finally {
        screenBusy = false;
    }
}

export async function switchScreenSource() {
    if (!initialized || !room || screenBusy || !local.screenOn) {
        return false;
    }

    screenBusy = true;
    try {
        let tracks;
        try {
            tracks = await createLocalScreenTracks(buildScreenCaptureOptions());
        } catch (error) {
            if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
                notifyError("screen", screenErrorMessage(error));
            }
            return false;
        }

        const videoTrack = tracks.find((track) => track.kind === "video") || null;
        const audioTrack = tracks.find((track) => track.kind === "audio") || null;

        if (!videoTrack) {
            tracks.forEach((track) => stopLocalTrack(track));
            notifyError("screen", "Nenhuma tela foi compartilhada.");
            return false;
        }

        videoTrack.mediaStreamTrack.contentHint =
            quality.contentMode === "motion" ? "motion" : "detail";

        const audioWasEnabled = local.screenAudioTrack?.mediaStreamTrack?.enabled ?? true;

        // A captura nova já foi obtida; só agora a transmissão antiga é trocada.
        await stopScreenSession(false);
        const published = await publishScreenTracks(videoTrack, audioTrack, audioWasEnabled);
        if (!published) {
            notifyMediaState();
            syncMediaElements();
            return false;
        }

        notifyMediaState();
        syncMediaElements();
        return true;
    } finally {
        screenBusy = false;
    }
}

export function setScreenAudioEnabled(enabled) {
    if (!initialized || !local.screenOn || !local.screenAudioTrack?.mediaStreamTrack) {
        return false;
    }

    local.screenAudioTrack.mediaStreamTrack.enabled = Boolean(enabled);
    return true;
}

function handleScreenEnded() {
    if (initialized && local.screenOn) {
        void stopScreenSession(true);
    }
}

function handleScreenAudioEnded() {
    if (!initialized || !local.screenOn) {
        return;
    }

    const track = local.screenAudioTrack;
    local.screenAudioTrack = null;
    local.screenWithAudio = false;
    void unpublishLocalTrack(track);
    stopLocalTrack(track);
    notifyMediaState();
}

async function stopScreenSession(notifyServer) {
    if (!local.screenOn && !local.screenVideoTrack && !local.screenAudioTrack) {
        return;
    }

    const videoTrack = local.screenVideoTrack;
    const audioTrack = local.screenAudioTrack;

    if (videoTrack?.mediaStreamTrack) {
        videoTrack.mediaStreamTrack.removeEventListener("ended", handleScreenEnded);
    }
    if (audioTrack?.mediaStreamTrack) {
        audioTrack.mediaStreamTrack.removeEventListener("ended", handleScreenAudioEnded);
    }

    local.screenVideoTrack = null;
    local.screenAudioTrack = null;
    local.screenOn = false;
    local.screenWithAudio = false;
    if (local.presentationKind === "screen") {
        local.presentationTrack = null;
        local.presentationKind = null;
    }

    await unpublishLocalTrack(audioTrack);
    await unpublishLocalTrack(videoTrack);
    stopLocalTrack(audioTrack);
    stopLocalTrack(videoTrack);

    if (notifyServer) {
        notifyMediaState();
        syncMediaElements();
    }
}

/* ------------------------------------------------------------------ */
/* Remote tracks and video elements                                   */
/* ------------------------------------------------------------------ */

function handleTrackSubscribed(track, publication, participant) {
    if (!participant || !track) {
        return;
    }

    if (viewerMode && track.kind === "audio") {
        // Native audio is already rendering the room soundtrack.
        return;
    }

    const identity = participant.identity;

    if (track.kind === "video") {
        const existing = remoteVideos.get(identity);
        if (existing?.track && existing.track !== track) {
            detachRemoteVideo(existing.track);
        }

        // Screen shares are usually text-heavy; favor resolution over the
        // adaptive stream's automatic layer choice. Cameras still adapt.
        if (publication?.source === Track.Source.ScreenShare) {
            try {
                publication.setVideoQuality(VideoQuality.HIGH);
            } catch {
                // Older clients may not support manual quality selection.
            }
        }

        remoteVideos.set(identity, {
            track,
            source: publication?.source || Track.Source.Camera
        });
        syncMediaElements();
        return;
    }

    if (track.kind === "audio") {
        const channel = publication?.source === Track.Source.ScreenShareAudio
            ? "screen"
            : publication?.source === Track.Source.Microphone
                ? "voice"
                : null;

        if (channel) {
            attachRemoteAudio(identity, channel, track);
        }
    }
}

function handleTrackUnsubscribed(track, publication, participant) {
    if (!participant || !track) {
        return;
    }

    const identity = participant.identity;

    if (track.kind === "video") {
        const existing = remoteVideos.get(identity);
        if (existing?.track === track) {
            remoteVideos.delete(identity);
            detachRemoteVideo(track);
            syncMediaElements();
        }
        return;
    }

    if (track.kind === "audio") {
        const channel = publication?.source === Track.Source.ScreenShareAudio ? "screen" : "voice";
        removeRemoteAudio(`${identity}:${channel}`, track);
    }
}

function handleParticipantDisconnected(participant) {
    if (!participant) {
        return;
    }

    const identity = participant.identity;
    const video = remoteVideos.get(identity);
    if (video) {
        remoteVideos.delete(identity);
        detachRemoteVideo(video.track);
    }

    removeRemoteAudio(`${identity}:voice`);
    removeRemoteAudio(`${identity}:screen`);
    syncMediaElements();
}

function detachRemoteVideo(track) {
    try {
        track.detach();
    } catch {
        // Already detached.
    }
}

function attachRemoteAudio(identity, channel, track) {
    const key = `${identity}:${channel}`;
    removeRemoteAudio(key);

    const element = document.createElement("audio");
    element.autoplay = true;
    element.playsInline = true;
    element.preload = "auto";
    element.className = REMOTE_AUDIO_ELEMENT_CLASS;
    element.setAttribute("aria-hidden", "true");
    element.style.display = "none";
    element.volume = 1;
    document.body.appendChild(element);

    try {
        track.attach(element);
        track.setVolume(getVolume(identity, channel));
        applyOutputSettingsToElement(element);
    } catch (error) {
        console.warn("Onda: could not attach remote audio", error);
    }

    remoteAudios.set(key, { track, element, channel });
    element.play().catch((error) => {
        if (error?.name === "NotAllowedError") {
            notifyAudioBlocked(true);
        }
    });
}

function removeRemoteAudio(key, expectedTrack = null) {
    const item = remoteAudios.get(key);
    if (!item || (expectedTrack && item.track !== expectedTrack)) {
        return;
    }

    try {
        item.track.detach(item.element);
    } catch {
        // Already detached.
    }

    item.element.remove();
    remoteAudios.delete(key);
}

export function setPeerVolume(peerId, channel, value) {
    if (!peerId) {
        return;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return;
    }

    const volume = Math.min(1, Math.max(0, numericValue));
    const normalizedChannel = channel === "screen" ? "screen" : "voice";
    const preferences = volumePreferences.get(peerId) || {
        voice: DEFAULT_VOLUME,
        screen: DEFAULT_VOLUME
    };
    preferences[normalizedChannel] = volume;
    volumePreferences.set(peerId, preferences);

    const item = remoteAudios.get(`${peerId}:${normalizedChannel}`);
    if (item) {
        item.track.setVolume(volume);
    }
}

function getVolume(peerId, channel) {
    const preferences = volumePreferences.get(peerId);
    const value = Number(preferences?.[channel]);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
}

export function syncMediaElements() {
    if (!initialized) {
        return;
    }

    for (const video of document.querySelectorAll("video[data-peer-id]")) {
        const peerId = video.dataset.peerId;
        if (!peerId) {
            continue;
        }

        let targetTrack = null;
        if (peerId === selfId) {
            targetTrack = local.presentationTrack;
        } else {
            targetTrack = remoteVideos.get(peerId)?.track || null;
        }

        const previousTrack = video.__ondaLiveKitTrack || null;
        if (previousTrack === targetTrack) {
            continue;
        }

        if (previousTrack) {
            try {
                previousTrack.detach(video);
            } catch {
                // Already detached.
            }
            video.__ondaLiveKitTrack = null;
            video.classList.remove("has-stream");
        }

        if (targetTrack) {
            try {
                const markReady = () => video.classList.add("has-stream");
                video.addEventListener("loadeddata", markReady, { once: true });
                video.addEventListener("playing", markReady, { once: true });
                targetTrack.attach(video);
                video.muted = true;
                video.__ondaLiveKitTrack = targetTrack;
                video.play().then(markReady).catch(() => {
                    // Video elements are muted; playback is normally allowed.
                });
            } catch (error) {
                console.warn("Onda: could not attach video track", error);
            }
        } else {
            video.classList.remove("has-stream");
        }
    }
}

/* ------------------------------------------------------------------ */
/* Quality                                                            */
/* ------------------------------------------------------------------ */

export async function setScreenQuality(nextQuality) {
    quality = normalizeScreenQuality(nextQuality);

    if (!initialized || !room || !local.screenOn || !local.screenVideoTrack) {
        return false;
    }

    const mediaTrack = local.screenVideoTrack.mediaStreamTrack;
    try {
        await mediaTrack.applyConstraints({
            frameRate: {
                ideal: quality.frameRate,
                max: quality.frameRate
            },
            width: { ideal: quality.width },
            height: { ideal: quality.height }
        });
    } catch (error) {
        console.warn("Onda: screen capture constraints could not be updated live", error);
    }

    mediaTrack.contentHint = quality.contentMode === "motion" ? "motion" : "detail";

    // Encoding é atualizado no sender atual; não republicamos a faixa, então
    // os participantes remotos continuam inscritos sem interrupção.
    const sender = local.screenVideoTrack.sender;
    if (sender) {
        try {
            const parameters = sender.getParameters();
            const encodings = parameters.encodings || [];
            const targetBitrate = Math.round(quality.bitrateKbps * 1000);
            const currentPeak = Math.max(0, ...encodings.map((encoding) => encoding.maxBitrate || 0));

            if (encodings.length === 0) {
                parameters.encodings = [{
                    maxBitrate: targetBitrate,
                    maxFramerate: quality.frameRate
                }];
            } else {
                for (const encoding of encodings) {
                    if (currentPeak > 0 && encoding.maxBitrate) {
                        encoding.maxBitrate = Math.max(
                            150000,
                            Math.round(encoding.maxBitrate * (targetBitrate / currentPeak)));
                    } else {
                        encoding.maxBitrate = targetBitrate;
                    }
                    encoding.maxFramerate = quality.frameRate;
                }
            }

            if ("degradationPreference" in parameters) {
                parameters.degradationPreference = quality.contentMode === "motion"
                    ? "maintain-framerate"
                    : "maintain-resolution";
            }

            await sender.setParameters(parameters);
        } catch (error) {
            console.warn("Onda: live screen encoding update failed", error);
        }
    }

    notifyMediaState();
    syncMediaElements();
    return true;
}

function cameraCapabilitiesFromTrack(track) {
    const mediaTrack = track?.mediaStreamTrack;
    if (!mediaTrack) {
        return null;
    }

    const settings = mediaTrack.getSettings?.() || {};
    const capabilities = mediaTrack.getCapabilities?.() || {};
    const width = Number(settings.width) || 0;
    const height = Number(settings.height) || 0;
    const frameRate = Number(settings.frameRate) || 0;

    return {
        maxWidth: Number(capabilities.width?.max) || width || 1280,
        maxHeight: Number(capabilities.height?.max) || height || 720,
        maxFrameRate: Number(capabilities.frameRate?.max) || frameRate || 30,
        width,
        height,
        frameRate,
        estimated: false
    };
}

export function getCameraCapabilities() {
    return cameraCapabilitiesFromTrack(local.cameraTrack);
}

export function getScreenCapabilities() {
    const track = local.screenVideoTrack?.mediaStreamTrack;
    if (track) {
        const settings = track.getSettings?.() || {};
        const capabilities = track.getCapabilities?.() || {};
        return {
            maxWidth: Number(capabilities.width?.max) || Number(settings.width) || 0,
            maxHeight: Number(capabilities.height?.max) || Number(settings.height) || 0,
            maxFrameRate: Math.max(60, Number(capabilities.frameRate?.max) || 0),
            width: Number(settings.width) || 0,
            height: Number(settings.height) || 0,
            frameRate: Number(settings.frameRate) || 0,
            estimated: false
        };
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round((window.screen?.width || 1920) * dpr);
    const height = Math.round((window.screen?.height || 1080) * dpr);
    return {
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: 60,
        width,
        height,
        frameRate: 60,
        estimated: true
    };
}

export async function setCameraQuality(nextQuality) {
    cameraQuality = normalizeCameraQuality(nextQuality);

    if (!initialized || !local.cameraOn || !local.cameraTrack) {
        return false;
    }

    const mediaTrack = local.cameraTrack.mediaStreamTrack;
    try {
        await mediaTrack.applyConstraints({
            width: { ideal: cameraQuality.width },
            height: { ideal: cameraQuality.height },
            frameRate: {
                ideal: cameraQuality.frameRate,
                max: cameraQuality.frameRate
            }
        });
    } catch (error) {
        console.warn("Onda: camera constraints could not be updated live", error);
    }

    const sender = local.cameraTrack.sender;
    if (sender) {
        try {
            const parameters = sender.getParameters();
            const encodings = parameters.encodings || [];
            const bitrate = Math.round(cameraQuality.bitrateKbps * 1000);
            if (encodings.length === 0) {
                parameters.encodings = [{
                    maxBitrate: bitrate,
                    maxFramerate: cameraQuality.frameRate
                }];
            } else {
                for (const encoding of encodings) {
                    encoding.maxBitrate = bitrate;
                    encoding.maxFramerate = cameraQuality.frameRate;
                }
            }
            await sender.setParameters(parameters);
        } catch (error) {
            console.warn("Onda: camera encoding update failed", error);
        }
    }

    notifyMediaState();
    syncMediaElements();
    return true;
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                        */
/* ------------------------------------------------------------------ */

export function getDiagnostics() {
    const screenPublication = room?.localParticipant?.getTrackPublication(Track.Source.ScreenShare);
    const screenVideoSettings = local.screenVideoTrack?.mediaStreamTrack?.getSettings?.() || null;
    let screenEncodings = null;
    try {
        screenEncodings = local.screenVideoTrack?.sender
            ?.getParameters?.()
            ?.encodings?.map((encoding) => ({
                maxBitrate: encoding.maxBitrate || null,
                maxFramerate: encoding.maxFramerate || null,
                scaleResolutionDownBy: encoding.scaleResolutionDownBy || null,
                active: encoding.active
            })) || null;
    } catch {
        screenEncodings = null;
    }

    return {
        initialized,
        provider: "livekit",
        roomId,
        selfId,
        roomState: room?.state || "disconnected",
        quality: { ...quality },
        local: {
            hasMic: local.hasMic,
            micOn: local.micOn,
            cameraOn: local.cameraOn,
            screenOn: local.screenOn,
            screenWithAudio: local.screenWithAudio,
            screenAudioEnabled: local.screenAudioTrack?.mediaStreamTrack?.enabled ?? null,
            screenTrackId: local.screenVideoTrack?.mediaStreamTrack?.id || null,
            hasPresentation: Boolean(local.presentationTrack)
        },
        localScreen: screenVideoSettings
            ? {
                width: screenVideoSettings.width,
                height: screenVideoSettings.height,
                frameRate: screenVideoSettings.frameRate,
                codec: screenPublication?.codec || null
            }
            : null,
        screenPublication: Boolean(screenPublication),
        screenAudioPublication: Boolean(room?.localParticipant?.getTrackPublication(Track.Source.ScreenShareAudio)),
        screenEncodings,
        remoteParticipants: room ? Array.from(room.remoteParticipants.keys()) : [],
        remoteVideos: Array.from(remoteVideos.keys()),
        remoteAudioSinks: Array.from(remoteAudios.entries()).map(([key, item]) => ({
            key,
            volume: getVolume(key.split(":")[0], item.channel),
            elementVolume: item.element.volume,
            paused: item.element.paused,
            hasStream: Boolean(item.element.srcObject)
        }))
    };
}

/* ------------------------------------------------------------------ */
/* Notifications and cleanup                                          */
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
    if (!initialized || viewerMode) {
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

function notifyAudioBlocked(blocked) {
    if (viewerMode) {
        return;
    }

    if (local.audioBlocked !== blocked) {
        local.audioBlocked = blocked;
        notify("OnAudioPlaybackBlocked", blocked);
    }
}

function resetLocalMediaState() {
    local.micOn = false;
    local.cameraOn = false;
    local.screenOn = false;
    local.screenWithAudio = false;
    local.presentationTrack = null;
    local.presentationKind = null;
    stopSpeakingMonitor(true);
    notifyMediaState();
    syncMediaElements();
}

function stopLocalTrack(track) {
    if (!track) {
        return;
    }

    try {
        track.stop();
    } catch {
        // Already stopped.
    }
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
        default:
            return "Não foi possível compartilhar a tela. Verifique as permissões do navegador.";
    }
}
