/* Small global helpers shared by the Blazor pages. */
(function () {
    "use strict";

    const bootSelector = "[data-app-ready]";

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

    window.onda = Object.freeze({
        copyText,
        scrollToBottom,
        focusElement,
        shareLink,
        reloadPage,
        readScreenQuality,
        saveScreenQuality,
        toggleFullscreen
    });
})();
