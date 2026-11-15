/* SendFair service worker. The shell (styles, fonts, scripts, icons) is kept on
   the device. Pages are asked from the network first. Rate files are never cached,
   so an old quote cannot be shown as today's. */
const CACHE = "sendfair-__VERSION__";
const OFFLINE = "/offline";
const SHELL = __SHELL__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function isLiveData(url) {
  return url.pathname.startsWith("/data/") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/go/") || url.pathname.startsWith("/admin");
}
function isShellAsset(url) {
  return url.pathname.startsWith("/assets/") || url.pathname.startsWith("/logos/") || url.pathname === "/favicon.svg" || url.pathname === "/favicon-48.png" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png" || url.pathname === "/manifest.webmanifest";
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || isLiveData(url)) return;
  if (isShellAsset(url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (req.mode !== "navigate") return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match(OFFLINE))));
});
