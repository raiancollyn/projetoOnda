const CACHE_VERSION = "onda-pwa-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const PRECACHE = [
    "/offline.html",
    "/manifest.webmanifest",
    "/icons/onda-192.png",
    "/icons/onda-512.png",
    "/icons/onda-maskable-512.png",
    "/icons/apple-touch-icon.png",
    "/images/screenshots/home-wide.png",
    "/images/screenshots/room-wide.png",
    "/images/screenshots/home-narrow.png"
];

const NEVER_CACHE = [
    "/_blazor",
    "/_framework",
    "/api/",
    "/download/",
    "/health",
    "/presence"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== STATIC_CACHE)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(async () => {
                const offline = await caches.match("/offline.html");
                return offline || new Response(
                    "<!doctype html><meta charset=\"utf-8\"><title>Onda offline</title><p>Sem conexão. Abra o Onda novamente quando estiver online.</p>",
                    { headers: { "Content-Type": "text/html; charset=utf-8" } }
                );
            })
        );
        return;
    }

    if (/\.(?:css|js|mjs|png|jpe?g|webp|svg|ico|woff2?|webmanifest)$/i.test(url.pathname)) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(async (cache) => {
                const cached = await cache.match(request);
                const network = fetch(request)
                    .then((response) => {
                        if (response.ok) {
                            cache.put(request, response.clone());
                        }
                        return response;
                    })
                    .catch(() => null);

                return cached || (await network) || Response.error();
            })
        );
    }
});
