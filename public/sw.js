// ============================================================
//  Service Worker — офлайн-поддержка (PWA)
//  Кэширует статические файлы при установке и отдаёт их
//  из кэша при отсутствии сети (cache-first с обновлением).
// ============================================================

// Версия кэша — при изменении старый кэш удаляется в activate
const CACHE = "kanban-v2";

// Файлы, которые кэшируются при установке SW
const FILES = [
  "/",             // SPA fallback (index.html)
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json", // PWA-манифест (иконки, имя, тема)
];

// ============================================================
//  Событие install — кэшируем статические файлы
// ============================================================
// self.skipWaiting() заставляет новый SW немедленно активироваться,
// не дожидаясь закрытия всех вкладок со старым SW.
// Promise.allSettled вместо all — один неудачный файл не ломает весь кэш.
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

// ============================================================
//  Событие activate — очистка старых кэшей
// ============================================================
// self.clients.claim() — новый SW берёт под контроль все открытые
// страницы сразу, без перезагрузки.
// Удаляем все кэши, кроме текущего CACHE (предыдущие версии).
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    })()
  );
});

// ============================================================
//  Событие fetch — стратегия «сначала кэш, потом сеть»
// ============================================================
// Перехватываем только:
//   - GET-запросы (POST/PUT/DELETE не кэшируем)
//   - Тот же origin (игнорируем CDN, внешние ресурсы)
//   - Не /api/ (API-запросы всегда идут на сервер)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // API-запросы пропускаем — они требуют аутентификации и актуальных данных
  if (url.pathname.startsWith("/api/")) return;

  // Внешние ресурсы не перехватываем
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      // Пытаемся загрузить свежую версию из сети
      const fetched = fetch(e.request).then((resp) => {
        // Успешный ответ — кладём в кэш для будущего офлайна
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        // Сеть недоступна:
        //   - если есть в кэше — отдаём из кэша
        //   - если нет — показываем заглушку "Offline"
        if (cached) return cached;
        return new Response("Offline", { status: 503 });
      });

      // Отдаём из кэша немедленно, параллельно обновляя кэш из сети
      return cached || fetched;
    })
  );
});