const SHELL_CACHE_NAME = 'u2-transport-shell-v60';
const TILES_CACHE_NAME = 'u2-mbtiles-cache-v1';
const STATIC_API_CACHE_NAME = 'u2-static-api-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-512.png',
  '/ulan_ude.gif',
  '/arrival-chaching.wav'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map((asset) => cache.add(asset).catch((err) => {
          console.warn('SW pre-cache item warning:', asset, err);
        }))
      );
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

// Cache strategies and request routing
self.addEventListener('fetch', (event) => {
  // Only handle GET requests (POST reminders/subscribe etc. must never be intercepted)
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

  // 1. Vector Map Tiles (.pbf): CACHE-FIRST (0ms load from disk, 204 offline fallback)
  if (url.pathname.startsWith('/tiles/') || url.pathname.endsWith('.pbf')) {
    event.respondWith(
      caches.open(TILES_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedTile) => {
          if (cachedTile) {
            return cachedTile; // Return cached tile instantly
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

          if (cachedData) {
            event.waitUntil(fetchPromise);
            return cachedData;
          }
          return fetchPromise;
        });
      })
    );
    return;
  }

  // 3. ALL Live / Dynamic Telemetry & API Endpoints: Strictly Network-Only (Never cached)
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
        .catch(() =>
          caches.match('/index.html').then((r) => r || caches.match(event.request))
        )
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

      if (cachedResponse) {
        event.waitUntil(fetchPromise);
        return cachedResponse;
      }
      return fetchPromise;
    })
  );
});

// Push Message & Notification Handlers
self.addEventListener('push', (event) => {
  let title = '🚌 Транспорт Улан-Удэ';
  let body = 'Обновление прибытия транспорта';
  let tag = 'arrival-alarm';
  let sid = '';
  let rid = '';
  let url = '/';
  let icon = '/apple-touch-icon.png';
  let badge = '/favicon.svg';

  if (event.data) {
    try {
      const data = event.data.json();
      if (data) {
        if (data.title) title = String(data.title);
        if (data.body) body = String(data.body);
        if (data.tag) tag = String(data.tag);
        if (data.sid) sid = String(data.sid);
        if (data.rid) rid = String(data.rid);
        if (data.url) url = String(data.url);
        if (data.icon) icon = String(data.icon);
        if (data.badge) badge = String(data.badge);
      }
    } catch {
      try {
        const text = event.data.text();
        if (text) body = text;
      } catch {}
    }
  }

  async function handlePush() {
    const isArrival = tag.startsWith('arrival_') && (title.includes('прибыл') || title.includes('arrived'));
    const options = {
      body: body,
      tag: tag || 'arrival-alarm',
      icon: icon || '/apple-touch-icon.png',
      badge: badge || '/favicon.svg',
      renotify: true,
      requireInteraction: isArrival,
      vibrate: isArrival ? [300, 100, 300, 100, 400] : [150],
      sound: isArrival ? '/arrival-chaching.wav' : undefined,
      data: { url: url || '/' }
    };

    try {
      await self.registration.showNotification(title, options);
    } catch (err) {
      console.warn('showNotification failed with rich options, fallback to basic:', err);
      try {
        await self.registration.showNotification(title, { body: body, tag: tag, data: { url: url }, renotify: true });
      } catch (e) {
        console.error('Final showNotification error:', e);
      }
    }
  }

  event.waitUntil(handlePush());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          if ('navigate' in client && targetUrl !== '/') {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
