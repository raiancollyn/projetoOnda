/* Small global helpers shared by the Blazor pages. */
(function () {
    "use strict";

    const bootSelector = "[data-app-ready]";
    const themeStorageKey = "onda.theme";
    const themePreferences = new Set(["light", "dark", "system"]);
    const themeMedia = window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;

    function readThemePreference() {
        try {
            const value = localStorage.getItem(themeStorageKey);
            return value === "light" || value === "dark" ? value : "system";
        } catch {
            return "system";
        }
    }

    function systemTheme() {
        return themeMedia?.matches ? "dark" : "light";
    }

    function effectiveTheme(preference) {
        return preference === "system" ? systemTheme() : preference;
    }

    function currentPreference() {
        const value = document.documentElement.dataset.themePreference;
        return themePreferences.has(value) ? value : readThemePreference();
    }

    function currentTheme() {
        return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    }

    function updateThemeControls() {
        const preference = currentPreference();
        const effective = currentTheme();
        const effectiveLabel = effective === "dark" ? "escuro" : "claro";

        document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
            if (!(button instanceof HTMLElement)) {
                return;
            }
            const label = preference === "system"
                ? `Tema do sistema (${effectiveLabel}). Opções de tema`
                : `Tema ${effectiveLabel}. Opções de tema`;
            button.setAttribute("aria-label", label);
            button.setAttribute("title", label);
        });

        document.querySelectorAll("[data-theme-choice]").forEach((choice) => {
            if (!(choice instanceof HTMLElement)) {
                return;
            }
            choice.setAttribute("aria-checked", choice.dataset.themeChoice === preference ? "true" : "false");
        });
    }

    function applyTheme(preference, persist) {
        const nextPreference = themePreferences.has(preference) ? preference : "system";
        const nextTheme = effectiveTheme(nextPreference);
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.dataset.themePreference = nextPreference;
        document.documentElement.style.colorScheme = nextTheme;

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute("content", nextTheme === "dark" ? "#0c1916" : "#f7f3eb");
        }

        try {
            window.Capacitor?.Plugins?.OndaMedia?.setTheme({ theme: nextTheme });
        } catch {
            // The native bridge only exists inside the Android app.
        }

        if (persist) {
            try {
                if (nextPreference === "system") {
                    localStorage.removeItem(themeStorageKey);
                } else {
                    localStorage.setItem(themeStorageKey, nextPreference);
                }
            } catch {
                // Private mode may disallow storage; the current page still follows the chosen preference.
            }
        }

        updateThemeControls();
        document.dispatchEvent(new CustomEvent("onda:themechange", {
            detail: { theme: nextTheme, preference: nextPreference }
        }));
    }

    function toggleTheme() {
        applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
    }

    function closeThemeMenus(except) {
        document.querySelectorAll("[data-theme-control]").forEach((control) => {
            if (!(control instanceof HTMLElement) || control === except) {
                return;
            }

            const toggle = control.querySelector("[data-theme-toggle]");
            const menu = control.querySelector("[data-theme-menu]");
            if (menu instanceof HTMLElement) {
                menu.hidden = true;
            }
            if (toggle instanceof HTMLElement) {
                toggle.setAttribute("aria-expanded", "false");
            }
        });
    }

    function openThemeMenu(button, menu) {
        const control = button.closest("[data-theme-control]");
        closeThemeMenus(control);
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");

        const selected = menu.querySelector('[data-theme-choice][aria-checked="true"]')
            || menu.querySelector("[data-theme-choice]");
        if (selected instanceof HTMLElement) {
            selected.focus({ preventScroll: true });
        }
    }

    if (!document.documentElement.dataset.theme) {
        applyTheme(readThemePreference(), false);
    } else {
        if (!document.documentElement.dataset.themePreference) {
            document.documentElement.dataset.themePreference = readThemePreference();
        }
        updateThemeControls();
    }

    document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const choice = target.closest("[data-theme-choice]");
        if (choice instanceof HTMLElement) {
            event.preventDefault();
            applyTheme(choice.dataset.themeChoice, true);
            const control = choice.closest("[data-theme-control]");
            closeThemeMenus();
            control?.querySelector("[data-theme-toggle]")?.focus({ preventScroll: true });
            return;
        }

        const button = target.closest("[data-theme-toggle]");
        if (button instanceof HTMLElement) {
            event.preventDefault();
            updateThemeControls();
            const menu = button.closest("[data-theme-control]")?.querySelector("[data-theme-menu]");
            if (menu instanceof HTMLElement) {
                if (menu.hidden) {
                    openThemeMenu(button, menu);
                } else {
                    menu.hidden = true;
                    button.setAttribute("aria-expanded", "false");
                }
            }
            return;
        }

        if (!target.closest("[data-theme-control]")) {
            closeThemeMenus();
        }
    });

    // O Blazor renderiza o controle depois que este script carrega. Atualiza
    // rótulos e itens marcados assim que o controle aparece (inclusive após
    // navegação interna), sem precisar abrir o menu primeiro.
    let themeControlUpdateScheduled = false;
    const themeControlObserver = new MutationObserver(() => {
        if (themeControlUpdateScheduled) {
            return;
        }

        themeControlUpdateScheduled = true;
        window.requestAnimationFrame(() => {
            themeControlUpdateScheduled = false;
            const control = document.querySelector("[data-theme-toggle]");
            if (control instanceof HTMLElement && control.getAttribute("aria-label") === "Opções de tema") {
                updateThemeControls();
            }
        });
    });
    themeControlObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            const openMenu = document.querySelector("[data-theme-menu]:not([hidden])");
            if (openMenu) {
                const control = openMenu.closest("[data-theme-control]");
                closeThemeMenus();
                control?.querySelector("[data-theme-toggle]")?.focus({ preventScroll: true });
            }
            return;
        }

        const menu = event.target instanceof Element
            ? event.target.closest("[data-theme-menu]")
            : null;
        if (!(menu instanceof HTMLElement) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            return;
        }

        const items = Array.from(menu.querySelectorAll("[data-theme-choice]"))
            .filter((item) => item instanceof HTMLElement);
        if (items.length === 0) {
            return;
        }

        event.preventDefault();
        const currentIndex = items.indexOf(document.activeElement);
        let nextIndex = 0;
        if (event.key === "End") {
            nextIndex = items.length - 1;
        } else if (event.key === "ArrowDown") {
            nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
        } else if (event.key === "ArrowUp") {
            nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
        }
        items[nextIndex].focus({ preventScroll: true });
    });

    if (themeMedia) {
        themeMedia.addEventListener("change", () => {
            if (readThemePreference() === "system") {
                applyTheme("system", false);
            }
        });
    }

    window.addEventListener("storage", (event) => {
        if (event.key !== themeStorageKey) {
            return;
        }

        applyTheme(
            event.newValue === "light" || event.newValue === "dark" ? event.newValue : "system",
            false);
    });


    function removeBootScreen() {
        const boot = document.getElementById("boot-screen");
        if (!boot || boot.dataset.leaving === "true") {
            return;
        }

        boot.dataset.leaving = "true";
        boot.classList.add("boot-screen-leaving");
        window.setTimeout(() => boot.remove(), 650);
    }

    function watchForAppReady() {
        if (document.querySelector(bootSelector)) {
            removeBootScreen();
            return;
        }

        const observer = new MutationObserver(() => {
            if (document.querySelector(bootSelector)) {
                observer.disconnect();
                removeBootScreen();
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", watchForAppReady, { once: true });
    } else {
        watchForAppReady();
    }

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
            return;
        }

        const openModal = document.querySelector(".modal-backdrop");
        if (openModal) {
            const closeButton = openModal.querySelector(".modal-close-button");
            if (closeButton instanceof HTMLElement) {
                closeButton.click();
            }
        }
    });

    // Enter sends chat messages; Shift + Enter keeps a new line.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
            return;
        }

        const target = event.target;
        if (!(target instanceof HTMLTextAreaElement) || !target.matches("[data-chat-input]")) {
            return;
        }

        const form = target.closest("form");
        if (form instanceof HTMLFormElement) {
            event.preventDefault();
            form.requestSubmit();
        }
    });

    async function copyText(text) {
        if (typeof text !== "string" || text.length === 0) {
            return false;
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {
            // Fall back to the selection-based copy path below.
        }

        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        textArea.style.pointerEvents = "none";
        textArea.style.inset = "0";
        document.body.appendChild(textArea);
        textArea.select();
        textArea.setSelectionRange(0, textArea.value.length);

        try {
            return document.execCommand("copy");
        } catch {
            return false;
        } finally {
            textArea.remove();
        }
    }

    function scrollToBottom(element) {
        if (!element) {
            return;
        }

        element.scrollTop = element.scrollHeight;
    }

    function focusElement(element) {
        if (element instanceof HTMLElement) {
            window.setTimeout(() => element.focus(), 20);
        }
    }

    function reloadPage() {
        window.location.reload();
    }

    function isFirefox() {
        return /firefox|fxios/i.test(navigator.userAgent || "");
    }

    const screenQualityKey = "onda.screenQuality.v1";
    const cameraQualityKey = "onda.cameraQuality.v1";

    function readScreenQuality() {
        try {
            return localStorage.getItem(screenQualityKey) || "";
        } catch {
            return "";
        }
    }

    function readCameraQuality() {
        try {
            return localStorage.getItem(cameraQualityKey) || "";
        } catch {
            return "";
        }
    }

    function saveScreenQuality(json) {
        if (typeof json !== "string" || json.length === 0) {
            return false;
        }

        try {
            JSON.parse(json);
            localStorage.setItem(screenQualityKey, json);
            return true;
        } catch {
            return false;
        }
    }

    function saveCameraQuality(json) {
        if (typeof json !== "string" || json.length === 0) {
            return false;
        }

        try {
            JSON.parse(json);
            localStorage.setItem(cameraQualityKey, json);
            return true;
        } catch {
            return false;
        }
    }

    function getScreenEstimate() {
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

    async function shareLink(data) {
        if (!data || !navigator.share) {
            return false;
        }

        try {
            await navigator.share(data);
            return true;
        } catch (error) {
            if (error && error.name === "AbortError") {
                return false;
            }
            return false;
        }
    }

    async function shareRoomLink(data) {
        if (!data?.url) {
            return "failed";
        }

        const plugin = nativeMediaPlugin();
        if (plugin?.shareLink) {
            try {
                const result = await plugin.shareLink(data);
                return result?.shared ? "shared" : "failed";
            } catch {
                return "failed";
            }
        }

        if (window.ondaDesktop?.shareLink) {
            try {
                const result = await window.ondaDesktop.shareLink(data);
                if (result?.cancelled) {
                    return "cancelled";
                }
                if (result?.ok) {
                    return "shared";
                }
                return result?.reason === "unsupported" ? "unsupported" : "failed";
            } catch {
                return "failed";
            }
        }

        if (typeof navigator.share === "function") {
            try {
                await navigator.share(data);
                return "shared";
            } catch (error) {
                return error?.name === "AbortError" ? "aborted" : "failed";
            }
        }

        return "unsupported";
    }

    function resolveFullscreenTarget(target) {
        if (target instanceof Element) {
            return target;
        }

        if (typeof target === "string" && target.length > 0) {
            try {
                return document.querySelector(target);
            } catch {
                return null;
            }
        }

        return null;
    }

    function getFullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    async function exitFullscreen() {
        try {
            if (document.exitFullscreen) {
                await document.exitFullscreen();
                return;
            }

            if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } catch {
            // Some browsers reject exit when the user gesture is no longer active.
        }
    }

    async function toggleFullscreen(target) {
        const element = resolveFullscreenTarget(target);
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        try {
            const current = getFullscreenElement();
            if (current === element) {
                await exitFullscreen();
                return true;
            }

            if (current) {
                await exitFullscreen();
            }

            if (typeof element.requestFullscreen === "function") {
                await element.requestFullscreen();
                return true;
            }

            if (typeof element.webkitRequestFullscreen === "function") {
                element.webkitRequestFullscreen();
                return true;
            }
        } catch {
            return false;
        }

        return false;
    }

    const hasCoarsePointer = window.matchMedia?.("(hover: none)")?.matches ?? false;
    const overlayHideDelay = hasCoarsePointer ? 5000 : 3000;
    const overlayTimers = new WeakMap();

    function getMediaShell(target) {
        return target instanceof Element ? target.closest("[data-media-shell]") : null;
    }

    function clearOverlayTimer(shell) {
        const timer = overlayTimers.get(shell);
        if (timer) {
            window.clearTimeout(timer);
            overlayTimers.delete(shell);
        }
    }

    function hideMediaOverlays(shell) {
        if (!(shell instanceof HTMLElement)) {
            return;
        }

        clearOverlayTimer(shell);
        shell.classList.add("is-overlay-hidden");
    }

    function armOverlayTimer(shell) {
        clearOverlayTimer(shell);

        const timer = window.setTimeout(() => {
            overlayTimers.delete(shell);
            if (!shell.isConnected) {
                return;
            }

            const fullscreenButton = shell.querySelector(".media-fullscreen-button");
            if (fullscreenButton instanceof HTMLElement && fullscreenButton.matches(":hover")) {
                armOverlayTimer(shell);
                return;
            }

            const activeElement = document.activeElement;
            if (
                shell.contains(activeElement) &&
                activeElement instanceof HTMLElement &&
                activeElement.matches(":focus-visible")
            ) {
                armOverlayTimer(shell);
                return;
            }

            shell.classList.add("is-overlay-hidden");
        }, overlayHideDelay);

        overlayTimers.set(shell, timer);
    }

    function showMediaOverlays(shell) {
        if (!(shell instanceof HTMLElement)) {
            return;
        }

        shell.classList.remove("is-overlay-hidden");
        armOverlayTimer(shell);
    }

    function initMediaShells() {
        document.querySelectorAll("[data-media-shell]").forEach((shell) => {
            if (!(shell instanceof HTMLElement) || shell.dataset.overlayReady === "true") {
                return;
            }

            shell.dataset.overlayReady = "true";
            showMediaOverlays(shell);
        });
    }

    let overlayScanScheduled = false;

    function scheduleOverlayScan() {
        if (overlayScanScheduled) {
            return;
        }

        overlayScanScheduled = true;
        window.requestAnimationFrame(() => {
            overlayScanScheduled = false;
            initMediaShells();
        });
    }

    document.addEventListener("pointermove", (event) => {
        const shell = getMediaShell(event.target);
        if (shell) {
            showMediaOverlays(shell);
        }
    }, { passive: true });

    document.addEventListener("pointerdown", (event) => {
        const shell = getMediaShell(event.target);
        if (shell) {
            showMediaOverlays(shell);
        }
    }, { passive: true });

    document.addEventListener("pointerout", (event) => {
        // Touch browsers fire pointerout as soon as the finger leaves the
        // glass, even when the tap landed inside the tile. Hiding here would
        // make the controls disappear in the same instant the user reveals
        // them. On touch devices the inactivity timer is responsible.
        if (hasCoarsePointer || event.pointerType === "touch") {
            return;
        }

        const from = getMediaShell(event.target);
        if (!from || getMediaShell(event.relatedTarget) === from) {
            return;
        }

        hideMediaOverlays(from);
    });

    document.addEventListener("focusin", (event) => {
        const shell = getMediaShell(event.target);
        if (shell) {
            showMediaOverlays(shell);
        }
    });

    document.addEventListener("focusout", (event) => {
        const shell = getMediaShell(event.target);
        if (!shell) {
            return;
        }

        window.setTimeout(() => {
            if (!shell.contains(document.activeElement)) {
                hideMediaOverlays(shell);
            }
        }, 0);
    });

    function handleFullscreenChange() {
        const fullscreenElement = getFullscreenElement();
        if (!(fullscreenElement instanceof HTMLElement)) {
            return;
        }

        const shell = fullscreenElement.matches("[data-media-shell]")
            ? fullscreenElement
            : fullscreenElement.querySelector("[data-media-shell]");

        if (shell) {
            showMediaOverlays(shell);
        }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    const overlayObserver = new MutationObserver(scheduleOverlayScan);

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            initMediaShells();
            overlayObserver.observe(document.documentElement, { childList: true, subtree: true });
        }, { once: true });
    } else {
        initMediaShells();
        overlayObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function installDesktopCapture() {
        const bridge = window.ondaDesktop;
        if (!bridge?.isDesktop || !navigator.mediaDevices?.getDisplayMedia) {
            return;
        }

        const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        let activeCleanup = null;
        let sequence = 0;

        function createCaptureId() {
            if (window.crypto?.randomUUID) {
                return window.crypto.randomUUID();
            }
            sequence += 1;
            return `onda-${Date.now()}-${sequence}`;
        }

        function toBytes(data) {
            if (data instanceof Uint8Array) {
                return data;
            }
            if (data instanceof ArrayBuffer) {
                return new Uint8Array(data);
            }
            if (ArrayBuffer.isView(data)) {
                return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            }
            return null;
        }

        function appendBytes(pending, bytes) {
            if (pending.length === 0) {
                return bytes;
            }
            const combined = new Uint8Array(pending.length + bytes.length);
            combined.set(pending, 0);
            combined.set(bytes, pending.length);
            return combined;
        }

        async function createNativeAudio(selection) {
            const captureId = createCaptureId();
            const sampleRate = 48000;
            const channels = 2;
            const frameBytes = channels * Float32Array.BYTES_PER_ELEMENT;
            let pending = new Uint8Array(0);
            let nextStartTime = 0;
            let closed = false;

            const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
            const destination = context.createMediaStreamDestination();

            const unsubscribe = bridge.onAudioData((payload) => {
                if (closed || payload?.captureId !== captureId) {
                    return;
                }

                const bytes = toBytes(payload.data);
                if (!bytes || bytes.length === 0) {
                    return;
                }

                pending = appendBytes(pending, bytes);
                const usableLength = pending.length - (pending.length % frameBytes);
                if (usableLength === 0) {
                    return;
                }

                const complete = pending.subarray(0, usableLength);
                pending = pending.subarray(usableLength);

                const aligned = new Uint8Array(complete.length);
                aligned.set(complete);
                const floats = new Float32Array(aligned.buffer);
                const frames = Math.floor(floats.length / channels);
                if (frames === 0) {
                    return;
                }

                const buffer = context.createBuffer(channels, frames, sampleRate);
                for (let channel = 0; channel < channels; channel += 1) {
                    const output = buffer.getChannelData(channel);
                    for (let frame = 0; frame < frames; frame += 1) {
                        output[frame] = floats[frame * channels + channel];
                    }
                }

                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(destination);

                const now = context.currentTime;
                if (nextStartTime < now + 0.03 || nextStartTime > now + 0.8) {
                    nextStartTime = now + 0.09;
                }
                source.start(nextStartTime);
                nextStartTime += buffer.duration;
            });

            const cleanup = () => {
                if (closed) {
                    return;
                }
                closed = true;
                try {
                    unsubscribe();
                } catch {
                    // Ignore a bridge that already closed.
                }
                try {
                    bridge.stopAudio(captureId).catch(() => { });
                } catch {
                    // Ignore.
                }
                try {
                    context.close();
                } catch {
                    // Ignore.
                }
            };

            try {
                await context.resume();
                const info = await bridge.startAudio({
                    captureId,
                    pid: Number(selection.processId),
                    mode: selection.audioMode
                });
                if (info?.sampleRate && Number(info.sampleRate) !== sampleRate) {
                    console.warn("O OndaCapture iniciou com uma taxa de amostragem diferente:", info.sampleRate);
                }
            } catch (error) {
                cleanup();
                throw error;
            }

            return {
                track: destination.stream.getAudioTracks()[0],
                cleanup
            };
        }

        async function legacyDesktopVideo(sourceId) {
            return navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: sourceId,
                        maxWidth: 3840,
                        maxHeight: 2160,
                        maxFrameRate: 60
                    }
                }
            });
        }

        async function createNativeVideoGenerator(selection) {
            if (typeof window.MediaStreamTrackGenerator !== "function" ||
                typeof window.VideoFrame !== "function") {
                throw new Error("MediaStreamTrackGenerator indisponível.");
            }

            const captureId = createCaptureId();
            const width = 960;
            const height = 540;
            const fps = 60;
            const frameDuration = Math.round(1000000 / fps);
            const generator = new window.MediaStreamTrackGenerator({ kind: "video" });
            const writer = generator.writable.getWriter();
            const stream = new window.MediaStream([generator]);
            const videoTrack = stream.getVideoTracks()[0];
            let stopped = false;
            let drawing = false;
            let queuedFrame = null;
            let lastTimestamp = 0;

            const drawFrame = async (data) => {
                if (stopped || drawing) {
                    queuedFrame = data;
                    return;
                }

                drawing = true;
                let bitmap = null;
                let sourceFrame = null;
                let frame = null;
                try {
                    if (typeof window.ImageDecoder === "function") {
                        const decoder = new window.ImageDecoder({
                            data,
                            type: "image/jpeg"
                        });
                        const result = await decoder.decode();
                        sourceFrame = result.image;
                        decoder.close();
                    } else {
                        bitmap = await window.createImageBitmap(new Blob([data], { type: "image/jpeg" }));
                        sourceFrame = bitmap;
                    }

                    const now = Math.round(performance.now() * 1000);
                    lastTimestamp = Math.max(lastTimestamp + frameDuration, now);
                    frame = new window.VideoFrame(sourceFrame, {
                        timestamp: lastTimestamp,
                        duration: frameDuration
                    });
                    await writer.write(frame);
                } catch (error) {
                    if (!stopped) {
                        console.warn("Quadro de vídeo inválido no gerador de faixa.", error);
                    }
                } finally {
                    frame?.close?.();
                    sourceFrame?.close?.();
                    bitmap?.close?.();
                    drawing = false;
                    if (queuedFrame && !stopped) {
                        const next = queuedFrame;
                        queuedFrame = null;
                        void drawFrame(next);
                    }
                }
            };

            const unsubscribeFrame = bridge.onNativeVideoFrame((payload) => {
                if (stopped || payload?.captureId !== captureId || !payload?.data) {
                    return;
                }
                void drawFrame(payload.data);
            });

            const unsubscribeStopped = bridge.onNativeVideoStopped((payload) => {
                if (payload?.captureId === captureId) {
                    cleanup();
                }
            });

            const cleanup = () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    unsubscribeFrame();
                } catch {
                    // Ignore.
                }
                try {
                    unsubscribeStopped();
                } catch {
                    // Ignore.
                }
                try {
                    bridge.stopNativeVideo(captureId).catch(() => { });
                } catch {
                    // Ignore.
                }
                try {
                    writer.close();
                } catch {
                    // Ignore.
                }
                try {
                    generator.stop();
                } catch {
                    // Ignore.
                }
            };

            try {
                await bridge.startNativeVideo({
                    captureId,
                    sourceId: selection.sourceId,
                    fps,
                    width,
                    height
                });
            } catch (error) {
                cleanup();
                throw error;
            }

            if (!videoTrack) {
                cleanup();
                throw new Error("O gerador de faixa não criou o vídeo.");
            }

            stream.__ondaCleanup = cleanup;
            console.info("Compartilhamento usando MediaStreamTrackGenerator + captura GDI.");
            return stream;
        }

        async function createNativeVideo(selection) {
            if (typeof window.MediaStreamTrackGenerator === "function" &&
                typeof window.VideoFrame === "function") {
                try {
                    return await createNativeVideoGenerator(selection);
                } catch (error) {
                    console.warn("Gerador de faixa falhou; usando canvas.", error);
                }
            }

            return createNativeVideoCanvas(selection);
        }

        async function createNativeVideoCanvas(selection) {
            if (!window.HTMLCanvasElement?.prototype.captureStream) {
                throw new Error("Canvas captureStream não está disponível.");
            }

            const captureId = createCaptureId();
            const width = 1280;
            const height = 720;
            const fps = 60;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context2d = canvas.getContext("2d", { alpha: false });
            context2d.fillStyle = "#0c1916";
            context2d.fillRect(0, 0, width, height);

            const stream = canvas.captureStream(fps);
            const videoTrack = stream.getVideoTracks()[0];
            let stopped = false;
            let drawing = false;
            let queuedFrame = null;

            const drawFrame = async (data) => {
                if (stopped || drawing) {
                    queuedFrame = data;
                    return;
                }

                drawing = true;
                let bitmap = null;
                try {
                    bitmap = await window.createImageBitmap(new Blob([data], { type: "image/jpeg" }));
                    if (!stopped) {
                        context2d.drawImage(bitmap, 0, 0, width, height);
                    }
                } catch (error) {
                    console.warn("Quadro de vídeo inválido.", error);
                } finally {
                    bitmap?.close?.();
                    drawing = false;
                    if (queuedFrame && !stopped) {
                        const next = queuedFrame;
                        queuedFrame = null;
                        void drawFrame(next);
                    }
                }
            };

            const unsubscribeFrame = bridge.onNativeVideoFrame((payload) => {
                if (stopped || payload?.captureId !== captureId || !payload?.data) {
                    return;
                }
                void drawFrame(payload.data);
            });

            const unsubscribeStopped = bridge.onNativeVideoStopped((payload) => {
                if (payload?.captureId === captureId) {
                    cleanup();
                }
            });

            const cleanup = () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    unsubscribeFrame();
                } catch {
                    // Ignore.
                }
                try {
                    unsubscribeStopped();
                } catch {
                    // Ignore.
                }
                try {
                    bridge.stopNativeVideo(captureId).catch(() => { });
                } catch {
                    // Ignore.
                }
                stream.getTracks().forEach((track) => track.stop());
            };

            try {
                await bridge.startNativeVideo({
                    captureId,
                    sourceId: selection.sourceId,
                    fps,
                    width,
                    height
                });
            } catch (error) {
                cleanup();
                throw error;
            }

            if (!videoTrack) {
                cleanup();
                throw new Error("A captura nativa não criou a faixa de vídeo.");
            }

            stream.__ondaCleanup = cleanup;
            console.info("Compartilhamento usando o capturador nativo de vídeo (GDI).");
            return stream;
        }

        async function createThumbnailVideo(selection) {
            if (!window.HTMLCanvasElement?.prototype.captureStream) {
                throw new Error("Canvas captureStream não está disponível.");
            }

            const captureId = createCaptureId();
            const width = 1280;
            const height = 720;
            const fps = 15;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context2d = canvas.getContext("2d", { alpha: false });
            context2d.fillStyle = "#0c1916";
            context2d.fillRect(0, 0, width, height);

            const stream = canvas.captureStream(fps);
            const videoTrack = stream.getVideoTracks()[0];
            let stopped = false;
            let framePending = false;

            const unsubscribe = bridge.onThumbnailFrame((payload) => {
                if (stopped || payload?.captureId !== captureId || framePending || !payload?.dataUrl) {
                    return;
                }

                framePending = true;
                const image = new Image();
                image.onload = () => {
                    framePending = false;
                    if (!stopped) {
                        context2d.drawImage(image, 0, 0, width, height);
                    }
                };
                image.onerror = () => {
                    framePending = false;
                };
                image.src = payload.dataUrl;
            });

            const cleanup = () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    unsubscribe();
                } catch {
                    // Ignore.
                }
                try {
                    bridge.stopThumbnailCapture(captureId).catch(() => { });
                } catch {
                    // Ignore.
                }
                stream.getTracks().forEach((track) => track.stop());
            };

            try {
                await bridge.startThumbnailCapture({
                    captureId,
                    sourceId: selection.sourceId,
                    fps,
                    width,
                    height
                });
            } catch (error) {
                cleanup();
                throw error;
            }

            if (!videoTrack) {
                cleanup();
                throw new Error("O modo de compatibilidade não criou a faixa de vídeo.");
            }

            stream.__ondaCleanup = cleanup;
            console.info("Compartilhamento usando o modo de compatibilidade por quadros (GDI).");
            return stream;
        }

        async function requestDesktopVideo(constraints) {
            try {
                return await originalGetDisplayMedia({
                    ...constraints,
                    audio: false
                });
            } catch (error) {
                const selection = await bridge.getCaptureSelection().catch(() => null);
                if (!selection?.sourceId) {
                    throw error;
                }

                console.warn("getDisplayMedia falhou; tentando a captura desktop legada.", error);
                try {
                    return await legacyDesktopVideo(selection.sourceId);
                } catch (legacyError) {
                    console.warn("A captura legada também falhou; usando capturador nativo.", legacyError);
                }

                try {
                    return await createNativeVideo(selection);
                } catch (nativeError) {
                    console.warn("O capturador nativo falhou; usando quadros GDI.", nativeError);
                }

                try {
                    return await createThumbnailVideo(selection);
                } catch (thumbnailError) {
                    console.error("A captura por quadros também falhou.", thumbnailError);
                    throw error;
                }
            }
        }

        async function desktopGetDisplayMedia(constraints = {}) {
            const previousCleanup = activeCleanup;
            const videoStream = await requestDesktopVideo(constraints);
            const videoTrack = videoStream.getVideoTracks()[0];
            const fallbackCleanup = videoStream.__ondaCleanup;

            if (previousCleanup) {
                activeCleanup = null;
                try {
                    previousCleanup();
                } catch {
                    // Ignore cleanup races.
                }
            }

            if (!videoTrack) {
                videoStream.getTracks().forEach((track) => track.stop());
                fallbackCleanup?.();
                throw new DOMException("Nenhuma faixa de vídeo foi retornada.", "NotSupportedError");
            }

            let nativeAudio = null;
            try {
                const selection = await bridge.getCaptureSelection();
                const hasNativeAudio = selection &&
                    (selection.audioMode === "system" || Number(selection.processId) > 0);
                if (hasNativeAudio) {
                    nativeAudio = await createNativeAudio(selection);
                }
            } catch (error) {
                console.warn("Áudio nativo indisponível; compartilhando somente o vídeo.", error);
            }

            const stream = new MediaStream([videoTrack]);
            if (nativeAudio?.track) {
                stream.addTrack(nativeAudio.track);
            }

            let stopped = false;
            let timer = null;
            const cleanup = () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                if (timer) {
                    window.clearInterval(timer);
                }
                try {
                    fallbackCleanup?.();
                } catch {
                    // Ignore.
                }
                try {
                    nativeAudio?.cleanup();
                } catch {
                    // Ignore.
                }
                if (activeCleanup === cleanup) {
                    activeCleanup = null;
                }
            };

            timer = window.setInterval(() => {
                if (videoTrack.readyState === "ended" ||
                    stream.getAudioTracks().some((track) => track.readyState === "ended")) {
                    cleanup();
                }
            }, 500);

            videoTrack.addEventListener("ended", cleanup, { once: true });
            activeCleanup = cleanup;
            return stream;
        }

        navigator.mediaDevices.getDisplayMedia = desktopGetDisplayMedia;
        console.info("Captura desktop ativada: seletor nativo + áudio por aplicativo.");
    }

    installDesktopCapture();

    let deferredInstallPrompt = null;

    function isStandalonePwa() {
        return Boolean(
            window.matchMedia?.("(display-mode: standalone)").matches ||
            window.navigator.standalone === true
        );
    }

    function isIosDevice() {
        return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    }

    function isMobileDevice() {
        if (navigator.userAgentData?.mobile === true) {
            return true;
        }

        return /android|iphone|ipad|ipod|iemobile|opera mini|mobile/i.test(navigator.userAgent || "") ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    }

    function getInstallContext() {
        return {
            isDesktopApp: Boolean(window.ondaDesktop?.isDesktop),
            isStandalone: isStandalonePwa(),
            isMobile: isMobileDevice()
        };
    }

    let wakeLockSentinel = null;
    let wakeLockRequested = false;

    async function requestWakeLock() {
        if (!wakeLockRequested ||
            document.visibilityState !== "visible" ||
            !("wakeLock" in navigator)) {
            return false;
        }

        if (wakeLockSentinel && !wakeLockSentinel.released) {
            return true;
        }

        try {
            wakeLockSentinel = await navigator.wakeLock.request("screen");
            wakeLockSentinel.addEventListener("release", () => {
                wakeLockSentinel = null;
            }, { once: true });
            return true;
        } catch {
            wakeLockSentinel = null;
            return false;
        }
    }

    async function setWakeLock(enabled) {
        wakeLockRequested = Boolean(enabled);

        if (wakeLockRequested) {
            return requestWakeLock();
        }

        if (wakeLockSentinel) {
            try {
                await wakeLockSentinel.release();
            } catch {
                // The browser may have released it already.
            }
        }

        wakeLockSentinel = null;
        return true;
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && wakeLockRequested) {
            void requestWakeLock();
        }
    });

    window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
    });

    window.addEventListener("appinstalled", () => {
        deferredInstallPrompt = null;
    });

    async function installPwa() {
        if (isStandalonePwa()) {
            return "installed";
        }

        if (!deferredInstallPrompt) {
            return isIosDevice() ? "ios" : "unavailable";
        }

        const prompt = deferredInstallPrompt;
        deferredInstallPrompt = null;

        try {
            prompt.prompt();
            const choice = await prompt.userChoice;
            return choice?.outcome || "dismissed";
        } catch {
            return "unavailable";
        }
    }

    function setPwaNote(result) {
        const note = document.querySelector("[data-pwa-note]");
        if (!(note instanceof HTMLElement)) {
            return;
        }

        note.textContent = result === "accepted"
            ? "Instalação iniciada. Confirme no navegador."
            : result === "dismissed"
                ? "Instalação cancelada. Você pode tentar de novo quando quiser."
                : result === "installed"
                    ? "Você já está usando o web app instalado."
                    : result === "ios"
                        ? "No iPhone ou iPad, toque em Compartilhar → Adicionar à Tela de Início."
                        : "No menu do navegador, escolha “Instalar Onda” ou “Adicionar à tela inicial”.";
    }

    document.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const button = target.closest("[data-install-pwa]");
        if (!(button instanceof HTMLElement)) {
            return;
        }

        event.preventDefault();
        setPwaNote(await installPwa());
    });

    if (isStandalonePwa()) {
        setPwaNote("installed");
    }

    function registerServiceWorker() {
        if (!("serviceWorker" in navigator) || !window.isSecureContext) {
            return;
        }

        navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
            .catch((error) => console.warn("Onda: service worker não registrado", error));
    }

    if (document.readyState === "complete") {
        registerServiceWorker();
    } else {
        window.addEventListener("load", registerServiceWorker, { once: true });
    }

    function nativeMediaPlugin() {
        return window.Capacitor?.Plugins?.OndaMedia || null;
    }

    function isNativeMobile() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        try {
            return window.Capacitor?.isNativePlatform?.() !== false &&
                window.Capacitor?.getPlatform?.() === "android";
        } catch {
            return true;
        }
    }

    async function startNativeCall(url, token, roomId, guestId, presenceUrl, guestName, avatarTone, cameraQuality) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            throw new Error("Ponte nativa de mídia indisponível.");
        }

        const result = await plugin.startCall({
            url,
            token,
            roomId,
            guestId,
            presenceUrl,
            guestName,
            avatarTone,
            cameraQuality
        });

        window.setTimeout(() => {
            void applyNativeAudioPreferences(plugin);
        }, 1500);

        return result;
    }

    async function stopNativeCall() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return;
        }

        return plugin.stopCallService();
    }

    async function setNativeMic(enabled) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            throw new Error("Ponte nativa de mídia indisponível.");
        }

        return plugin.setMic({ enabled: Boolean(enabled) });
    }

    async function setNativeCamera(enabled) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            throw new Error("Ponte nativa de mídia indisponível.");
        }

        const result = await plugin.setCamera({ enabled: Boolean(enabled) });
        return Boolean(result?.enabled);
    }

    async function getNativeCamera() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.getCamera();
        return Boolean(result?.enabled);
    }

    async function startNativeScreenShare(quality) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.startScreenShare({ quality });
        return Boolean(result?.requested);
    }

    async function stopNativeScreenShare() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.stopScreenShare();
        return Boolean(result?.requested);
    }

    async function getNativeScreenShare() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.getScreenShare();
        return Boolean(result?.enabled);
    }

    async function setNativeScreenQuality(width, height, frameRate, bitrateKbps) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.setScreenQuality({
            width: Math.round(Number(width) || 1920),
            height: Math.round(Number(height) || 1080),
            frameRate: Math.round(Number(frameRate) || 30),
            bitrateKbps: Math.round(Number(bitrateKbps) || 4000)
        });
        return Boolean(result?.applied);
    }

    async function getNativeRnnoise() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return true;
        }

        const result = await plugin.getAudioProcessing();
        return result?.rnnoise !== false;
    }

    async function setNativeRnnoise(enabled) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const value = Boolean(enabled);
        const result = await plugin.setAudioProcessing({ rnnoise: value });
        return result?.rnnoise === value;
    }

    async function getNativeCameraOptions() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return null;
        }

        return plugin.getCameraOptions();
    }

    async function switchNativeCamera(deviceId) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.switchCamera({ deviceId: deviceId || "" });
        return Boolean(result?.changed);
    }

    async function setNativeCameraTorch(enabled) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.setCameraTorch({ enabled: Boolean(enabled) });
        return Boolean(result?.changed);
    }

    async function setNativeCameraQuality(width, height, frameRate, bitrateKbps) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.setCameraQuality({
            width: Math.round(Number(width) || 1280),
            height: Math.round(Number(height) || 720),
            frameRate: Math.round(Number(frameRate) || 30),
            bitrateKbps: Math.round(Number(bitrateKbps) || 1500)
        });
        return Boolean(result?.applied);
    }

    let nativeMicDotNetRef = null;
    let nativeMicSyncInstalled = false;

    let exitGuardRef = null;
    let exitGuardActive = false;
    let exitGuardUrl = "";
    let exitGuardPrompting = false;

    function registerExitGuard(dotNetRef) {
        exitGuardRef = dotNetRef;
    }

    function handleBeforeUnload(event) {
        if (!exitGuardActive) {
            return;
        }

        event.preventDefault();
        event.returnValue = "";
        return "";
    }

    function handleExitPopState() {
        if (!exitGuardActive) {
            return;
        }

        try {
            history.pushState({ ondaRoom: true }, "", exitGuardUrl || location.href);
        } catch {
            // History may be unavailable in an embedded webview.
        }

        if (exitGuardPrompting || !exitGuardRef) {
            return;
        }

        exitGuardPrompting = true;
        const finish = () => {
            exitGuardPrompting = false;
        };

        try {
            Promise.resolve(exitGuardRef.invokeMethodAsync("OnExitRequested"))
                .then(finish, finish);
        } catch {
            finish();
        }
    }

    function setRoomExitGuard(enabled) {
        if (enabled) {
            if (exitGuardActive) {
                return;
            }

            exitGuardActive = true;
            exitGuardPrompting = false;
            exitGuardUrl = location.href;
            try {
                history.pushState({ ondaRoom: true }, "", exitGuardUrl);
            } catch {
                // The guard still works through beforeunload.
            }
            if (!isNativeMobile() && !window.ondaDesktop?.isDesktop) {
                window.addEventListener("beforeunload", handleBeforeUnload);
            }
            window.addEventListener("popstate", handleExitPopState);
            return;
        }

        exitGuardActive = false;
        exitGuardPrompting = false;
        window.removeEventListener("beforeunload", handleBeforeUnload);
        window.removeEventListener("popstate", handleExitPopState);
        try {
            history.replaceState(null, "", location.href);
        } catch {
            // Ignore history failures during teardown.
        }
    }

    async function syncNativeMicState() {
        const plugin = nativeMediaPlugin();
        if (!nativeMicDotNetRef || !plugin) {
            return;
        }

        try {
            const [mic, camera, screen] = await Promise.all([
                plugin.getMic(),
                plugin.getCamera(),
                plugin.getScreenShare()
            ]);
            await nativeMicDotNetRef.invokeMethodAsync("OnNativeMicChanged", Boolean(mic?.enabled));
            await nativeMicDotNetRef.invokeMethodAsync("OnNativeCameraChanged", Boolean(camera?.enabled));
            await nativeMicDotNetRef.invokeMethodAsync("OnNativeScreenChanged", Boolean(screen?.enabled));
        } catch {
            // The WebView may be gone or the call may have ended.
        }
    }

    function registerNativeMicListener(dotNetRef) {
        nativeMicDotNetRef = dotNetRef;
        if (!nativeMicSyncInstalled) {
            nativeMicSyncInstalled = true;
            document.addEventListener("visibilitychange", () => {
                if (!document.hidden) {
                    void syncNativeMicState();
                }
            });
            window.addEventListener("focus", () => void syncNativeMicState());
            window.setInterval(() => {
                if (!document.hidden) {
                    void syncNativeMicState();
                }
            }, 10_000);
        }

        window.setTimeout(() => void syncNativeMicState(), 300);
    }

    async function getNativeMic() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return false;
        }

        const result = await plugin.getMic();
        return Boolean(result?.enabled);
    }

    const nativeAudioPrefsKey = "onda.audio.native";

    function readNativeAudioPreferences() {
        try {
            const parsed = JSON.parse(localStorage.getItem(nativeAudioPrefsKey) || "null");
            return {
                route: typeof parsed?.route === "string" ? parsed.route : "",
                volume: Number.isFinite(Number(parsed?.volume))
                    ? Math.min(100, Math.max(0, Math.round(Number(parsed.volume))))
                    : 100
            };
        } catch {
            return { route: "", volume: 100 };
        }
    }

    function saveNativeAudioPreferences(next) {
        try {
            const previous = readNativeAudioPreferences();
            localStorage.setItem(nativeAudioPrefsKey, JSON.stringify({
                route: next.route ?? previous.route,
                volume: next.volume ?? previous.volume
            }));
        } catch {
            // Storage may be unavailable in private mode.
        }
    }

    async function selectNativeAudioRoute(plugin, id) {
        if (!plugin || !id) {
            return false;
        }

        try {
            const result = await plugin.selectAudioDevice({ id });
            return Boolean(result?.selected);
        } catch {
            return false;
        }
    }

    async function applyNativeAudioPreferences(plugin) {
        if (!plugin) {
            return;
        }

        const preferences = readNativeAudioPreferences();
        for (let attempt = 0; attempt < 6; attempt += 1) {
            try {
                const response = await plugin.getAudioDevices();
                const devices = Array.isArray(response?.devices) ? response.devices : [];
                let route = preferences.route;

                if (route && !devices.some((device) => device.id === route)) {
                    // Keep the saved route for when the headset returns, but
                    // use the speaker now so the user is not left without audio.
                    route = "Speakerphone";
                }

                if (route) {
                    const selected = await selectNativeAudioRoute(plugin, route);
                    if (!selected && route !== "Speakerphone") {
                        await selectNativeAudioRoute(plugin, "Speakerphone");
                    }
                }

                await plugin.setOutputVolume({ percent: preferences.volume });
                return;
            } catch {
                if (attempt < 5) {
                    await new Promise((resolve) => window.setTimeout(resolve, 1000));
                }
            }
        }
    }

    async function getNativeAudioDevices() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            throw new Error("Ponte nativa de mídia indisponível.");
        }

        return JSON.stringify(await plugin.getAudioDevices());
    }

    async function selectNativeAudioDevice(id) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            throw new Error("Ponte nativa de mídia indisponível.");
        }

        const result = await plugin.selectAudioDevice({ id });
        if (result?.selected) {
            saveNativeAudioPreferences({ route: id });
        }
        return result;
    }

    async function getNativeOutputVolume() {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return 100;
        }

        return (await plugin.getOutputVolume()).percent;
    }

    async function setNativeOutputVolume(percent) {
        const plugin = nativeMediaPlugin();
        if (!plugin) {
            return;
        }

        const value = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
        const result = await plugin.setOutputVolume({ percent: value });
        saveNativeAudioPreferences({ volume: value });
        return result;
    }

    let presenceHeartbeatTimer = null;
    let presenceHeartbeatRoom = null;
    let presenceHeartbeatGuest = null;
    let visibilityDotNetRef = null;
    let visibilityListenerInstalled = false;

    function registerVisibilityListener(dotNetRef) {
        visibilityDotNetRef = dotNetRef;
        if (visibilityListenerInstalled) {
            return;
        }

        visibilityListenerInstalled = true;
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && visibilityDotNetRef) {
                void visibilityDotNetRef.invokeMethodAsync("OnPageVisible").catch(() => {
                    // The Blazor circuit may be reconnecting.
                });
            }
        });
    }

    function stopPresenceHeartbeat() {
        if (presenceHeartbeatTimer) {
            clearTimeout(presenceHeartbeatTimer);
            presenceHeartbeatTimer = null;
        }
        presenceHeartbeatRoom = null;
        presenceHeartbeatGuest = null;
    }

    function startPresenceHeartbeat(roomId, guestId) {        stopPresenceHeartbeat();
        if (!roomId || !guestId) {
            return;
        }

        presenceHeartbeatRoom = roomId;
        presenceHeartbeatGuest = guestId;
        const ping = async () => {
            if (!presenceHeartbeatRoom || !presenceHeartbeatGuest) {
                return;
            }

            try {
                await fetch("/api/presence/heartbeat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        roomId: presenceHeartbeatRoom,
                        guestId: presenceHeartbeatGuest
                    }),
                    keepalive: true
                });
            } catch {
                // The janitor will remove the participant if the app disappears.
            }

            if (presenceHeartbeatRoom) {
                presenceHeartbeatTimer = setTimeout(ping, 30000);
            }
        };

        void ping();
    }

    let pullStartY = null;
    let pullDistance = 0;
    let pullIndicator = null;

    function installPullToRefresh() {
        if (window.__ondaPullToRefreshInstalled || !isNativeMobile()) {
            return;
        }

        window.__ondaPullToRefreshInstalled = true;

        pullIndicator = document.createElement("div");
        pullIndicator.className = "onda-pull-refresh";
        pullIndicator.setAttribute("role", "status");
        pullIndicator.setAttribute("aria-live", "polite");
        pullIndicator.innerHTML =
            '<span class="onda-pull-refresh-spinner" aria-hidden="true"></span>' +
            '<span class="onda-pull-refresh-label">Puxe para atualizar</span>';
        document.body.appendChild(pullIndicator);

        const label = pullIndicator.querySelector(".onda-pull-refresh-label");
        const threshold = 72;

        const resetPull = () => {
            pullStartY = null;
            pullDistance = 0;
            if (!pullIndicator) {
                return;
            }

            pullIndicator.classList.remove("is-visible", "is-loading");
            pullIndicator.style.transform = "";
            if (label) {
                label.textContent = "Puxe para atualizar";
            }
        };

        const showPull = (distance) => {
            if (!pullIndicator) {
                return;
            }

            const offset = Math.min(64, distance * 0.55);
            pullIndicator.classList.add("is-visible");
            pullIndicator.style.transform = `translate(-50%, ${offset}px)`;
            if (label) {
                label.textContent = distance >= threshold
                    ? "Solte para atualizar"
                    : "Puxe para atualizar";
            }
        };

        const finishPull = () => {
            const shouldRefresh = pullDistance >= threshold;
            const roomActive = exitGuardActive && Boolean(document.querySelector(".room-app"));
            const distance = pullDistance;
            resetPull();

            if (!shouldRefresh) {
                return;
            }

            if (roomActive) {
                if (exitGuardRef) {
                    try {
                        Promise.resolve(exitGuardRef.invokeMethodAsync("OnRefreshRequested"))
                            .catch(() => { });
                    } catch {
                        // The circuit may already be gone.
                    }
                }
                return;
            }

            if (pullIndicator) {
                pullIndicator.classList.add("is-visible", "is-loading");
                if (label) {
                    label.textContent = "Atualizando...";
                }
            }
            window.setTimeout(() => location.reload(), distance > 0 ? 140 : 0);
        };

        document.addEventListener("touchstart", (event) => {
            if (event.touches.length !== 1 || window.scrollY > 0) {
                return;
            }

            if (document.querySelector(".modal-card, .modal-backdrop, [role='dialog']")) {
                return;
            }

            const target = event.target;
            if (target instanceof Element &&
                target.closest("input, textarea, select, button, a, [contenteditable='true']")) {
                return;
            }

            pullStartY = event.touches[0].clientY;
            pullDistance = 0;
        }, { passive: true });

        document.addEventListener("touchmove", (event) => {
            if (pullStartY === null || event.touches.length !== 1) {
                return;
            }

            const deltaY = event.touches[0].clientY - pullStartY;
            if (deltaY <= 0) {
                resetPull();
                return;
            }

            if (event.cancelable) {
                event.preventDefault();
            }

            pullDistance = deltaY;
            showPull(pullDistance);
        }, { passive: false });

        document.addEventListener("touchend", finishPull, { passive: true });
        document.addEventListener("touchcancel", resetPull, { passive: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", installPullToRefresh, { once: true });
    } else {
        installPullToRefresh();
    }

    const mediaFitStorageKey = "onda.mediaFit";

    function readMediaFit() {
        try {
            const value = localStorage.getItem(mediaFitStorageKey);
            return value === "contain" || value === "cover" ? value : null;
        } catch {
            return null;
        }
    }

    function getMediaFit() {
        return readMediaFit();
    }

    function setMediaFit(mode) {
        const value = mode === "cover" ? "cover" : "contain";
        try {
            localStorage.setItem(mediaFitStorageKey, value);
        } catch {
            // Private mode may block persistence; keep the current session.
        }

        document.documentElement.dataset.mediaFit = value;
        return value;
    }

    const initialMediaFit = readMediaFit();
    if (initialMediaFit) {
        document.documentElement.dataset.mediaFit = initialMediaFit;
    }

    const pipTonePalette = [
        "#ff826a",
        "#6ed9be",
        "#a6a7ff",
        "#ffd47c",
        "#8ecdf4",
        "#ef9bc4"
    ];

    let pipSession = null;
    let pipTarget = null;

    function normalizePipTarget(target) {
        if (!target || typeof target !== "object" || !target.id) {
            return null;
        }

        return {
            id: String(target.id),
            name: String(target.name || "Onda"),
            tone: Number.isFinite(Number(target.tone)) ? Number(target.tone) : 0,
            speaking: Boolean(target.speaking),
            follow: Boolean(target.follow),
            selfId: target.selfId ? String(target.selfId) : ""
        };
    }

    function pipSpeakingCard(selfId) {
        return Array.from(document.querySelectorAll(
            ".person-card.is-speaking[data-peer-id], .people-row.is-speaking[data-peer-id]"
        )).find((card) => !selfId || card.dataset.peerId !== selfId) || null;
    }

    function pipTargetFromCard(card) {
        if (!card) {
            return null;
        }

        const avatar = card.querySelector(".avatar");
        const toneClass = Array.from(avatar?.classList || [])
            .find((name) => name.startsWith("tone-"));
        const tone = toneClass ? Number(toneClass.slice(5)) : 0;
        const nameNode = card.querySelector(".person-copy h2 > span") ||
            card.querySelector(".people-name");
        const name = (nameNode?.textContent || "Onda").trim().replace(/\s*você\s*$/i, "");

        return {
            id: card.dataset.peerId,
            name,
            tone: Number.isFinite(tone) ? tone : 0,
            speaking: true,
            follow: true
        };
    }

    function pipInitials(name) {
        const parts = String(name || "Onda").trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
            return "O";
        }
        if (parts.length === 1) {
            return parts[0].slice(0, 2).toUpperCase();
        }
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }

    function pipVideoFor(peerId) {
        const videos = Array.from(document.querySelectorAll("video[data-peer-id]"))
            .filter((video) => video.dataset.peerId === peerId &&
                video.__ondaLiveKitTrack &&
                video.videoWidth > 0 &&
                video.videoHeight > 0);

        return videos.find((video) => video.dataset.mediaKind === "screen") ||
            videos.find((video) => video.dataset.mediaKind !== "screen") ||
            videos[0] ||
            null;
    }

    function drawPipAvatar(context, width, height, target) {
        const tone = pipTonePalette[Math.abs(target.tone) % pipTonePalette.length];
        const gradient = context.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, "#10231d");
        gradient.addColorStop(1, "#07110e");
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);

        context.globalAlpha = 0.22;
        context.fillStyle = tone;
        context.beginPath();
        context.arc(width * 0.82, height * 0.18, width * 0.32, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.arc(width * 0.18, height * 0.88, width * 0.28, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;

        const centerX = width / 2;
        const centerY = height * 0.4;
        const radius = Math.min(width, height) * 0.16;
        context.beginPath();
        context.arc(centerX, centerY, radius, 0, Math.PI * 2);
        context.fillStyle = tone;
        context.fill();

        context.fillStyle = "#10231d";
        context.font = `700 ${Math.round(radius * 0.72)}px "DM Sans", "Segoe UI", sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(pipInitials(target.name), centerX, centerY + 1);

        context.fillStyle = "#f0ece5";
        context.font = `700 ${Math.round(width * 0.055)}px "DM Sans", "Segoe UI", sans-serif`;
        context.fillText(target.name, centerX, height * 0.68, width * 0.82);

        context.fillStyle = target.speaking ? "#cdf27c" : "rgba(240, 236, 229, 0.62)";
        context.font = `600 ${Math.round(width * 0.032)}px "DM Sans", "Segoe UI", sans-serif`;
        context.fillText(target.speaking ? "Falando agora" : "Em foco", centerX, height * 0.79);

        if (target.speaking) {
            const barWidth = width * 0.012;
            const gap = width * 0.012;
            const baseY = height * 0.9;
            const heights = [0.035, 0.055, 0.075, 0.05, 0.03];
            const total = heights.length * barWidth + (heights.length - 1) * gap;
            let x = centerX - total / 2;
            context.fillStyle = "#cdf27c";
            heights.forEach((ratio, index) => {
                const barHeight = height * ratio * (index % 2 === 0 ? 1 : 0.72);
                context.beginPath();
                context.fillRect(x, baseY - barHeight, barWidth, barHeight);
                x += barWidth + gap;
            });
        }
    }

    function drawPipVideo(context, width, height, video, target) {
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        const scale = Math.max(width / sourceWidth, height / sourceHeight);
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        const x = (width - drawWidth) / 2;
        const y = (height - drawHeight) / 2;
        context.drawImage(video, x, y, drawWidth, drawHeight);

        const gradient = context.createLinearGradient(0, height * 0.62, 0, height);
        gradient.addColorStop(0, "rgba(7, 17, 14, 0)");
        gradient.addColorStop(1, "rgba(7, 17, 14, 0.82)");
        context.fillStyle = gradient;
        context.fillRect(0, height * 0.58, width, height * 0.42);

        context.textAlign = "left";
        context.textBaseline = "alphabetic";
        context.fillStyle = "#f0ece5";
        context.font = `700 ${Math.round(width * 0.045)}px "DM Sans", "Segoe UI", sans-serif`;
        context.fillText(target.name, width * 0.05, height * 0.9, width * 0.7);

        context.fillStyle = "#cdf27c";
        context.font = `600 ${Math.round(width * 0.028)}px "DM Sans", "Segoe UI", sans-serif`;
        context.fillText("Transmitindo", width * 0.05, height * 0.96);
    }

    function pipSpeaking(peerId) {
        const escaped = typeof CSS !== "undefined" && CSS.escape
            ? CSS.escape(peerId)
            : String(peerId).replace(/"/g, '\\"');
        if (document.querySelector(`.person-card[data-peer-id="${escaped}"].is-speaking`) ||
            document.querySelector(`.people-row[data-peer-id="${escaped}"].is-speaking`) ||
            document.querySelector(`.focus-avatar-card[data-peer-id="${escaped}"].is-speaking`)) {
            return true;
        }
        if (document.querySelector(`.person-card[data-peer-id="${escaped}"]`) ||
            document.querySelector(`.people-row[data-peer-id="${escaped}"]`) ||
            document.querySelector(`.focus-avatar-card[data-peer-id="${escaped}"]`)) {
            return false;
        }
        return null;
    }

    function drawPipFrame(session) {
        const context = session.canvas.getContext("2d");
        if (!context) {
            return;
        }

        const { width, height } = session.canvas;
        if (session.follow) {
            const now = performance.now();
            if (!session.lastRotation || now - session.lastRotation >= 1000) {
                session.lastRotation = now;
                const speakingCard = pipSpeakingCard(session.selfId);
                if (speakingCard) {
                    const nextTarget = pipTargetFromCard(speakingCard);
                    if (nextTarget && nextTarget.id) {
                        session.target = nextTarget;
                    }
                }
            }
        }

        const target = session.target;
        if (target) {
            const liveSpeaking = pipSpeaking(target.id);
            if (liveSpeaking !== null) {
                target.speaking = liveSpeaking;
            }
        }
        const video = target ? pipVideoFor(target.id) : null;
        if (video) {
            drawPipVideo(context, width, height, video, target);
        } else if (target) {
            drawPipAvatar(context, width, height, target);
        }
    }

    function stopParticipantPip() {
        const session = pipSession;
        pipSession = null;
        if (!session) {
            return;
        }

        if (session.frame) {
            cancelAnimationFrame(session.frame);
        }
        session.stream.getTracks().forEach((track) => track.stop());
        session.video.srcObject = null;
        session.video.remove();
        session.canvas.remove();
    }

    async function startParticipantPip(target) {
        if (!target || !document.pictureInPictureEnabled ||
            typeof HTMLCanvasElement.prototype.captureStream !== "function") {
            return false;
        }

        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        canvas.style.position = "fixed";
        canvas.style.left = "-10000px";
        canvas.style.top = "0";
        canvas.style.width = "1px";
        canvas.style.height = "1px";
        canvas.style.pointerEvents = "none";

        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.style.position = "fixed";
        video.style.left = "-10000px";
        video.style.top = "0";
        video.style.width = "1px";
        video.style.height = "1px";
        video.style.pointerEvents = "none";

        document.body.appendChild(canvas);
        document.body.appendChild(video);

        const stream = canvas.captureStream(15);
        video.srcObject = stream;

        try {
            await video.play();
            await video.requestPictureInPicture();
        } catch {
            stream.getTracks().forEach((track) => track.stop());
            video.srcObject = null;
            video.remove();
            canvas.remove();
            return false;
        }

        const session = {
            canvas,
            video,
            stream,
            target,
            follow: target.follow,
            selfId: target.selfId,
            lastRotation: 0,
            frame: 0
        };
        pipSession = session;
        pipTarget = target;

        const draw = () => {
            if (pipSession !== session) {
                return;
            }
            drawPipFrame(session);
            session.frame = requestAnimationFrame(draw);
        };
        draw();

        video.addEventListener("leavepictureinpicture", () => {
            if (pipSession === session) {
                stopParticipantPip();
            }
        }, { once: true });

        return true;
    }

    async function toggleParticipantPip(target) {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                return true;
            }

            const normalized = normalizePipTarget(target);
            if (!normalized) {
                return false;
            }

            return await startParticipantPip(normalized);
        } catch {
            stopParticipantPip();
            return false;
        }
    }

    function updatePipTarget(target) {
        pipTarget = normalizePipTarget(target);
        if (pipSession) {
            pipSession.target = pipTarget;
            pipSession.follow = pipTarget ? pipTarget.follow : true;
            pipSession.selfId = pipTarget ? pipTarget.selfId : pipSession.selfId;
            pipSession.lastRotation = 0;
        }
    }

    function showPipFailure() {
        const node = document.createElement("div");
        node.textContent = "Não foi possível abrir o picture-in-picture.";
        Object.assign(node.style, {
            position: "fixed",
            left: "50%",
            bottom: "6.2rem",
            transform: "translateX(-50%)",
            zIndex: "2147483647",
            padding: "0.7rem 1rem",
            borderRadius: "0.75rem",
            background: "rgba(12, 26, 21, 0.94)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "#f0ece5",
            font: "600 0.78rem 'DM Sans', 'Segoe UI', sans-serif",
            boxShadow: "0 1rem 2.5rem rgba(0, 0, 0, 0.35)",
            pointerEvents: "none"
        });
        document.body.appendChild(node);
        window.setTimeout(() => node.remove(), 4200);
    }

    // O clique precisa chegar ao requestPictureInPicture ainda dentro da
    // ativação do usuário. Passar pelo circuito do Blazor Server pode perder
    // essa ativação e o navegador rejeita o PiP.
    document.addEventListener("click", (event) => {
        const button = event.target instanceof Element
            ? event.target.closest("[data-onda-pip]")
            : null;
        if (!button) {
            return;
        }

        const canvasSupported = typeof HTMLCanvasElement.prototype.captureStream === "function";
        if (!document.pictureInPictureEnabled || !canvasSupported) {
            return;
        }

        const targetId = button.dataset.pipId || "";
        if (!document.pictureInPictureElement && !targetId) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        void toggleParticipantPip({
            id: targetId,
            name: button.dataset.pipName || "Onda",
            tone: Number(button.dataset.pipTone || 0),
            speaking: button.dataset.pipSpeaking === "true",
            follow: button.dataset.pipFollow === "true",
            selfId: button.dataset.pipSelf || ""
        }).then((opened) => {
            if (!opened && !document.pictureInPictureElement) {
                showPipFailure();
            }
        });
    }, true);

    async function toggleVideoPip() {
        if (pipTarget) {
            return toggleParticipantPip(pipTarget);
        }

        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                return true;
            }

            if (!document.pictureInPictureEnabled) {
                return false;
            }

            const videos = Array.from(document.querySelectorAll(".stage-area video[data-peer-id]"))
                .filter((video) => video.__ondaLiveKitTrack &&
                    video.videoWidth > 0 &&
                    !video.disablePictureInPicture);
            const video = videos.find((candidate) => candidate.closest(".media-tile.is-featured")) ||
                videos.find((candidate) => candidate.dataset.mediaKind === "screen") ||
                videos[0];

            if (!video || typeof video.requestPictureInPicture !== "function") {
                return false;
            }

            await video.requestPictureInPicture();
            return true;
        } catch {
            return false;
        }
    }

    function setPipMode(active) {
        const enabled = Boolean(active);
        document.documentElement.classList.toggle("onda-pip", enabled);

        if (!enabled) {
            return;
        }

        if (!document.querySelector(".is-pip-speaker")) {
            const fallbackTile = document.querySelector(".media-tile-shell");
            fallbackTile?.classList.add("is-pip-speaker");
            const fallbackCard = document.querySelector(".pip-audio-card");
            fallbackCard?.classList.add("is-pip-speaker");
        }
    }

    const notificationStorageKey = "onda.notifications";
    let notificationSettings = readNotificationSettings();
    let notificationAudioContext = null;

    function readNotificationSettings() {
        const defaults = {
            joinSound: true,
            leaveSound: true,
            messageSound: true,
            chatNotifications: false
        };

        try {
            const stored = JSON.parse(localStorage.getItem(notificationStorageKey) || "null");
            if (!stored || typeof stored !== "object") {
                return defaults;
            }

            return {
                joinSound: stored.joinSound !== false,
                leaveSound: stored.leaveSound !== false,
                messageSound: stored.messageSound !== false,
                chatNotifications: stored.chatNotifications === true
            };
        } catch {
            return defaults;
        }
    }

    function persistNotificationSettings() {
        try {
            localStorage.setItem(notificationStorageKey, JSON.stringify(notificationSettings));
        } catch {
            // Private mode may block persistence.
        }
    }

    function getNotificationSettings() {
        return JSON.stringify(notificationSettings);
    }

    async function saveNotificationSettings(serialized) {
        let incoming = serialized;
        if (typeof serialized === "string") {
            try {
                incoming = JSON.parse(serialized);
            } catch {
                incoming = null;
            }
        }

        if (incoming && typeof incoming === "object") {
            notificationSettings = {
                joinSound: incoming.joinSound !== false,
                leaveSound: incoming.leaveSound !== false,
                messageSound: incoming.messageSound !== false,
                chatNotifications: incoming.chatNotifications === true
            };
        }

        let permission = "unsupported";
        const nativePlugin = nativeMediaPlugin();
        const nativeNotifications = Boolean(nativePlugin?.notifyChat);
        const desktopNotifications = Boolean(window.ondaDesktop?.notifyChat);
        if (desktopNotifications) {
            permission = "granted";
        } else if (nativeNotifications) {
            if (notificationSettings.chatNotifications) {
                permission = "requested";
                try {
                    const result = await nativePlugin.requestNotificationPermission();
                    permission = result?.granted ? "granted" : "requested";
                } catch {
                    permission = "requested";
                }
            }
        } else if ("Notification" in window) {
            permission = Notification.permission;
            if (notificationSettings.chatNotifications) {
                if (permission === "default") {
                    try {
                        permission = await Notification.requestPermission();
                    } catch {
                        permission = "denied";
                    }
                }

                if (permission !== "granted") {
                    notificationSettings.chatNotifications = false;
                }
            }
        } else {
            notificationSettings.chatNotifications = false;
        }

        persistNotificationSettings();
        return JSON.stringify({
            ...notificationSettings,
            permission
        });
    }

    function playRoomSound(kind) {
        const enabled = kind === "join"
            ? notificationSettings.joinSound
            : kind === "leave"
                ? notificationSettings.leaveSound
                : kind === "message"
                    ? notificationSettings.messageSound
                    : false;
        if (!enabled) {
            return;
        }

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            return;
        }

        try {
            notificationAudioContext ??= new AudioContextCtor();
            const context = notificationAudioContext;
            const play = () => {
                const now = context.currentTime + 0.01;
                const notes = kind === "join"
                    ? [[520, 0, 0.11], [720, 0.09, 0.13]]
                    : kind === "leave"
                        ? [[470, 0, 0.1], [340, 0.08, 0.14]]
                        : [[660, 0, 0.09]];

                for (const [frequency, offset, duration] of notes) {
                    const start = now + offset;
                    const oscillator = context.createOscillator();
                    const gain = context.createGain();
                    oscillator.type = "sine";
                    oscillator.frequency.setValueAtTime(frequency, start);
                    gain.gain.setValueAtTime(0.0001, start);
                    gain.gain.exponentialRampToValueAtTime(0.035, start + 0.015);
                    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
                    oscillator.connect(gain);
                    gain.connect(context.destination);
                    oscillator.start(start);
                    oscillator.stop(start + duration + 0.02);
                }
            };

            if (context.state === "suspended") {
                void context.resume().then(play).catch(() => {});
            } else {
                play();
            }
        } catch {
            // Audio effects are optional.
        }
    }

    function showChatNotification(sender, text, roomName, roomCode) {
        if (!notificationSettings.chatNotifications) {
            return;
        }

        const hasDesktopNotifications = Boolean(window.ondaDesktop?.notifyChat);
        if (!hasDesktopNotifications && !document.hidden && document.hasFocus()) {
            return;
        }

        const message = String(text || "").trim();
        if (!message) {
            return;
        }

        if (hasDesktopNotifications) {
            void window.ondaDesktop.notifyChat({
                sender: String(sender || "Alguém"),
                text: message,
                roomId: String(roomCode || "")
            }).catch(() => {});
            return;
        }

        const nativePlugin = nativeMediaPlugin();
        if (nativePlugin?.notifyChat) {
            void nativePlugin.notifyChat({
                sender: String(sender || "Alguém"),
                text: message,
                roomId: String(roomCode || "")
            }).catch(() => {});
            return;
        }

        if (!("Notification" in window) || Notification.permission !== "granted") {
            return;
        }

        try {
            const notification = new Notification(
                `${String(sender || "Alguém")} · ${String(roomName || "Onda")}`,
                {
                    body: message.length > 180 ? `${message.slice(0, 177)}...` : message,
                    icon: "/og/onda-share.png",
                    silent: true
                });
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        } catch {
            // The platform may reject notifications even after permission.
        }
    }

    async function testChatNotification(sender, text, roomName, roomCode) {
        const message = String(text || "Notificação de teste");
        if (window.ondaDesktop?.notifyChat) {
            return Boolean(await window.ondaDesktop.notifyChat({
                sender: String(sender || "Onda"),
                text: message,
                roomId: String(roomCode || ""),
                force: true
            }));
        }

        const nativePlugin = nativeMediaPlugin();
        if (nativePlugin?.notifyChat) {
            try {
                await nativePlugin.requestNotificationPermission();
                await nativePlugin.notifyChat({
                    sender: String(sender || "Onda"),
                    text: message,
                    roomId: String(roomCode || "")
                });
                return true;
            } catch {
                return false;
            }
        }

        if (!("Notification" in window)) {
            return false;
        }

        let permission = Notification.permission;
        if (permission === "default") {
            permission = await Notification.requestPermission();
        }
        if (permission !== "granted") {
            return false;
        }

        new Notification(String(sender || "Onda"), {
            body: message,
            icon: "/og/onda-share.png",
            silent: true
        });
        return true;
    }

    window.onda = Object.freeze({
        copyText,
        scrollToBottom,
        focusElement,
        shareLink,
        shareRoomLink,
        reloadPage,
        readScreenQuality,
        saveScreenQuality,
        readCameraQuality,
        saveCameraQuality,
        getScreenEstimate,
        toggleFullscreen,
        isFirefox,
        toggleTheme,
        installPwa,
        canInstallPwa: () => Boolean(deferredInstallPrompt) || isStandalonePwa(),
        isStandalonePwa,
        getInstallContext,
        setWakeLock,
        setPipMode,
        toggleVideoPip,
        toggleParticipantPip,
        updatePipTarget,
        getMediaFit,
        setMediaFit,
        startPresenceHeartbeat,
        stopPresenceHeartbeat,
        registerVisibilityListener,
        getNotificationSettings,
        saveNotificationSettings,
        playRoomSound,
        showChatNotification,
        testChatNotification,
        isNativeMobile,
        startNativeCall,
        stopNativeCall,
        setNativeMic,
        setNativeCamera,
        getNativeCamera,
        getNativeCameraOptions,
        switchNativeCamera,
        setNativeCameraTorch,
        setNativeCameraQuality,
        startNativeScreenShare,
        stopNativeScreenShare,
        getNativeScreenShare,
        setNativeScreenQuality,
        getNativeRnnoise,
        setNativeRnnoise,
        registerNativeMicListener,
        getNativeMic,
        registerExitGuard,
        setRoomExitGuard,
        getNativeAudioDevices,
        selectNativeAudioDevice,
        getNativeOutputVolume,
        setNativeOutputVolume
    });
})();
