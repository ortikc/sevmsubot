/* The offline worker. The server stamps VERSION with the state of the app's files, so after any change
   browsers find a new worker: it saves the new app shell and drops the old one.

   - the shell (page, script, styles, icons, the two documents) comes from the saved copy: instantly, and offline;
   - API reads of the app on a home screen (they carry the device's key) go to the network and are saved;
     without the network the saved answer comes back marked X-Saved-At, so the app knows it is offline;
   - photos, the font and Telegram's script: the saved copy at once, refreshed in the background.
   Reads signed by Telegram (the Mini App) are never saved: one phone can hold several Telegram accounts. */

const VERSION = "__VERSION__";
const SHELL = `shell-${VERSION}`;
const DATA = "data";     // API answers, kept across versions; the app clears it when it signs out
const FILES = "files";   // photos, the font, Telegram's script
const FILES_MAX = 300;
const SLOW_MS = 6000;    // a network this slow counts as none
const SHELL_FILES = ["/", "/app.js", "/app.css", "/privacy.html", "/consent.html", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-48.png"];
const SAVED_ELSEWHERE = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (SAVED_ELSEWHERE.test(url.hostname)) e.respondWith(savedFirst(e));
    return;
  }
  const path = url.pathname;
  if (req.mode === "navigate" && (path === "/" || path === "/index.html")) e.respondWith(fromShell("/"));
  else if (SHELL_FILES.includes(path)) e.respondWith(fromShell(path));
  else if (path.startsWith("/api/") && req.headers.has("Authorization")) e.respondWith(networkFirst(req));
  else if (path.startsWith("/avatars/") || path.startsWith("/posts/")) e.respondWith(savedFirst(e));
});

async function fromShell(path) {
  const hit = await (await caches.open(SHELL)).match(path);
  return hit || fetch(path);
}

async function networkFirst(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, fail) => setTimeout(() => fail(new Error("slow")), SLOW_MS))]);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("X-Saved-At", new Date().toISOString());
      await cache.put(req, new Response(await res.clone().blob(), { status: res.status, headers }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function savedFirst(e) {
  const req = e.request;
  const cache = await caches.open(FILES);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(async (res) => {
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - FILES_MAX)).map((k) => cache.delete(k)));
    }
    return res;
  }).catch(() => hit || Response.error());
  if (!hit) return fresh;
  e.waitUntil(fresh);   // the refresh outlives the answer
  return hit;
}
