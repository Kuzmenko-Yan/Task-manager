const CACHE = "kanban-v2";
const FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
];

// Take control immediately after install — no need to wait for all tabs to close
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((cache) => {
      return Promise.allSettled(
        FILES.map((f) =>
          cache.add(f).catch((err) => console.warn("SW: failed to cache", f, err))
        )
      );
    })
  );
});

// Claim all clients so the new SW controls pages right away
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    })()
  );
});

self.addEventListener("fetch", (e) => {
  // Only handle GET requests for static resources
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // Never intercept API calls
  if (url.pathname.startsWith("/api/")) return;

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        if (cached) return cached;
        return new Response("Offline", { status: 503 });
      });

      return cached || fetched;
    })
  );
});
