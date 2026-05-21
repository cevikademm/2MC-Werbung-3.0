/* eslint-disable no-restricted-globals */
// =============================================================
// 2MC Werbung — Service Worker
// =============================================================
// - install : app shell cache + skipWaiting
// - activate: eski cache temizliği + clients.claim
// - fetch   : HTML için network-first, asset için network-first + cache fallback
//             (yalnızca same-origin istekler cache'lenir)
// - push    : event.data.json() ile bildirim göster
// - notificationclick: mevcut sekmeyi bul/odakla, yoksa yeni pencere aç
// - message : main thread'den postMessage ile lokal bildirim göster
// =============================================================

const CACHE_VERSION = 'bac-handels-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/index.css',
];

// ------------ INSTALL ------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        await cache.addAll(APP_SHELL);
      } catch (err) {
        // Bazı asset'ler henüz yoksa kuruluma engel olma
        console.warn('[SW] App shell ön-cache kısmen başarısız:', err);
      }
      await self.skipWaiting();
    })()
  );
});

// ------------ ACTIVATE ------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ------------ FETCH (network-first + cache fallback, same-origin only) ------------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Sadece GET ve same-origin
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Realtime / API (Supabase) — cache'leme
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) return;

  const isHTML =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // JS/CSS chunk istekleri — yeni deployment'ta hash uyumsuzluğu varsa
  // server text/html dönerse cache'lemeyi reddet ve hatayı yukarı at;
  // istemcideki lazyWithRetry / ErrorBoundary tek seferlik reload yapar.
  const isScriptOrStyle =
    req.destination === 'script' ||
    req.destination === 'style' ||
    /\.(?:js|mjs|css|map)(?:\?|$)/i.test(url.pathname);

  event.respondWith(
    (async () => {
      try {
        const networkResp = await fetch(req);

        // GUARD: JS/CSS istendi ama server HTML döndüyse → eski hash, yeni deploy
        if (isScriptOrStyle && networkResp) {
          const ct = (networkResp.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('text/html')) {
            // Bu yanıtı CACHE'LEME ve istemciye HTML olarak da SERVE ETME;
            // bunun yerine 404 üret → import() doğru "load failed" fırlatır,
            // lazyWithRetry yakalar.
            return new Response('', {
              status: 404,
              statusText: 'Chunk not found (stale build)',
            });
          }
        }

        // Başarılı yanıtı arkadan cache'e koy
        if (networkResp && networkResp.ok && networkResp.type === 'basic') {
          const copy = networkResp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return networkResp;
      } catch (err) {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(req);
        if (cached) return cached;
        if (isHTML) {
          const fallback = await cache.match('/index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});

// ------------ PUSH ------------
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Düz metin geldiyse
    try {
      payload = { title: '2MC Werbung', body: event.data ? event.data.text() : '' };
    } catch {
      payload = { title: '2MC Werbung', body: 'Yeni bildirim' };
    }
  }

  const title = payload.title || '2MC Werbung';
  const options = {
    body: payload.body || '',
    icon:
      payload.icon ||
      'https://wgfkoxjlcovrkzrustpy.supabase.co/storage/v1/object/public/sales_receipts/logo_werbung%20(1).png',
    badge:
      payload.badge ||
      'https://wgfkoxjlcovrkzrustpy.supabase.co/storage/v1/object/public/sales_receipts/logo_werbung%20(1).png',
    tag: payload.tag || 'bac-handels-notification',
    requireInteraction: payload.requireInteraction === true,
    vibrate: payload.vibrate || [120, 60, 120],
    renotify: payload.renotify === true,
    data: {
      url: (payload.data && payload.data.url) || payload.url || '/',
      ...((payload.data && typeof payload.data === 'object') ? payload.data : {}),
    },
    actions: payload.actions || [
      { action: 'open', title: 'Aç' },
      { action: 'dismiss', title: 'Kapat' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ------------ NOTIFICATION CLICK ------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Aynı origin'de açık bir sekme varsa onu odakla
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            await client.focus();
            // Hash route'a yönlendir
            if ('navigate' in client) {
              try {
                await client.navigate(targetUrl);
              } catch {
                client.postMessage({ type: 'NAVIGATE', url: targetUrl });
              }
            } else {
              client.postMessage({ type: 'NAVIGATE', url: targetUrl });
            }
            return;
          }
        } catch {
          /* ignore */
        }
      }

      // Açık sekme yoksa yeni pencere aç
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});

// ------------ MESSAGE (main thread → SW) ------------
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'SHOW_NOTIFICATION') {
    const title = data.title || '2MC Werbung';
    const options = data.options || {};
    event.waitUntil(self.registration.showNotification(title, options));
  }
});
