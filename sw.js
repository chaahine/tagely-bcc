const CACHE = 'stagely-v1';
const ASSETS = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Notifications schedulées
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_NOTIF') {
    const { delay, title, body, tag } = e.data;
    setTimeout(() => {
      self.registration.showNotification(title, {
        body,
        tag,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [200, 100, 200],
        requireInteraction: true
      });
    }, delay);
  }
});
