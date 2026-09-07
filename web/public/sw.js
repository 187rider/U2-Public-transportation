const SHELL_CACHE_NAME = 'u2-transport-shell-v90';
const TILES_CACHE_NAME = 'u2-mbtiles-cache-v3';
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

  // 1. Vector Map Tiles (.pbf): Cache uncompressed Protobuf directly, return 204 on empty
  if (url.pathname.startsWith('/tiles/') || url.pathname.endsWith('.pbf')) {
    event.respondWith(
      caches.open(TILES_CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedTile) => {
          if (cachedTile) {
            return cachedTile;
          }
          return fetch(event.request)
            .then(async (networkTile) => {
              if (networkTile && networkTile.status === 200) {
                let buf = await networkTile.arrayBuffer();
                // If upstream delivered raw gzip bytes (magic 0x1f, 0x8b), decompress in worker
                const u8 = new Uint8Array(buf);
                if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
                  try {
                    const ds = new DecompressionStream('gzip');
                    const writer = ds.writable.getWriter();
                    writer.write(u8);
                    writer.close();
                    buf = await new Response(ds.readable).arrayBuffer();
                  } catch (e) {
                    console.warn('Tile decompression fallback failed:', e);
                  }
                }
                if (buf.byteLength === 0) {
                  return new Response(null, { status: 204, statusText: 'No Content' });
                }
                const h = new Headers(networkTile.headers);
                h.set('Content-Type', 'application/x-protobuf');
                h.delete('Content-Encoding');
                h.set('Cache-Control', 'public, max-age=2592000, immutable');
                const cleanTile = new Response(buf, { status: 200, headers: h });
                cache.put(event.request, cleanTile.clone()).catch(() => {});
                return cleanTile;
              }
              return networkTile;
            })
            .catch((err) => {
              if (err && err.name === 'AbortError') {
                throw err;
              }
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

  if (event.data) {
    try {
      const data = event.data.json();
      if (data && typeof data === 'object') {
        if (data.title) title = String(data.title);
        if (data.body) body = String(data.body);
        if (data.tag) tag = String(data.tag);
        if (data.sid) sid = String(data.sid);
        if (data.rid) rid = String(data.rid);
        if (data.url) url = String(data.url);
      }
    } catch {
      try {
        const text = event.data.text();
        if (text) body = text;
      } catch {}
    }
  }

  const isArrival = title.includes('прибыл') || body.includes('прибыл');

  const options = {
    body: body,
    tag: `arrival_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    icon: '/icon-512.png',
    vibrate: isArrival ? [500, 200, 500, 200, 800] : [300, 150, 300],
    data: {
      url: url || '/',
      sid: sid || '',
      rid: rid || '',
      date: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.warn('showNotification options error, falling back to minimal:', err);
      return self.registration.showNotification(title, {
        body: body,
        icon: '/icon-512.png',
        requireInteraction: true
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = (event.notification && event.notification.data) || {};
  const sid = notifData.sid || '';
  const rid = notifData.rid || '';

  event.waitUntil(
    (async () => {
      // 1. Store pending station action in CacheStorage so opening/focused app reads it reliably
      if (sid) {
        try {
          const cache = await caches.open('u2-pending-actions');
          const payload = JSON.stringify({ sid, rid, timestamp: Date.now() });
          await cache.put(
            new Request('/__pending_station_action'),
            new Response(payload, { headers: { 'Content-Type': 'application/json' } })
          );
        } catch (e) {
          console.warn('Failed to save pending station action:', e);
        }
      }

      // 2. Look for open client windows belonging to our origin
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      let matchingClient = null;

      for (const client of clientList) {
        try {
          if (client.url) {
            const clientUrl = new URL(client.url, self.location.origin);
            if (clientUrl.origin === self.location.origin) {
              matchingClient = client;
              if (client.focused || client.visibilityState === 'visible') {
                break;
              }
            }
          }
        } catch {}
      }

      if (matchingClient) {
        if (sid) {
          matchingClient.postMessage({ type: 'OPEN_STATION_POPUP', sid, rid });
        }
        if ('focus' in matchingClient) {
          const focusedClient = await matchingClient.focus().catch(() => null);
          if (focusedClient && sid) {
            focusedClient.postMessage({ type: 'OPEN_STATION_POPUP', sid, rid });
          }
          return;
        }
      }

      // 3. If no window is open, open the root standalone PWA URL (no extra query params that break WebAPK/iOS standalone intents)
      if (self.clients.openWindow) {
        const rootUrl = (self.registration && self.registration.scope) ? self.registration.scope : '/';
        await self.clients.openWindow(rootUrl);
      }
    })()
  );
});
