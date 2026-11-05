import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Wo die gebaute Oberfläche liegt: ausdrücklich gesetztes `WEB_DIST` (gilt dann allein – ohne index.html gibt es keine Oberfläche),
 * sonst im Docker-Image `dist/public`, sonst in der Entwicklung `web/dist`.
 */
export function findWebRoot(config: Pick<Config, "WEB_DIST">): string | null {
  const candidates = config.WEB_DIST ? [config.WEB_DIST] : [resolve(here, "public"), resolve(here, "../web/dist")];
  return candidates.find((p) => existsSync(resolve(p, "index.html"))) ?? null;
}

/** Pfade, die zur API gehören und nie die Oberfläche (index.html) liefern dürfen. */
const API_PREFIXES = ["/api/", "/mcp", "/healthz"];
const isApiPath = (url: string) => API_PREFIXES.some((p) => url === p.replace(/\/$/, "") || url.startsWith(p));
/** Adressen mit Dateiendung (z. B. fehlende /assets/*.js) sind Dateianfragen: dort ist eine HTML-Seite falsch, 404 richtig. */
const looksLikeFile = (url: string) => /\.[a-z0-9]{1,8}$/i.test(url.split("?")[0]!);

/**
 * Liefert die Web-Oberfläche (Single-Page-App) aus:
 * - Dateien unter /assets/ sind inhaltsbasiert benannt und werden ein Jahr unveränderlich zwischengespeichert.
 * - Alle anderen unbekannten GET-Adressen (außer API) erhalten index.html, damit Seiten wie /profile oder /s/<token>
 *   beim Neuladen funktionieren; index.html selbst wird nie zwischengespeichert, damit Updates sofort wirken.
 * - Unbekannte API-Pfade bleiben `404` mit JSON.
 */
export async function webPlugin(app: FastifyInstance, { config }: { config: Pick<Config, "WEB_DIST"> }) {
  const root = findWebRoot(config);
  app.setNotFoundHandler(async (req, reply) => {
    const wantsPage = (req.method === "GET" || req.method === "HEAD") && !isApiPath(req.url) && !looksLikeFile(req.url) && root !== null;
    if (!wantsPage) return reply.code(404).send({ error: "not_found" });
    return reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html");
  });
  if (!root) {
    app.log.info({ event: "web_missing" }, "Keine gebaute Oberfläche gefunden – nur die API wird ausgeliefert");
    return;
  }
  await app.register(fastifyStatic, {
    root,
    wildcard: false, // nur tatsächlich vorhandene Dateien als Routen; alles andere geht an den NotFound-Handler (SPA)
    index: false,
    setHeaders(res, path) {
      res.header("Cache-Control", path.replaceAll("\\", "/").includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
}
