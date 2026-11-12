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

    function readScreenQuality() {
        try {
            return localStorage.getItem(screenQualityKey) || "";
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

    const overlayHideDelay = 3000;
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

    window.onda = Object.freeze({
        copyText,
        scrollToBottom,
        focusElement,
        shareLink,
        reloadPage,
        readScreenQuality,
        saveScreenQuality,
        toggleFullscreen,
        isFirefox,
        toggleTheme,
        installPwa,
        canInstallPwa: () => Boolean(deferredInstallPrompt) || isStandalonePwa(),
        isStandalonePwa,
        getInstallContext
    });
})();
