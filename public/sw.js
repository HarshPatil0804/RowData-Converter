/**
 * Tombstone service worker.
 *
 * This app used to ship a caching service worker. It no longer does — nothing
 * persisted is part of the privacy charter, and a cache is persistence. But a
 * browser that visited an older build still has that worker installed, and a
 * worker keeps living until its script changes and activates.
 *
 * So /sw.js exists only to disappear: take over from the old worker, delete
 * every cache, unregister itself, and reload the pages it controls so they run
 * without a worker. It never caches anything and never intercepts a fetch.
 *
 * The app also purges registrations and caches on boot (src/lib/privacy.ts), so
 * a browser that never re-checks sw.js is still cleaned on the next visit.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // Cache API unavailable.
      }
      try {
        await self.registration.unregister();
      } catch {
        // Already unregistered.
      }
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try {
          client.navigate(client.url);
        } catch {
          // A client that cannot navigate reloads on its own next visit.
        }
      }
    })(),
  );
});
