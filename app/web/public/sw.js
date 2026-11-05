/* Service Worker (F-72, F-74): hält die App-Oberfläche offline bereit.
   Daten (/api) werden bewusst NICHT hier zwischengespeichert – das übernimmt die Anwendung selbst (IndexedDB, nach Anmeldung nutzerbezogen). */
const CACHE = "checklisten-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch("/", { cache: "no-store" });
    const html = await res.clone().text();
    await cache.put("/", res);
    // Alle in der Startseite verlinkten Dateien vorab laden, damit schon der erste Offline-Start klappt
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg|webmanifest))"/g)].map((m) => m[1]))];
    await Promise.all(assets.map((a) => cache.add(a).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp") || url.pathname === "/healthz") return; // Daten: immer direkt

  if (req.mode === "navigate") {
    // Seiten: online frisch, offline die zwischengespeicherte Oberfläche (SPA-Routen werden clientseitig aufgelöst)
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.headers.get("content-type")?.includes("text/html")) (await caches.open(CACHE)).put("/", res.clone());
        return res;
      } catch {
        return (await caches.match("/")) ?? Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Dateinamen enthalten einen Hash → unveränderlich
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit ?? Response.error());
    return hit ?? network;
  })());
});
