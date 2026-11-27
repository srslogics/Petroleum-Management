"use strict";

const OFFLINE_CACHE = "tuljai-offline-v4";
const OFFLINE_PAGE = "/offline.html";
const OFFLINE_FILES = [OFFLINE_PAGE, "/theme.css", "/offline.css", "/typography.css", "/fonts/inter-latin.woff2", "/fonts/inter-latin-ext.woff2", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(cache => cache.addAll(OFFLINE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith("tuljai-offline-") && key !== OFFLINE_CACHE).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Cache only the public offline screen and its unversioned assets.
  if (request.mode === "navigate" && ["/", "/owner", "/manager"].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => {
      const fallback = await caches.match(OFFLINE_PAGE);
      return fallback || Response.error();
    }));
  } else if (!url.search && OFFLINE_FILES.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
