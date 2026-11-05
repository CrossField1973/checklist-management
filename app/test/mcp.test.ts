import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase, schema } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { mcpToolNames } from "../src/mcp.js";
import { buildServer } from "../src/server.js";
import { GOOD_PASSWORD, newUser } from "./helpers.js";

type UserClient = Awaited<ReturnType<typeof newUser>>;

let app: ReturnType<typeof buildServer>;
let db: ReturnType<typeof openDatabase>;
let baseUrl: string;
let logLines: string[];
const clients: Client[] = [];

async function start(env: Record<string, string> = {}) {
  logLines = [];
  const config = loadConfig({ APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "info", ...env });
  db = openDatabase(":memory:");
  app = buildServer({ config, db, logger: createLogger(config, { write: (s: string) => void logLines.push(s) }), mailer: null });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}

beforeEach(() => start());
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await app.close();
  db.sqlite.close();
});

const createToken = async (user: UserClient, permission: "read" | "write" = "write") =>
  (await user.post("/api/v1/me/tokens", { name: `mcp-${permission}`, permission })).json().token as string;

/** Verbindet einen echten MCP-Client (offizielles SDK) über HTTP mit dem laufenden Server. */
async function connect(token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

/** Ruft ein Werkzeug auf und liefert den geparsten JSON-Text (oder den Fehlertext). */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* Fehlertext */ }
  return { isError: Boolean(res.isError), data, text };
}

describe("Werkzeugliste nach Token-Recht (F-64 bis F-66)", () => {
  it("Schreib-Token sehen alle Werkzeuge mit Beschreibung und Annotationen", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const client = await connect(await createToken(user, "write"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(mcpToolNames(true).sort());
    expect(tools).toHaveLength(17);
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["get_run", "get_template", "list_runs", "list_tags", "list_templates"]);
  });

  it("Lese-Token sehen ausschließlich lesende Werkzeuge", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const client = await connect(await createToken(user, "read"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_run", "get_template", "list_runs", "list_tags", "list_templates"]);
    expect(client.getInstructions()).toContain("nur Leserechte");
  });

  it("bietet bewusst kein Löschen, Archivieren, Teilen, Konto- oder Token-Verwaltung an", () => {
    const names = mcpToolNames(true).join(" ");
    expect(names).not.toMatch(/delete|remove|archive|complete|share|trash|token|password|account|import|export|reopen/);
  });
});

describe("Vorlagen lesen, erstellen, bearbeiten (F-65)", () => {
  it("legt Tags, Vorlage und verschachtelte Punkte an, ändert und verschiebt sie", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const c = await connect(await createToken(user));

    const tag = (await call(c, "create_tag", { name: "Reisen" })).data.tag;
    expect(tag.color).toMatch(/^#[0-9a-f]{6}$/); // automatische Farbe
    const tpl = (await call(c, "create_template", { title: "Tagesausflug", description: "Für unterwegs", tagIds: [tag.id] })).data.template;
    const rucksack = (await call(c, "add_template_item", { templateId: tpl.id, title: "Rucksack" })).data.itemId;
    await call(c, "add_template_item", { templateId: tpl.id, title: "Sonnencreme", parentItemId: rucksack });
    await call(c, "add_template_item", { templateId: tpl.id, title: "Route prüfen" });

    let got = (await call(c, "get_template", { templateId: tpl.id })).data.template;
    expect(got.tags.map((t: { name: string }) => t.name)).toEqual(["Reisen"]);
    expect(got.items.map((i: { title: string; children: { title: string }[] }) => [i.title, i.children.map((x) => x.title)])).toEqual([["Rucksack", ["Sonnencreme"]], ["Route prüfen", []]]);

    await call(c, "update_template", { templateId: tpl.id, title: "Ausflug", tagIds: [] });
    await call(c, "update_template_item", { itemId: rucksack, title: "Rucksack packen", description: "Wetterfest" });
    await call(c, "move_template_item", { itemId: got.items[1].id, parentItemId: null, position: 0 });
    got = (await call(c, "get_template", { templateId: tpl.id })).data.template;
    expect(got).toMatchObject({ title: "Ausflug", description: "Für unterwegs", tags: [] });
    expect(got.items.map((i: { title: string }) => i.title)).toEqual(["Route prüfen", "Rucksack packen"]);
    expect(got.items[1].description).toBe("Wetterfest");

    const list = (await call(c, "list_templates", { search: "ausf", sort: "title", limit: 10 })).data;
    expect(list.total).toBe(1);
    expect(list.templates[0]).toMatchObject({ title: "Ausflug", itemCount: 3 });
    expect((await call(c, "list_tags")).data.tags[0]).toMatchObject({ name: "Reisen", templateCount: 0 });
  });

  it("liefert dasselbe wie die REST-API (gleiche Regeln, gleiche Daten)", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const c = await connect(await createToken(user));
    const tpl = (await call(c, "create_template", { title: "V" })).data.template;
    await call(c, "add_template_item", { templateId: tpl.id, title: "a" });
    const viaMcp = (await call(c, "get_template", { templateId: tpl.id })).data;
    const viaRest = (await user.get(`/api/v1/templates/${tpl.id}`)).json();
    expect(viaMcp).toEqual(viaRest);
  });
});

describe("Durchführungen lesen, erstellen, bearbeiten (F-65)", () => {
  it("startet aus mehreren Vorlagen, ergänzt Vorlagen/Abschnitte/Punkte, hakt ab und verschiebt", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const c = await connect(await createToken(user));
    const mk = async (title: string, items: string[]) => {
      const t = (await call(c, "create_template", { title })).data.template.id as string;
      for (const i of items) await call(c, "add_template_item", { templateId: t, title: i });
      return t;
    };
    const [tag, therme, wandern] = [await mk("Tagesausflug", ["Proviant", "Route"]), await mk("Therme", ["Badesachen"]), await mk("Wandern", ["Schuhe", "Karte"])];

    const run = (await call(c, "create_run", { title: "Ausflug Füssen", templateIds: [tag, therme] })).data.run;
    expect(run.sections.map((s: { title: string }) => s.title)).toEqual(["Tagesausflug", "Therme"]);
    expect(run.progress).toEqual({ done: 0, total: 3 });

    let after = (await call(c, "add_templates_to_run", { runId: run.id, templateIds: [wandern] })).data.run;
    expect(after.sections.map((s: { title: string }) => s.title)).toEqual(["Tagesausflug", "Therme", "Wandern"]);
    after = (await call(c, "add_run_section", { runId: run.id, title: "Eigene Punkte" })).data.run;
    const own = after.sections[3];
    const added = (await call(c, "add_run_item", { sectionId: own.id, title: "Kuchen mitbringen" })).data;
    after = added.run;

    const schuhe = after.sections[2].items[0];
    after = (await call(c, "update_run_item", { itemId: schuhe.id, isChecked: true })).data.run;
    expect(after.progress).toEqual({ done: 1, total: 6 });
    expect(after.sections[2].items[0].checkedAt).toBeGreaterThan(0);

    after = (await call(c, "move_run_item", { itemId: added.itemId, sectionId: after.sections[0].id, parentItemId: null, position: 0 })).data.run;
    expect(after.sections[0].items[0].title).toBe("Kuchen mitbringen");
    expect(after.sections[3].items).toEqual([]);

    const list = (await call(c, "list_runs", { search: "füssen" })).data;
    expect(list.runs[0]).toMatchObject({ title: "Ausflug Füssen", share: null, progress: { done: 1, total: 6 } });
    expect((await call(c, "get_run", { runId: run.id })).data).toEqual((await user.get(`/api/v1/runs/${run.id}`)).json());
  });

  it("erkennt archivierte Durchführungen als schreibgeschützt und nennt den Grund", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const c = await connect(await createToken(user));
    const t = (await call(c, "create_template", { title: "V" })).data.template.id;
    await call(c, "add_template_item", { templateId: t, title: "a" });
    const run = (await call(c, "create_run", { title: "R", templateIds: [t] })).data.run;
    await user.post(`/api/v1/runs/${run.id}/archive`);
    const res = await call(c, "update_run_item", { itemId: run.sections[0].items[0].id, isChecked: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("run_not_active");
    expect(res.text).toContain("schreibgeschützt");
    expect((await call(c, "get_run", { runId: run.id })).isError).toBe(false); // Lesen bleibt möglich
    expect((await call(c, "list_runs", { status: "archived" })).data.total).toBe(1);
  });

  it("meldet verständliche Fehler (unbekannte ID, Zyklus, unbekannte Vorlage, ungültige Eingabe)", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const c = await connect(await createToken(user));
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call(c, "get_template", { templateId: unknown })).text).toContain("not_found");
    expect((await call(c, "create_run", { title: "X", templateIds: [unknown] })).text).toContain("unknown_template");
    const t = (await call(c, "create_template", { title: "V" })).data.template.id;
    const a = (await call(c, "add_template_item", { templateId: t, title: "a" })).data.itemId;
    const b = (await call(c, "add_template_item", { templateId: t, title: "b", parentItemId: a })).data.itemId;
    const cyc = await call(c, "move_template_item", { itemId: a, parentItemId: b, position: 0 });
    expect([cyc.isError, cyc.text.includes("cycle")]).toEqual([true, true]);
    // ungültige Eingaben: Fehlerergebnis oder Protokollfehler – auf keinen Fall ein Erfolg
    for (const args of [{ title: "" }, { title: "x", tagIds: ["kein-uuid"] }]) {
      const outcome = await client_call(c, "create_template", args);
      expect(outcome).toBe("error");
    }
    expect((await user.get("/api/v1/templates")).json().total).toBe(1);
  });
});

/** Liefert „error“, wenn ein Aufruf als Fehlerergebnis oder als Protokollfehler endet. */
async function client_call(c: Client, name: string, args: Record<string, unknown>) {
  try {
    const res = await c.callTool({ name, arguments: args });
    return res.isError ? "error" : "ok";
  } catch {
    return "error";
  }
}

describe("Rechte und Mandantentrennung (F-63, F-66, N-04)", () => {
  it("Lese-Token können schreibende Werkzeuge nicht aufrufen – auch nicht direkt per JSON-RPC", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user, "read");
    const c = await connect(token);
    expect(await client_call(c, "create_template", { title: "Neu" })).toBe("error");
    const raw = await app.inject({
      method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_template", arguments: { title: "Neu" } } },
    });
    const body = raw.json();
    expect(body.error?.message ?? body.result?.content?.[0]?.text).toMatch(/not found|Tool|nicht/i);
    expect((await user.get("/api/v1/templates")).json().total).toBe(0);
    // Lesen funktioniert
    expect((await call(c, "list_templates")).isError).toBe(false);
  });

  it("sieht nur Daten des Token-Besitzers", async () => {
    const anna = await newUser(app, "anna@example.org", "Anna");
    const bob = await newUser(app, "bob@example.org", "Bob");
    const annaTpl = (await anna.post("/api/v1/templates", { title: "Annas" })).json().template.id;
    const annaRun = (await anna.post("/api/v1/runs", { title: "Annas Lauf" })).json().run.id;
    const c = await connect(await createToken(bob));
    expect((await call(c, "list_templates")).data.total).toBe(0);
    expect((await call(c, "list_runs")).data.total).toBe(0);
    for (const [tool, args] of [["get_template", { templateId: annaTpl }], ["get_run", { runId: annaRun }], ["update_template", { templateId: annaTpl, title: "Gehackt" }], ["add_templates_to_run", { runId: annaRun, templateIds: [annaTpl] }]] as const) {
      const res = await call(c, tool, args);
      expect([tool, res.isError, res.text.includes("not_found") || res.text.includes("unknown_template")]).toEqual([tool, true, true]);
    }
    expect((await anna.get(`/api/v1/templates/${annaTpl}`)).json().template.title).toBe("Annas");
  });
});

describe("Authentifizierung des Endpunkts (F-63)", () => {
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const headers = (extra: Record<string, string> = {}) => ({ accept: "application/json, text/event-stream", "content-type": "application/json", ...extra });

  it("verlangt einen API-Token: ohne, mit ungültigem oder nur mit Cookie → 401", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const none = await app.inject({ method: "POST", url: "/mcp", headers: headers(), payload: rpc });
    expect([none.statusCode, none.headers["www-authenticate"]]).toEqual([401, "Bearer"]);
    const bad = await app.inject({ method: "POST", url: "/mcp", headers: headers({ authorization: "Bearer ck_falsch" }), payload: rpc });
    expect(bad.statusCode).toBe(401);
    const cookie = await app.inject({ method: "POST", url: "/mcp", headers: headers(), payload: rpc, cookies: { session: user.session } });
    expect(cookie.statusCode).toBe(401); // Cookie-Sitzungen sind für MCP nicht erlaubt
  });

  it("lehnt widerrufene und abgelaufene Token ab", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user);
    const ok = await app.inject({ method: "POST", url: "/mcp", headers: headers({ authorization: `Bearer ${token}` }), payload: rpc });
    expect(ok.statusCode).toBe(200);
    db.update(schema.apiTokens).set({ expiresAt: Date.now() - 1 }).run();
    expect((await app.inject({ method: "POST", url: "/mcp", headers: headers({ authorization: `Bearer ${token}` }), payload: rpc })).json().error).toBe("token_expired");
    const fresh = await createToken(user);
    const id = (await user.get("/api/v1/me/tokens")).json().tokens.find((t: { prefix: string }) => fresh.startsWith(t.prefix)).id;
    await user.del(`/api/v1/me/tokens/${id}`);
    expect((await app.inject({ method: "POST", url: "/mcp", headers: headers({ authorization: `Bearer ${fresh}` }), payload: rpc })).statusCode).toBe(401);
  });

  it("schützt vor fremdem Origin (DNS-Rebinding) und erlaubt den eigenen", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user);
    const send = (origin: string) => app.inject({ method: "POST", url: "/mcp", headers: headers({ authorization: `Bearer ${token}`, origin }), payload: rpc });
    expect((await send("https://evil.example")).statusCode).toBe(403);
    expect((await send("http://localhost:3000")).statusCode).toBe(200);
  });

  it("ist zustandslos: GET und DELETE liefern 405 mit Allow: POST", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user);
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp", headers: { authorization: `Bearer ${token}` } });
      expect([res.statusCode, res.headers.allow]).toEqual([405, "POST"]);
    }
  });
});

describe("Rate-Limit und Protokollierung (F-66, F-37)", () => {
  it("zählt jede MCP-Anfrage einmal – interne API-Aufrufe der Werkzeuge zählen nicht doppelt", async () => {
    await app.close();
    db.sqlite.close();
    await start({ API_RATE_LIMIT_PER_MINUTE: "4" });
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user);
    const rpc = (id: number, name: string, args: object) => app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    });
    // vier Werkzeugaufrufe mit jeweils mehreren inneren Aufrufen müssen durchgehen …
    const codes: number[] = [];
    for (let i = 1; i <= 4; i++) codes.push((await rpc(i, "create_template", { title: `T${i}` })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
    // … die fünfte Anfrage überschreitet das Limit von 4
    const blocked = await rpc(5, "create_template", { title: "T5" });
    expect([blocked.statusCode, blocked.json().error]).toEqual([429, "rate_limited"]);
    expect((await user.get("/api/v1/templates")).json().total).toBe(4);
  });

  it("protokolliert Werkzeugaufrufe ohne Inhalte und ohne Token", async () => {
    const user = await newUser(app, "anna@example.org", "Anna");
    const token = await createToken(user);
    const c = await connect(token);
    await call(c, "create_template", { title: "Streng geheimer Titel", description: "Vertrauliche Beschreibung" });
    await call(c, "get_template", { templateId: "00000000-0000-4000-8000-000000000000" });
    const log = logLines.join("\n");
    expect(log).toContain('"event":"mcp_tool_call"');
    expect(log).toContain('"tool":"create_template"');
    expect(log).toContain('"ok":false'); // der fehlgeschlagene Aufruf
    for (const secret of [token, "Streng geheimer Titel", "Vertrauliche Beschreibung", GOOD_PASSWORD]) expect(log).not.toContain(secret);
    const toolCalls = logLines.filter((l) => l.includes("mcp_tool_call"));
    expect(toolCalls).toHaveLength(2);
    expect(logLines.filter((l) => l.includes('"event":"api_token_used"'))).toHaveLength(1); // nur der äußere Aufruf, nicht die internen
  });

  it("macht den internen Aufruf-Header von außen unbrauchbar: Rate-Limit und Lese-Schutz bleiben aktiv", async () => {
    await app.close();
    db.sqlite.close();
    await start({ API_RATE_LIMIT_PER_MINUTE: "3" });
    const user = await newUser(app, "anna@example.org", "Anna");
    const readToken = await createToken(user, "read");
    const writeToken = await createToken(user, "write");
    // Ein Angreifer setzt den Header, kennt aber das Geheimnis nicht.
    const get = (token: string, headers: Record<string, string> = {}) =>
      app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: `Bearer ${token}`, "x-internal-call": "geraten", ...headers } });
    expect([(await get(writeToken)).statusCode, (await get(writeToken)).statusCode, (await get(writeToken)).statusCode]).toEqual([200, 200, 200]);
    const blocked = await get(writeToken);
    expect([blocked.statusCode, blocked.json().error]).toEqual([429, "rate_limited"]); // Header umgeht das Limit nicht
    const write = await app.inject({ method: "POST", url: "/api/v1/templates", payload: { title: "X" }, headers: { authorization: `Bearer ${readToken}`, "x-internal-call": "geraten" } });
    expect([write.statusCode, write.json().error]).toEqual([403, "token_read_only"]);
  });
});
