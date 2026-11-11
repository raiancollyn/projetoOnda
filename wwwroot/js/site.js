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

    window.onda = Object.freeze({
        copyText,
        scrollToBottom,
        focusElement,
        shareLink,
        reloadPage,
        readScreenQuality,
        saveScreenQuality
    });
})();
