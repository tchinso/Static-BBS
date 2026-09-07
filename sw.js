const CACHE_NAME = 'nyangcatmemo-shell-v4';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/app-icon.svg'
];
const APP_SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('nyangcatmemo-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Posts and images are private. Never cache /api responses in the browser.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Serve the cached shell first so a repeat PWA launch can render its loading
  // state immediately, then refresh it in the background for the next visit.
  // Private data and client routes always use the network.
  if (!APP_SHELL_PATHS.has(url.pathname)) {
    if (request.mode === 'navigate') {
      event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    }
    return;
  }

  const refresh = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(
    caches.match(request).then((cached) => cached || refresh).catch(async () => {
      if (request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })
  );
});
