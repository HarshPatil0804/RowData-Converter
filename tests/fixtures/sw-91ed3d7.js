/*
 * Byte-for-byte the service worker served by the live build at commit 91ed3d7
 * (git show 91ed3d7:public/sw.js). Kept as a fixture so the cleanup test can
 * reproduce the state a returning visitor is actually in.
 */
/**
 * Offline support for the app shell.
 *
 * Why this file exists: the production site registered a service worker but
 * shipped no /sw.js, so every visit logged `404 /sw.js` in the console. The
 * service worker is what removed that error — and, as a side effect, lets the
 * app open with no network at all.
 *
 * What it is allowed to do (deliberately narrow):
 *   - navigations (index.html) → **network first**, no-store, cache only as the
 *     offline fallback. A new deploy is picked up on the first reload.
 *   - /version.json            → never intercepted, so the build stamp always
 *     reports the live commit.
 *   - /assets/, /tess/, /tessdata/ → cache first: these file names are content
 *     hashed or engine versioned, so a cached copy can never go stale.
 *   - everything else (blob:, data:, other origins, non-immutable paths) → not
 *     touched at all.
 *
 * It never caches user files: file parsing happens in a Worker from an
 * ArrayBuffer, with no network request to intercept, and non-http(s) schemes are
 * ignored outright.
 */
const CACHE = 'u2s-shell-v2';

/** Only content-hashed bundles and versioned OCR assets may be cached. */
const IMMUTABLE = /^\/(assets|tess|tessdata)\//;

/** The app shell entry, cached once per install as the offline fallback. */
const SHELL = './';

/**
 * Cache the shell and every content-hashed bundle listed in /assets.json, which
 * the build writes. Without the asset list the first visit would cache the HTML
 * only (the worker cannot intercept the requests that produced it), leaving the
 * app blank offline.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll([SHELL]).catch(() => undefined);
  try {
    const listing = await fetch('./assets.json', { cache: 'no-store' });
    if (!listing.ok) return;
    const { assets } = await listing.json();
    if (!Array.isArray(assets)) return;
    // One missing file must not abort the whole install.
    await Promise.allSettled(assets.map((asset) => cache.add(asset)));
  } catch {
    // Offline during install: the shell is still cached, assets fill in later.
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // blob: and data: URLs are the app's own downloads and worker scripts.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;
  // The build stamp must always be the live one.
  if (url.pathname === '/version.json') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL)),
    );
    return;
  }

  if (!IMMUTABLE.test(url.pathname)) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
