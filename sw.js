/* Maschinenpark – Service Worker: Offline-Start + Push-Benachrichtigungen */
importScripts("firebase-config.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

const CACHE = "maschinenpark-v4";
const SHELL = ["./", "index.html", "firebase-config.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png", "logo.png"];

self.addEventListener("install", e => {
  // Einzeln cachen: fehlt eine Datei, klappt die Installation trotzdem.
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Eigene Dateien: erst Netz (damit Updates sofort ankommen), ohne Netz aus dem Cache.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});

// Push: Firebase zeigt Nachrichten mit Titel/Text im Hintergrund selbst an.
const cfg = self.FIREBASE_CONFIG || {};
if (cfg.apiKey && !String(cfg.apiKey).includes("HIER")) {
  firebase.initializeApp(cfg);
  firebase.messaging();
}

// Tippen auf die Benachrichtigung öffnet die App (oder holt sie nach vorn).
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
