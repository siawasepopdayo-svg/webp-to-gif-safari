const CACHE_NAME = "webp-to-gif-v1";
const ASSETS = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./gif.js",
  "./site.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
