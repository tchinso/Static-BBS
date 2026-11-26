const CACHE_NAME = 'nyangcatmemo-shell-v13';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './shared/limits.js',
  './shared/validation.js',
  './client/uploads.js',
  './client/search.js',
  './client/startup.js',
  './shared/features.js',
  './NKMM/favorites.png',
  './config.js',
  './manifest.webmanifest',
  './icons/app-icon.svg'
];
const APP_SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location.origin).pathname));
const SHARED_POST_PATH = /^\/(?=[A-Za-z\d]*[A-Z])(?=[A-Za-z\d]*[a-z])(?=[A-Za-z\d]*\d)[A-Za-z\d]{6}\/?$/;

self.addEventListener('install', (event) => {
  const requests = APP_SHELL.map((path) => new Request(path, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
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
  const sharedPost = request.mode === 'navigate' && SHARED_POST_PATH.test(url.pathname);
  if (!sharedPost && !APP_SHELL_PATHS.has(url.pathname)) return;
  // Keep HTML, modules, and CSS on the same release while a new worker installs.
  // Query parameters on board links change the view, not the static shell.
  const path = sharedPost ? '/index.html' : url.pathname;
  event.respondWith(caches.open(CACHE_NAME)
    .then((cache) => cache.match(path))
    .catch(() => undefined)
    .then((cached) => cached || fetch(request)));
});
