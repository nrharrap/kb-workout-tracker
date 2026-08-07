/**
 * Service worker (PRD 5, offline behaviour).
 *
 * App shell: network-first with a short timeout, falling back to cache (see
 * networkFirst() below) — so the programme and the UI open with no signal,
 * and a fresh deploy is picked up on the next load rather than needing a
 * second reload to notice the change.
 * The GitHub API: never cached — a stale response would be worse than an
 * honest failure, and sync.js already knows how to queue when the network
 * is unavailable.
 */

const CACHE = 'kbwt-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/programme.js',
  './js/model.js',
  './js/merge.js',
  './js/schema.js',
  './js/sync.js',
  './js/store.js',
  './js/github.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one missing asset can't fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The GitHub API goes straight to the network, always.
  if (url.hostname === 'api.github.com') return;

  if (url.origin !== self.location.origin) return;

  // Network-first with a short timeout, falling back to cache.
  //
  // Cache-first was the first attempt and it was wrong: a deploy left the
  // browser running stale JS and CSS until a second reload, which during
  // development silently hid changes and in production would mean pushing a
  // fix that Nick doesn't see. Freshness matters more than shaving a few
  // hundred milliseconds off a warm start. Offline still works — the timeout
  // and the error path both fall through to exactly the same cached response.
  event.respondWith(networkFirst(request));
});

const NETWORK_TIMEOUT_MS = 2500;

async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      cache.put(request, response.clone());
      return response;
    }
    // A non-OK response (404, 500) is still more honest than a stale asset,
    // unless we have something cached to fall back to.
    const cached = await cache.match(request);
    return cached || response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // A navigation with nothing cached for this exact URL still gets the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
