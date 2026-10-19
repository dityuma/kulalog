/* Kulalog service worker.
   Bump VERSION whenever any app file changes, so installed copies pick up the update. */
const VERSION = "v7";
const CACHE = "kulalog-" + VERSION;

const APP_FILES = [
  "./",
  "index.html",
  "css/app.css",
  "js/logic.js",
  "js/app.js",
  "manifest.webmanifest",
  "kulalog-icons/icon.svg",
  "kulalog-icons/icon-maskable.svg",
  "kulalog-icons/favicon-32.png",
  "kulalog-icons/apple-touch-icon.png",
  "kulalog-icons/icon-192.png",
  "kulalog-icons/icon-512.png",
  "kulalog-icons/icon-maskable-192.png",
  "kulalog-icons/icon-maskable-512.png"
];
const CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
const FONTS_CSS = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&display=swap";
const CDN_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

// The font stylesheet lists the actual font files; fetch it and cache every file it points to.
async function cacheFonts(cache, signal){
  const res = await fetch(FONTS_CSS, { mode: "cors", signal });
  if(!res.ok) throw new Error("fonts css " + res.status);
  await cache.put(FONTS_CSS, res.clone());
  const css = await res.text();
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]))];
  await Promise.all(urls.map(async u => {
    const r = await fetch(u, { mode: "cors", signal });
    if(r.ok) await cache.put(u, r);
  }));
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The app files must all be cached, or the install fails and retries on the next visit.
    await cache.addAll(APP_FILES.map(u => new Request(u, { cache: "reload" })));
    // Chart.js and the fonts come from CDNs that can be slow or unreachable on a first visit. Without them the app
    // still works offline (no growth chart, system fonts), and the fetch handler below caches them on a later visit.
    // A CDN that hangs instead of failing must not keep the worker installing, so give it 10 seconds.
    const stop = new AbortController();
    const cdn = (async () => {
      try{ await cache.add(new Request(CHART_JS, { mode: "cors", signal: stop.signal })); }catch(e){}
      try{ await cacheFonts(cache, stop.signal); }catch(e){}
    })();
    await Promise.race([cdn, new Promise(r => setTimeout(r, 10_000))]);
    stop.abort();
    // First install: take over straight away. Updates wait for the user to tap Reload.
    if(!(await self.registration.active)) await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("kulalog-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if(event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);

  // Page loads: serve the cached app shell, whatever the query string or hash.
  if(req.mode === "navigate" && url.origin === location.origin){
    event.respondWith((async () => {
      const cached = await caches.match("index.html", { cacheName: CACHE });
      if(cached) return cached;
      return fetch(req);
    })());
    return;
  }

  // Own files and CDN files (Chart.js, fonts): cache first, then network, and keep what we fetch.
  if(url.origin === location.origin || CDN_HOSTS.includes(url.hostname)){
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreVary: true, ignoreSearch: url.origin === location.origin });
      if(cached) return cached;
      const res = await fetch(req);
      if(res.ok || res.type === "opaque") cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
  }
});
