// Service worker: enables Web Push delivery (including iOS, which only
// delivers push to a home-screen-installed PWA, never a plain browser tab)
// and, while a tab is open, forwards the event to it so the app can
// auto-refresh instantly instead of waiting on its polling fallback.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = { title: "Warehouse · Quality", body: "" };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // ignore malformed payloads
  }

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(payload.title || "Warehouse · Quality", {
        body: payload.body || "",
        tag: payload.kind || "notification",
        data: payload,
      });

      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "push-received", payload });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => "focus" in c);
      if (existing) return existing.focus();
      return self.clients.openWindow("/app");
    })()
  );
});
