/* eslint-disable no-restricted-globals */
const CACHE_NAME = 'crm-pwa-v1';
const STATIC_ASSETS = ['/', '/index.html', '/favicon.ico', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  let url;
  try {
    url = new URL(e.request.url);
  } catch {
    return;
  }

  if (e.request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    // Network-first for API
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else if (
    url.pathname.startsWith('/assets/') ||
    STATIC_ASSETS.includes(url.pathname)
  ) {
    // Cache-first for static
    e.respondWith(
      caches.match(e.request).then(
        (r) =>
          r ||
          fetch(e.request).then((resp) => {
            if (resp && resp.status === 200 && resp.type === 'basic') {
              const clone = resp.clone();
              caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            }
            return resp;
          })
      )
    );
  }
});
