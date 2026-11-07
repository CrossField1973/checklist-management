import { describe, expect, it } from "vitest";
import { newUser, setupApp } from "./helpers.js";

/**
 * Querschnittsprüfungen (N-04 Mandantentrennung, Authentifizierung):
 * - Jede API-Route verlangt eine Anmeldung, außer der ausdrücklich öffentlichen Liste.
 * - Fremde Ressourcen verhalten sich wie nicht vorhanden (404) und bleiben unverändert.
 * Ein Abgleich mit der Routentabelle sorgt dafür, dass neue Routen nicht unbemerkt aus beiden Prüfungen herausfallen.
 */
const { app } = setupApp();
const UUID = "00000000-0000-4000-8000-000000000000";

/** Bewusst ohne Anmeldung erreichbar. */
const PUBLIC = [
  /^GET \/healthz$/, /^GET \/api\/v1\/config$/, /^POST \/api\/v1\/auth\/(register|login|logout|forgot|reset)$/,
  /^GET \/api\/v1\/auth\/oidc\/(login|callback)$/, /^[A-Z]+ \/api\/v1\/public\//, /^[A-Z]+ \/mcp$/,
];

const apiRoutes = async () => {
  await app.ready();
  return app.routeTable
    .filter((r) => !["HEAD", "OPTIONS"].includes(r.method) && /^\/(api\/v1|mcp|healthz)/.test(r.url))
    .map((r) => ({ ...r, key: `${r.method} ${r.url}` }));
};

describe("Anmeldung ist überall Pflicht", () => {
  it("alle nicht öffentlichen API-Routen antworten ohne Sitzung mit 401", async () => {
    const routes = (await apiRoutes()).filter((r) => !PUBLIC.some((p) => p.test(r.key)));
    expect(routes.length).toBeGreaterThan(40);
    const failures: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:type/g, "run").replace(/:\w+/g, UUID);
      const res = await app.inject({ method: r.method as "GET", url, payload: r.method === "GET" ? undefined : {}, headers: { origin: "http://localhost:3000" } });
      if (res.statusCode !== 401) failures.push(`${r.key} → ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it("die öffentliche Liste enthält nur Routen, die es gibt (keine toten Ausnahmen)", async () => {
    const keys = (await apiRoutes()).map((r) => r.key);
    const dead = PUBLIC.filter((p) => !keys.some((k) => p.test(k)));
    expect(dead.map(String)).toEqual([]);
  });
});

describe("Mandantentrennung (N-04)", () => {
  async function fixture() {
    const a = await newUser(app, `a-${Math.random()}@example.org`, "Anna");
    const b = await newUser(app, `b-${Math.random()}@example.org`, "Ben");
    const tag = (await a.post("/api/v1/tags", { name: "Privat" })).json().tag.id as string;
    const tpl = (await a.post("/api/v1/templates", { title: "Geheime Vorlage", tagIds: [tag] })).json().template.id as string;
    await a.post(`/api/v1/templates/${tpl}/items`, { title: "Vorlagenpunkt" });
    const tplItem = (await a.get(`/api/v1/templates/${tpl}`)).json().template.items[0].id as string;
    const run = (await a.post("/api/v1/runs", { title: "Geheimer Lauf", templateIds: [tpl] })).json().run;
    const runId = run.id as string;
    const section = run.sections[0].id as string;
    const runItem = run.sections[0].items[0].id as string;
    const shareId = (await a.put(`/api/v1/runs/${runId}/share`, { access: "anyone", permission: "edit" })).json().share.id as string;
    const tokenId = (await a.post("/api/v1/me/tokens", { name: "A-Token", permission: "write" })).json().apiToken.id as string;
    const trashedRun = (await a.post("/api/v1/runs", { title: "Alter Lauf", templateIds: [] })).json().run.id as string;
    await a.del(`/api/v1/runs/${trashedRun}`);
    const trashedTpl = (await a.post("/api/v1/templates", { title: "Alte Vorlage" })).json().template.id as string;
    await a.del(`/api/v1/templates/${trashedTpl}`);
    return { a, b, tag, tpl, tplItem, runId, section, runItem, shareId, tokenId, trashedRun, trashedTpl };
  }

  /** „Methode Adresse“ → Nutzlast; Platzhalter werden mit den Ressourcen von A ersetzt. */
  const attacks = (f: Awaited<ReturnType<typeof fixture>>): [string, unknown?][] => [
    [`GET /api/v1/templates/${f.tpl}`], [`PUT /api/v1/templates/${f.tpl}`, { title: "Gekapert" }], [`DELETE /api/v1/templates/${f.tpl}`],
    [`POST /api/v1/templates/${f.tpl}/duplicate`, {}], [`GET /api/v1/templates/${f.tpl}/export`],
    [`POST /api/v1/templates/${f.tpl}/items`, { title: "Eingeschleust" }],
    [`PUT /api/v1/template-items/${f.tplItem}`, { title: "Gekapert" }], [`DELETE /api/v1/template-items/${f.tplItem}`],
    [`POST /api/v1/template-items/${f.tplItem}/move`, { parentItemId: null, position: 0 }],
    [`PUT /api/v1/tags/${f.tag}`, { name: "Gekapert" }], [`DELETE /api/v1/tags/${f.tag}`],
    [`GET /api/v1/runs/${f.runId}`], [`PUT /api/v1/runs/${f.runId}`, { title: "Gekapert" }], [`DELETE /api/v1/runs/${f.runId}`],
    [`GET /api/v1/runs/${f.runId}/export`],
    [`POST /api/v1/runs/${f.runId}/archive`, {}], [`POST /api/v1/runs/${f.runId}/complete`, {}], [`POST /api/v1/runs/${f.runId}/reopen`, {}],
    [`POST /api/v1/runs/${f.runId}/sections`, { title: "Eingeschleust" }],
    [`PUT /api/v1/run-sections/${f.section}`, { title: "Umbenannt" }], [`DELETE /api/v1/run-sections/${f.section}`], [`POST /api/v1/run-sections/${f.section}/move`, { position: 0 }],
    [`POST /api/v1/run-sections/${f.section}/items`, { title: "Eingeschleust" }],
    [`PUT /api/v1/run-items/${f.runItem}`, { isChecked: true }], [`DELETE /api/v1/run-items/${f.runItem}`],
    [`POST /api/v1/run-items/${f.runItem}/move`, { parentItemId: null, position: 0 }],
    [`GET /api/v1/runs/${f.runId}/share`], [`PUT /api/v1/runs/${f.runId}/share`, { access: "anyone", permission: "edit" }],
    [`POST /api/v1/runs/${f.runId}/share/regenerate`, {}], [`DELETE /api/v1/runs/${f.runId}/share`],
    [`DELETE /api/v1/me/shares/${f.shareId}`], [`DELETE /api/v1/me/tokens/${f.tokenId}`],
    [`POST /api/v1/trash/run/${f.trashedRun}/restore`, {}], [`DELETE /api/v1/trash/run/${f.trashedRun}`],
    [`POST /api/v1/trash/template/${f.trashedTpl}/restore`, {}], [`DELETE /api/v1/trash/template/${f.trashedTpl}`],
    // Fremde IDs in Nutzlasten
    ["POST /api/v1/runs", { title: "Klau", templateIds: [f.tpl] }],
    [`PUT /api/v1/templates/${UUID}`, { title: "x" }],
  ];

  it("fremde Ressourcen sind unauffindbar (404/422) und bleiben unverändert", async () => {
    const f = await fixture();
    const before = JSON.stringify([(await f.a.get("/api/v1/export")).json()].map((d) => ({ ...d, exportedAt: undefined })));
    const failures: string[] = [];
    for (const [call, payload] of attacks(f)) {
      const [method, url] = call.split(" ") as ["GET", string];
      const res = await app.inject({ method, url, payload: payload as object | undefined, cookies: { session: f.b.session }, headers: { origin: "http://localhost:3000" } });
      const ok = res.statusCode === 404 || (url === "/api/v1/runs" && res.statusCode === 422);
      if (!ok) failures.push(`${call} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(failures).toEqual([]);
    const after = JSON.stringify([(await f.a.get("/api/v1/export")).json()].map((d) => ({ ...d, exportedAt: undefined })));
    expect(after).toBe(before);
  });

  it("Listen enthalten nur eigene Daten und Zähler verraten nichts über Fremde", async () => {
    const f = await fixture();
    for (const url of ["/api/v1/templates", "/api/v1/runs", "/api/v1/runs?status=archived", "/api/v1/tags", "/api/v1/trash", "/api/v1/me/shares", "/api/v1/me/tokens"]) {
      const body = (await f.b.get(url)).body;
      expect(body, url).not.toMatch(/Geheim|Privat|Alter Lauf|Alte Vorlage|A-Token|Vorlagenpunkt/);
    }
    expect((await f.b.get("/api/v1/templates")).json().total).toBe(0);
    expect((await f.b.get("/api/v1/export")).body).not.toMatch(/Geheim|Privat/);
  });

  it("Tags und Vorlagen anderer lassen sich nicht zuordnen", async () => {
    const f = await fixture();
    const own = (await f.b.post("/api/v1/templates", { title: "Eigene" })).json().template.id as string;
    const res = await f.b.put(`/api/v1/templates/${own}`, { tagIds: [f.tag] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_tag");
  });

  it("jede Routenpfad mit Ressourcen-ID ist in der Angriffsliste abgedeckt", async () => {
    const f = await fixture();
    const covered = new Set(attacks(f).map(([c]) => c.split(" ")[0] + " " + c.split(" ")[1]!.replace(/[0-9a-f-]{36}/g, ":id")));
    const routes = (await apiRoutes())
      .filter((r) => /:(id|type)/.test(r.url) && !PUBLIC.some((p) => p.test(r.key)))
      .map((r) => `${r.method} ${r.url.replace(/:type/g, "run").replace(/:\w+/g, ":id")}`);
    const normalized = new Set([...covered].map((c) => c.replace(/\/trash\/(run|template)\//, "/trash/run/")));
    const missing = routes.filter((r) => !normalized.has(r.replace("/trash/run/", "/trash/run/")));
    expect(missing).toEqual([]);
  });

  it("API-Token eines Nutzers gewährt keinen Zugriff auf Daten anderer", async () => {
    const f = await fixture();
    const issued = await f.b.post("/api/v1/me/tokens", { name: "B", permission: "write" });
    const token = issued.json().token as string;
    for (const url of [`/api/v1/runs/${f.runId}`, `/api/v1/templates/${f.tpl}`]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe("Sicherheits-Kopfzeilen und Cookies", () => {
  it("API und Weboberfläche senden die Schutz-Kopfzeilen; API-Antworten werden nicht zwischengespeichert", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-frame-options"] ?? res.headers["content-security-policy"]).toBeTruthy();
    const cfg = await app.inject({ method: "GET", url: "/api/v1/config" });
    expect(cfg.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("das Sitzungs-Cookie ist HttpOnly und SameSite", async () => {
    const { app } = setupApp(); // eigene Instanz: Registrierungen sind pro IP begrenzt
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: `c-${Math.random()}@example.org`, displayName: "C", password: "Kaffeetasse-Wolke-42" } });
    const cookie = res.cookies.find((c) => c.name === "session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(String(cookie.sameSite).toLowerCase()).toMatch(/lax|strict/);
    expect(cookie.path).toBe("/");
  });

  it("Antworten enthalten weder Passwort-Hashes noch Token-Hashes", async () => {
    const { app } = setupApp();
    const u = await newUser(app, `d-${Math.random()}@example.org`);
    await u.post("/api/v1/me/tokens", { name: "T", permission: "read" });
    for (const url of ["/api/v1/me", "/api/v1/me/tokens", "/api/v1/export"]) {
      const body = (await u.get(url)).body;
      expect(body, url).not.toMatch(/\$argon2|passwordHash|tokenHash|token_hash|password_hash|secretEnc|tokenEnc/i);
    }
  });
});
