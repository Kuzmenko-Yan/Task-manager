const CACHE = "kanban-v1";
const FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => {
      // Add files one-by-one so one failure doesn't break the whole SW
      return Promise.allSettled(
        FILES.map((f) =>
          cache.add(f).catch((err) => console.warn("SW: failed to cache", f, err))
        )
      );
    })
  );
});

self.addEventListener("fetch", (e) => {
  // Skip non-GET requests and API calls — let browser handle them natively
  if (e.request.method !== "GET" || e.request.url.includes("/api/")) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        // Network failed — return cached copy if available
        if (cached) return cached;
        return new Response("Offline", { status: 503 });
      });

      return cached || fetched;
    })
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});