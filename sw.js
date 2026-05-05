const CACHE = 'stagely-v121';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// Recevoir messages depuis l'app
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
  // Notif immédiate
  if (e.data?.type === 'NOTIF_NOW') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      tag: e.data.tag || 'stagely'
    });
  }
});

// Clic sur notification → ouvrir l'app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window'}).then(cls => {
      if (cls.length) return cls[0].focus();
      return clients.openWindow('/');
    })
  );
});
