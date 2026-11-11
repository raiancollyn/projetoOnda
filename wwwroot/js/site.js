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
        toggleTheme
    });
})();
