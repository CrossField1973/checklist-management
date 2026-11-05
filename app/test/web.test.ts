import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { buildServer } from "../src/server.js";

let dir: string;
let withUi: ReturnType<typeof buildServer>;
let withoutUi: ReturnType<typeof buildServer>;

const INDEX = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';
const make = (env: Record<string, string>) => {
  const config = loadConfig({ APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "error", ...env });
  return buildServer({ config, db: openDatabase(":memory:"), logger: createLogger(config), mailer: null });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  withUi = make({ WEB_DIST: dir });
  // Bewusst ohne Oberfläche: ein Ordner ohne index.html wird nicht verwendet
  withoutUi = make({ WEB_DIST: join(dir, "assets") });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Auslieferung der Oberfläche", () => {
  it("liefert unbekannte Seiten als index.html, damit Neuladen und Direktlinks funktionieren", async () => {
    for (const url of ["/login", "/profile", "/templates", "/s/abc123token", "/reset-password?token=x", "/"]) {
      const res = await withUi.inject({ method: "GET", url });
      expect([url, res.statusCode]).toEqual([url, 200]);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe(INDEX);
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("liefert Dateien unter /assets/ unveränderlich zwischengespeichert, andere Dateien mit Revalidierung", async () => {
    const asset = await withUi.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["content-type"]).toContain("javascript");
    const icon = await withUi.inject({ method: "GET", url: "/favicon.svg" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("no-cache");
  });

  it("liefert für fehlende Dateien (z. B. veraltete /assets/*.js) 404 statt einer HTML-Seite, ebenso für Nicht-GET-Anfragen", async () => {
    for (const url of ["/assets/gibt-es-nicht.js", "/styles.css", "/bild.png?x=1", "/sourcemap.js.map"]) {
      const res = await withUi.inject({ method: "GET", url });
      expect([url, res.statusCode, res.json().error]).toEqual([url, 404, "not_found"]);
    }
    expect((await withUi.inject({ method: "POST", url: "/profile", payload: {} })).statusCode).toBe(404);
    expect((await withUi.inject({ method: "DELETE", url: "/login" })).statusCode).toBe(404);
  });

  it("lässt die API unberührt: unbekannte API-Pfade bleiben JSON-404, echte Routen funktionieren", async () => {
    for (const url of ["/api/v1/gibt-es-nicht", "/api/unbekannt", "/mcp/x"]) {
      const res = await withUi.inject({ method: "GET", url });
      expect([url, res.statusCode, res.json().error]).toEqual([url, 404, "not_found"]);
    }
    expect((await withUi.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    expect((await withUi.inject({ method: "GET", url: "/api/v1/config" })).statusCode).toBe(200);
    expect((await withUi.inject({ method: "GET", url: "/api/openapi.json" })).statusCode).toBe(200);
    expect((await withUi.inject({ method: "GET", url: "/api/v1/templates" })).statusCode).toBe(401); // geschützt wie zuvor
  });

  it("bedient HEAD-Anfragen für Seiten", async () => {
    const res = await withUi.inject({ method: "HEAD", url: "/profile" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it("läuft auch ohne gebaute Oberfläche (nur API) und liefert dann JSON-404", async () => {
    const res = await withoutUi.inject({ method: "GET", url: "/profile" });
    expect([res.statusCode, res.json().error]).toEqual([404, "not_found"]);
    expect((await withoutUi.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("Sicherheits-Header (N-03)", () => {
  it("setzt strenge Header auf Seiten und API-Antworten", async () => {
    for (const url of ["/login", "/api/v1/config", "/healthz", "/assets/index-abc123.js"]) {
      const h = (await withUi.inject({ method: "GET", url })).headers;
      expect(h["x-content-type-options"], url).toBe("nosniff");
      expect(h["x-frame-options"], url).toBe("DENY");
      expect(h["referrer-policy"], url).toBe("no-referrer");
      expect(h["permissions-policy"], url).toContain("camera=()");
      expect(h["cross-origin-opener-policy"], url).toBe("same-origin");
      const csp = String(h["content-security-policy"]);
      expect(csp, url).toContain("default-src 'self'");
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(csp, url).toContain("object-src 'none'");
      expect(csp, url).not.toMatch(/script-src[^;]*unsafe/);
    }
  });

  it("lässt die Swagger-Oberfläche ohne CSP (eigene Skripte), aber mit den übrigen Headern", async () => {
    const h = (await withUi.inject({ method: "GET", url: "/api/docs/" })).headers;
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
  });

  it("sendet HSTS nur bei https-Adresse", async () => {
    expect((await withUi.inject({ method: "GET", url: "/healthz" })).headers["strict-transport-security"]).toBeUndefined();
    const secure = make({ APP_BASE_URL: "https://checklisten.example.org", WEB_DIST: dir });
    expect((await secure.inject({ method: "GET", url: "/healthz" })).headers["strict-transport-security"]).toContain("max-age=31536000");
  });

  it("sichert auch Fehlerantworten (404/401) ab", async () => {
    const res = await withUi.inject({ method: "GET", url: "/api/v1/templates" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
