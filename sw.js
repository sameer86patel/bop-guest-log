/* Keeps the app's own files on the phone so it opens instantly, even without internet.
   Calls to Google (saving entries, sync) are never stored here.
   When you change any app file, raise the number in APP_VERSION in app.js and VERSION below. */
const VERSION = "2.1.0";
const CACHE = "bop-shell-" + VERSION;
const FONTS = "bop-fonts";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest",
  "img/logo.webp", "img/banner.webp", "img/icon-192.png", "img/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.indexOf("bop-shell-") === 0 && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Show the stored copy straight away and refresh it in the background for next time
    const key = req.mode === "navigate" ? "index.html" : req;
    const stored = caches.open(CACHE).then(c => c.match(key, {ignoreSearch: true}));
    const fresh = fetch(req, {cache: "no-cache"}).then(async res => {
      if (res && res.ok) await (await caches.open(CACHE)).put(key, res.clone());
      return res;
    });
    e.respondWith(stored.then(hit => hit || fresh));
    e.waitUntil(fresh.then(() => {}, () => {}));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
      return res;
    }));
  }
});
