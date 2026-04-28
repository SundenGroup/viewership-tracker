/**
 * Clutch Viewership Tracker — Service Worker.
 *
 * Minimal, push-only. We do not cache app shell here (Vite already
 * fingerprints assets and the SPA reloads on deploy). The SW exists to:
 *   1. Receive Web Push messages from the server.
 *   2. Show OS notifications.
 *   3. Open / focus the right URL when the user clicks the notification.
 *
 * The server sends a JSON payload with this shape:
 *   { title, body, url, tag, urgent }
 */

const FALLBACK_ICON = '/favicon-192.png';

self.addEventListener('install', () => {
  // Activate the new SW immediately on install — no waiting for old tabs
  // to close, since we have no caching to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: 'Clutch Tracker', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Clutch Tracker';
  const options = {
    body: data.body || '',
    icon: FALLBACK_ICON,
    badge: FALLBACK_ICON,
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    requireInteraction: data.urgent === true,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Try to focus an existing tracker tab and navigate it
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin) {
            await client.focus();
            if (typeof client.navigate === 'function') {
              await client.navigate(targetUrl);
            }
            return;
          }
        } catch (_e) {
          // ignore
        }
      }
      // Otherwise open a new tab
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
