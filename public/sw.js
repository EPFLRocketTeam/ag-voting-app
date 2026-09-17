// sw.js -- minimal service worker, only here to receive Web Push messages
// and show a native notification even when no tab is open. It doesn't
// cache anything and doesn't intercept fetches -- the app works exactly the
// same with or without it registered.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {};
  }
  const title = data.title || 'Vote AG';
  const options = {
    body: data.body || '',
    icon: '/assets/favicon/android-chrome-192x192.png',
    badge: '/assets/favicon/favicon-32x32.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((allClients) => {
      for (const client of allClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
