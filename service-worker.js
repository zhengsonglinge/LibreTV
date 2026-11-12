const ASSET_VERSION = '20261112sources1';
const STATIC_CACHE = 'video-index-static-v9';
const IMAGE_CACHE = 'video-index-images-v8';
const IMAGE_CACHE_LIMIT = 120;

const urlsToCache = [
  '/',
  `/css/tailwind.css?v=${ASSET_VERSION}`,
  `/css/styles.css?v=${ASSET_VERSION}`,
  `/css/home.css?v=${ASSET_VERSION}`,
  `/js/app.js?v=${ASSET_VERSION}`,
  `/js/config.js?v=${ASSET_VERSION}`,
  `/js/ui.js?v=${ASSET_VERSION}`,
  `/js/api.js?v=${ASSET_VERSION}`,
  `/js/douban.js?v=${ASSET_VERSION}`,
  `/js/password.js?v=${ASSET_VERSION}`,
  `/libs/sha256.min.js?v=${ASSET_VERSION}`,
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => Promise.allSettled(urlsToCache.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== IMAGE_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
}

async function putInCache(cacheName, request, response) {
  if (!response || (!response.ok && response.type !== 'opaque')) return;
  const responseToCache = response.clone();
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, responseToCache);
    if (cacheName === IMAGE_CACHE) {
      await trimCache(cacheName, IMAGE_CACHE_LIMIT);
    }
  } catch (error) {
    console.warn('缓存资源失败:', request.url, error);
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    putInCache(cacheName, request, response);
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

async function cacheFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const refresh = fetch(request)
      .then(response => putInCache(cacheName, request, response))
      .catch(() => {});
    event.waitUntil(refresh);
    return cached;
  }
  return networkFirst(request, cacheName);
}

async function handleImage(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(event.request);
  if (cached) {
    event.waitUntil(
      fetch(event.request)
        .then(response => putInCache(IMAGE_CACHE, event.request, response))
        .catch(() => {})
    );
    return cached;
  }

  try {
    const response = await fetch(event.request);
    await putInCache(IMAGE_CACHE, event.request, response);
    return response;
  } catch (error) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const navigationUrl = new URL(request.url);
          if (navigationUrl.origin === self.location.origin && navigationUrl.pathname === '/') {
            putInCache(STATIC_CACHE, '/', response);
          }
          return response;
        })
        .catch(async () =>
          (await caches.match(request, { ignoreSearch: true })) || Response.error()
        )
    );
    return;
  }

  if (request.destination === 'image') {
    event.respondWith(handleImage(event));
    return;
  }

  if (['style', 'script', 'font', 'manifest'].includes(request.destination)) {
    const url = new URL(request.url);
    event.respondWith(
      url.searchParams.has('v')
        ? cacheFirst(request, STATIC_CACHE, event)
        : networkFirst(request, STATIC_CACHE)
    );
  }
});
