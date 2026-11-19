/*
 * Agent Deck's service worker: shows the notifications the server pushes (a session asks you,
 * finished its turn, CI failed), and opens the session when one is tapped.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = { title: "Agent Deck", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(m.title || "Agent Deck", {
      body: m.body || "",
      tag: m.tag,
      renotify: !!m.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: m.url || "/", key: m.key },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", key } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const page = open.find((c) => new URL(c.url).origin === self.location.origin);
      if (page) {
        await page.focus();
        if (key) page.postMessage({ open: key });
        return;
      }
      await self.clients.openWindow(new URL(url, self.location.origin).href);
    })(),
  );
});
