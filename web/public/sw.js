const SHELL_CACHE_NAME = 'u2-transport-shell-v20';
const TILES_CACHE_NAME = 'u2-mbtiles-cache-v1';
const STATIC_API_CACHE_NAME = 'u2-static-api-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-512.png',
  '/ulan_ude.gif'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('SW pre-cache warning:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  const allowedCaches = [SHELL_CACHE_NAME, TILES_CACHE_NAME, STATIC_API_CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (!allowedCaches.includes(key)) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Strictly only cache own-origin HTTP/HTTPS requests
  if (!url.protocol.startsWith('http') || url.origin !== self.location.origin) {
    return;
  }

  // 1. Vector Map Tiles: CACHE-FIRST (0ms load from disk, saves 99% mobile traffic)
  if (url.pathname.startsWith('/tiles/')) {
    event.respondWith(
      caches.open(TILES_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedTile) => {
          if (cachedTile) {
            return cachedTile; // Return cached tile instantly with 0 network usage
          }
          return fetch(event.request)
            .then((networkTile) => {
              if (networkTile && networkTile.status === 200) {
                cache.put(event.request, networkTile.clone()).catch(() => {});
              }
              return networkTile;
            })
            .catch(() => {
              return new Response(null, { status: 204, statusText: 'No Content' });
            });
        });
      })
    );
    return;
  }

  // 2. Static Transit Data (Stations & Routes): STALE-WHILE-REVALIDATE (Instant offline startup)
  if (url.pathname === '/api/stations' || url.pathname === '/api/routes') {
    event.respondWith(
      caches.open(STATIC_API_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedData) => {
          const fetchPromise = fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                cache.put(event.request, networkResponse.clone()).catch(() => {});
              }
              return networkResponse;
            })
            .catch(() => cachedData);

          return cachedData || fetchPromise;
        });
      })
    );
    return;
  }

  // 3. Live Telemetry (/api/vehicles, /api/forecasts): Strictly Network-Only
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 4. HTML Navigation: Network-first with cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(SHELL_CACHE_NAME).then((cache) => {
              cache.put(event.request, clone).catch(() => {});
            });
          }
          return response;
        })
        .catch(() => caches.match('/index.html') || caches.match(event.request))
    );
    return;
  }

  // 5. Static Assets (JS, CSS, fonts, icons): Stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(SHELL_CACHE_NAME).then((cache) => {
              cache.put(event.request, clone).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// Push Message & Notification Handlers
self.addEventListener('push', (event) => {
  let title = '🚌 Транспорт Улан-Удэ';
  let body = 'Обновление прибытия транспорта';
  let url = '/';

  if (event.data) {
    try {
      const data = event.data.json();
      if (data && data.title) title = String(data.title);
      if (data && data.body) body = String(data.body);
      if (data && data.url) url = String(data.url);
    } catch {
      try {
        const text = event.data.text();
        if (text) body = text;
      } catch {}
    }
  }

  const options = {
    body: body,
    data: { url: url }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
