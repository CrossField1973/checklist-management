import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "../src/db/index.js";
import { LIMITS } from "../src/services/import.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
interface Issue { path: string; message: string }

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

const json = (body: string) => JSON.parse(body);
const importJson = (client: Client, content: unknown, extra: object = {}) => client.post("/api/v1/import", { format: "json", content, ...extra });
const importCsv = (client: Client, content: string, extra: object = {}) => client.post("/api/v1/import", { format: "csv", content, ...extra });

/** Baut bei Anna einen reichhaltigen Datenbestand auf (Tags mit Farbe, verschachtelte Vorlagen, aktive und archivierte Durchführung). */
async function seed(client: Client) {
  const tagA = (await client.post("/api/v1/tags", { name: "Reisen", color: "#2563eb" })).json().tag.id;
  const tagB = (await client.post("/api/v1/tags", { name: "Outdoor", color: "#16a34a" })).json().tag.id;
  const mk = async (title: string, tagIds: string[], structure: (string | [string, string[]])[], description?: string) => {
    const t = (await client.post("/api/v1/templates", { title, tagIds, ...(description && { description }) })).json().template.id as string;
    for (const e of structure) {
      const [name, kids] = Array.isArray(e) ? e : [e, []];
      const parent = (await client.post(`/api/v1/templates/${t}/items`, { title: name, description: name === "Rucksack" ? "Wetterfest, 30 l" : undefined })).json().itemId;
      for (const k of kids) await client.post(`/api/v1/templates/${t}/items`, { title: k, parentItemId: parent });
    }
    return t;
  };
  const tag = await mk("Tagesausflug", [tagA, tagB], [["Rucksack", ["Sonnencreme", "Regenjacke"]], "Route prüfen"], "Für unterwegs");
  const therme = await mk("Therme", [tagA], ["Badesachen", "Handtuch"]);
  const run = (await client.post("/api/v1/runs", { title: "Ausflug Füssen", templateIds: [tag, therme] })).json().run;
  await client.put(`/api/v1/run-items/${run.sections[0].items[0].children[0].id}`, { isChecked: true });
  await client.put(`/api/v1/run-items/${run.sections[1].items[0].id}`, { isChecked: true });
  const archived = (await client.post("/api/v1/runs", { title: "Skiwochenende", templateIds: [therme] })).json().run;
  await client.post(`/api/v1/runs/${archived.id}/archive`);
  return { tag, therme, run, archived };
}

/** Entfernt Felder, die sich beim Import naturgemäß ändern (Zeitpunkte der Anlage/Archivierung/Export). */
const normalize = (doc: any) => {
  const copy = structuredClone(doc);
  delete copy.exportedAt;
  for (const r of copy.runs ?? []) { delete r.createdAt; delete r.archivedAt; }
  return copy;
};

describe("Export (F-50)", () => {
  it("liefert alle eigenen Daten als JSON-Download ohne IDs und Geheimnisse; Papierkorb bleibt draußen", async () => {
    const s = await seed(anna);
    const gone = (await anna.post("/api/v1/templates", { title: "Im Papierkorb" })).json().template.id;
    await anna.del(`/api/v1/templates/${gone}`);
    await anna.put(`/api/v1/runs/${s.run.id}/share`, { access: "password", permission: "edit", password: "geheimes-passwort" });

    const res = await anna.get("/api/v1/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="checklisten-daten-\d{4}-\d{2}-\d{2}\.json"/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const doc = json(res.body);
    expect(doc).toMatchObject({ format: "checklisten-export", version: 1 });
    expect(doc.templates.map((t: { title: string }) => t.title)).toEqual(["Tagesausflug", "Therme"]);
    expect(doc.runs.map((r: { title: string; status: string }) => [r.title, r.status])).toEqual([["Ausflug Füssen", "active"], ["Skiwochenende", "archived"]]);
    expect(doc.tags).toEqual([{ name: "Outdoor", color: "#16a34a" }, { name: "Reisen", color: "#2563eb" }]);
    expect(res.body).not.toMatch(/Im Papierkorb|passwordHash|tokenHash|argon2|geheimes-passwort|"id"|ownerId|\/s\//);
    expect(doc.templates[0].items[0]).toEqual({
      title: "Rucksack", description: "Wetterfest, 30 l",
      children: [{ title: "Sonnencreme", description: null, children: [] }, { title: "Regenjacke", description: null, children: [] }],
    });
  });

  it("exportiert eine Vorlage als JSON, CSV (alle Trennzeichen) und Markdown", async () => {
    const s = await seed(anna);
    const get = (q: string) => anna.get(`/api/v1/templates/${s.tag}/export${q}`);

    const csv = await get("?format=csv");
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toContain("tagesausflug-");
    expect(csv.body.startsWith("﻿Vorlage,Ebene,Titel,Beschreibung\r\n")).toBe(true);
    expect(csv.body).toContain("Tagesausflug,1,Rucksack,\"Wetterfest, 30 l\"\r\n");
    expect(csv.body).toContain("Tagesausflug,2,Sonnencreme,\r\n");
    expect((await get("?format=csv&delimiter=semicolon")).body).toContain("Tagesausflug;2;Regenjacke;\r\n");
    expect((await get("?format=csv&delimiter=tab")).body).toContain("Tagesausflug\t1\tRoute prüfen\t\r\n");

    const md = await get("?format=md");
    expect(md.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(md.body).toBe("# Tagesausflug\n\nFür unterwegs\n\nTags: Outdoor, Reisen\n\n- Rucksack – Wetterfest, 30 l\n  - Sonnencreme\n  - Regenjacke\n- Route prüfen\n");

    const one = json((await get("")).body);
    expect(one.templates).toHaveLength(1);
    expect(one.templates[0].tags).toEqual(["Outdoor", "Reisen"]);
  });

  it("exportiert eine Durchführung als CSV und Markdown mit Abhak-Status", async () => {
    const s = await seed(anna);
    const csv = (await anna.get(`/api/v1/runs/${s.run.id}/export?format=csv&delimiter=semicolon`)).body;
    expect(csv.split("\r\n")[0]).toBe("﻿Abschnitt;Ebene;Titel;Beschreibung;Erledigt;Erledigt am");
    expect(csv).toMatch(/Tagesausflug;2;Sonnencreme;;ja;\d{4}-\d{2}-\d{2}T/);
    expect(csv).toContain("Tagesausflug;2;Regenjacke;;nein;\r\n");
    const md = (await anna.get(`/api/v1/runs/${s.run.id}/export?format=md`)).body;
    expect(md).toBe("# Ausflug Füssen\n\n## Tagesausflug\n\n- [ ] Rucksack – Wetterfest, 30 l\n  - [x] Sonnencreme\n  - [ ] Regenjacke\n- [ ] Route prüfen\n\n## Therme\n\n- [x] Badesachen\n- [ ] Handtuch\n");
    expect(json((await anna.get(`/api/v1/runs/${s.run.id}/export`)).body).runs[0].sections[0].items[0].children[0]).toMatchObject({ isChecked: true });
  });

  it("macht Dateinamen sicher (Umlaute, Sonderzeichen, Pfadtricks)", async () => {
    const t = (await anna.post("/api/v1/templates", { title: '../../Über "größe" <script>.exe' })).json().template.id;
    const res = await anna.get(`/api/v1/templates/${t}/export?format=md`);
    const disposition = res.headers["content-disposition"] as string;
    expect(disposition).toMatch(/filename="ueber-groesse-script-exe-\d{4}-\d{2}-\d{2}\.md"/);
    expect(disposition).not.toMatch(/[<>/\\]|\.\./);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("schützt CSV-Zellen vor Formel-Injektion", async () => {
    const t = (await anna.post("/api/v1/templates", { title: "=Vorlage" })).json().template.id;
    await anna.post(`/api/v1/templates/${t}/items`, { title: "=HYPERLINK(\"http://evil.example\")", description: "@cmd" });
    const csv = (await anna.get(`/api/v1/templates/${t}/export?format=csv`)).body;
    expect(csv).toContain("'=Vorlage");
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil.example\"\")\"");
    expect(csv).toContain("'@cmd");
  });

  it("liefert 404 für fremde, gelöschte und unbekannte Vorlagen/Durchführungen; 400 bei ungültigem Format", async () => {
    const s = await seed(anna);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const gone = (await anna.post("/api/v1/templates", { title: "weg" })).json().template.id;
    await anna.del(`/api/v1/templates/${gone}`);
    const results = await Promise.all([
      bob.get(`/api/v1/templates/${s.tag}/export`), bob.get(`/api/v1/runs/${s.run.id}/export`),
      anna.get(`/api/v1/templates/${gone}/export`), anna.get(`/api/v1/runs/${crypto.randomUUID()}/export`),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([404, 404, 404, 404]);
    expect((await anna.get(`/api/v1/templates/${s.tag}/export?format=xls`)).statusCode).toBe(400);
    expect(json((await bob.get("/api/v1/export")).body).templates).toEqual([]);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/export" })).statusCode).toBe(401);
  });
});

describe("Konto-Export (F-52)", () => {
  it("enthält Profil, Papierkorb, Freigaben und Token-Metadaten – aber keine Geheimnisse", async () => {
    const s = await seed(anna);
    const tpl = (await anna.post("/api/v1/templates", { title: "Gelöscht" })).json().template.id;
    await anna.del(`/api/v1/templates/${tpl}`);
    await anna.post(`/api/v1/runs/${s.run.id}/complete`);
    await anna.put(`/api/v1/runs/${s.archived.id}/share`, { access: "anyone", permission: "view" }).catch(() => undefined);
    const apiToken = (await anna.post("/api/v1/me/tokens", { name: "Skript", permission: "read" })).json().token as string;
    const live = (await anna.post("/api/v1/runs", { title: "Geteilt" })).json().run.id;
    const share = (await anna.put(`/api/v1/runs/${live}/share`, { access: "password", permission: "edit", password: "geheimes-passwort" })).json().share;

    const res = await anna.get("/api/v1/me/export");
    expect(res.statusCode).toBe(200);
    const doc = json(res.body);
    expect(doc.account).toMatchObject({ email: "anna@example.org", displayName: "Anna", language: "de", twoFactorEnabled: false });
    expect(doc.templates.find((t: { title: string }) => t.title === "Gelöscht").deletedAt).toBeTruthy();
    expect(doc.runs.find((r: { title: string }) => r.title === "Ausflug Füssen").deletedAt).toBeTruthy();
    expect(doc.shares).toEqual([expect.objectContaining({ run: "Geteilt", access: "password", permission: "edit", passwordProtected: true, revokedAt: null })]);
    expect(doc.apiTokens).toEqual([expect.objectContaining({ name: "Skript", permission: "read", prefix: apiToken.slice(0, 8) })]);
    for (const secret of [apiToken, "geheimes-passwort", share.url.split("/s/")[1], "argon2", "password_hash", "passwordHash", "tokenHash", "totp_secret"]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("ist nur mit Browser-Sitzung möglich", async () => {
    const token = (await anna.post("/api/v1/me/tokens", { name: "t", permission: "write" })).json().token as string;
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/me/export", headers: { authorization: `Bearer ${token}` } });
    expect([res.statusCode, res.json().error]).toEqual([403, "session_required"]);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me/export" })).statusCode).toBe(401);
  });
});

describe("Import JSON (F-51)", () => {
  it("Round-Trip: Export eines Kontos, Import in ein anderes ergibt dieselbe Struktur samt Tags, Farben und Abhak-Status", async () => {
    await seed(anna);
    const original = json((await anna.get("/api/v1/export")).body);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");

    const res = await importJson(bob, original);
    expect(res.statusCode).toBe(201);
    expect(res.json().result).toEqual({ templates: 2, runs: 2, items: 14, tagsCreated: 2, tagsReused: 0 });
    const copy = json((await bob.get("/api/v1/export")).body);
    expect(normalize(copy)).toEqual(normalize(original));
    // Zeitpunkte des Abhakens bleiben erhalten
    expect(copy.runs[0].sections[0].items[0].children[0].checkedAt).toBe(original.runs[0].sections[0].items[0].children[0].checkedAt);
    // Alles gehört Bob; Anna ist unverändert
    expect(json((await anna.get("/api/v1/export")).body).templates).toHaveLength(2);
    // die importierte Durchführung ist voll funktionsfähig
    const list = (await bob.get("/api/v1/runs")).json();
    expect(list.runs[0].progress).toEqual({ done: 2, total: 6 });
    expect((await bob.get("/api/v1/runs?status=archived")).json().total).toBe(1);
  });

  it("legt beim erneuten Import ins selbe Konto neue Datensätze an (keine Überschreibung), verwendet Tags aber wieder", async () => {
    await seed(anna);
    const doc = json((await anna.get("/api/v1/export")).body);
    const res = await importJson(anna, doc);
    expect(res.json().result).toMatchObject({ templates: 2, runs: 2, tagsCreated: 0, tagsReused: 2 });
    expect((await anna.get("/api/v1/templates")).json().total).toBe(4);
    expect((await anna.get("/api/v1/runs")).json().total).toBe(2);
    expect((await anna.get("/api/v1/tags")).json().tags.map((t: { name: string; color: string }) => [t.name, t.color])).toEqual([["Outdoor", "#16a34a"], ["Reisen", "#2563eb"]]);
  });

  it("verwendet vorhandene Tags ohne Beachtung der Schreibweise und legt unbekannte mit automatischer Farbe an", async () => {
    await anna.post("/api/v1/tags", { name: "reisen", color: "#dc2626" });
    const res = await importJson(anna, { templates: [{ title: "V", tags: ["REISEN", "Neu", "Mit Farbe"] }], tags: [{ name: "Mit Farbe", color: "#9333EA" }] });
    expect(res.json().result).toMatchObject({ tagsCreated: 2, tagsReused: 1 });
    const tags = (await anna.get("/api/v1/tags")).json().tags as { name: string; color: string; templateCount: number }[];
    expect(tags.map((t) => t.name).sort()).toEqual(["Mit Farbe", "Neu", "reisen"]);
    expect(tags.find((t) => t.name === "reisen")).toMatchObject({ color: "#dc2626", templateCount: 1 });
    expect(tags.find((t) => t.name === "Mit Farbe")!.color).toBe("#9333ea");
    const auto = tags.find((t) => t.name === "Neu")!.color;
    expect(auto).toMatch(/^#[0-9a-f]{6}$/);
    expect(["#dc2626", "#9333ea"]).not.toContain(auto);
  });

  it("nimmt auch minimale Dokumente an (nur Titel) und Objekte statt Text", async () => {
    expect((await importJson(anna, { templates: [{ title: "Nur Titel" }] })).statusCode).toBe(201);
    expect((await importJson(anna, JSON.stringify({ templates: [{ title: "Als Text", items: [{ title: "a" }] }] }))).statusCode).toBe(201);
    expect((await anna.get("/api/v1/templates")).json().total).toBe(2);
  });

  it("Vorschau (dryRun) prüft und zeigt Inhalt, legt aber nichts an", async () => {
    await seed(anna);
    const doc = json((await anna.get("/api/v1/export")).body);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    await bob.post("/api/v1/tags", { name: "Reisen" });
    const res = await importJson(bob, doc, { dryRun: true });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ valid: true, issues: [], counts: { templates: 2, runs: 2, items: 14 } });
    expect(body.preview.templates[0]).toMatchObject({ title: "Tagesausflug", itemCount: 4, tags: ["Outdoor", "Reisen"], sample: ["Rucksack", "Route prüfen"] });
    expect(body.preview.runs[0]).toMatchObject({ title: "Ausflug Füssen", status: "active", sections: ["Tagesausflug", "Therme"], progress: { done: 2, total: 6 } });
    expect(body.preview.tags).toEqual({ new: ["Outdoor"], existing: ["Reisen"] });
    expect(ctx.db.select().from(schema.templates).all().filter((t) => t.ownerId !== undefined)).toHaveLength(2); // nur Annas
    expect((await bob.get("/api/v1/templates")).json().total).toBe(0);
    expect((await bob.get("/api/v1/tags")).json().tags).toHaveLength(1);
  });

  it("meldet Fehler mit Pfad; die Vorschau antwortet 200 mit valid:false, der echte Import 422 – und legt nichts an", async () => {
    const bad = { templates: [{ title: "Gut", items: [{ title: "ok" }, { title: "ok2", children: [{ title: "" }] }] }, { title: "x".repeat(201) }], tags: [{ name: "T", color: "rot" }] };
    const preview = await importJson(anna, bad, { dryRun: true });
    expect(preview.statusCode).toBe(200);
    const issues = preview.json().issues as Issue[];
    expect(preview.json().valid).toBe(false);
    expect(issues.map((i) => i.path).sort()).toEqual(["tags[0].color", "templates[0].items[1].children[0].title", "templates[1].title"]);
    expect(issues.find((i) => i.path === "tags[0].color")!.message).toContain("#RRGGBB");
    expect(preview.json().preview).toBeUndefined();

    const real = await importJson(anna, bad);
    expect([real.statusCode, real.json().error]).toEqual([422, "import_invalid"]);
    expect(real.json().issues).toHaveLength(3);
    expect((await anna.get("/api/v1/templates")).json().total).toBe(0); // alles oder nichts
    expect((await anna.get("/api/v1/tags")).json().tags).toEqual([]);
  });

  it("lehnt ungültiges JSON, falsche Version/Format, falsche Typen und leere Dokumente verständlich ab", async () => {
    const check = async (content: unknown, needle: RegExp) => {
      const res = await importJson(anna, content, { dryRun: true });
      expect(res.json().valid, JSON.stringify(content)).toBe(false);
      expect(JSON.stringify(res.json().issues)).toMatch(needle);
    };
    await check("{kaputt", /Kein gültiges JSON/);
    await check({ version: 2, templates: [{ title: "a" }] }, /Version 1/);
    await check({ format: "etwas-anderes", templates: [{ title: "a" }] }, /format muss/);
    await check({}, /Keine Vorlagen oder Durchführungen/);
    await check({ templates: "nein" }, /templates/);
    await check({ runs: [{ title: "R", status: "fertig" }] }, /status muss/);
    await check({ templates: [{ title: "a", items: [{ title: 5 }] }] }, /items\[0\]\.title/);
    await check({ runs: [{ title: "R", sections: [{ title: "S", items: [{ title: "x", checkedAt: "gestern", isChecked: true }] }] }] }, /checkedAt/);
  });

  it("begrenzt Verschachtelungstiefe und Anzahl", async () => {
    let node: Record<string, unknown> = { title: "tief" };
    for (let i = 0; i < 55; i++) node = { title: `E${i}`, children: [node] };
    const deep = await importJson(anna, { templates: [{ title: "T", items: [node] }] }, { dryRun: true });
    expect(JSON.stringify(deep.json().issues)).toMatch(/tiefer als 50/);

    const many = { templates: Array.from({ length: LIMITS.templates + 1 }, (_, i) => ({ title: `V${i}` })) };
    const res = await importJson(anna, many, { dryRun: true });
    expect(JSON.stringify(res.json().issues)).toContain(`Höchstens ${LIMITS.templates} Vorlagen`);
  });

  it("setzt Abhak-Zeit sinnvoll: nicht abgehakte Punkte ohne Zeit, abgehakte ohne Angabe mit „jetzt“", async () => {
    const before = Date.now();
    await importJson(anna, { runs: [{ title: "R", sections: [{ title: "S", items: [{ title: "a", isChecked: true }, { title: "b", checkedAt: "2020-01-01T00:00:00Z" }, { title: "c", isChecked: true, checkedAt: "2020-01-01T00:00:00Z" }] }] }] });
    const items = ctx.db.select().from(schema.runItems).all().sort((x, y) => x.position - y.position);
    expect(items.map((i) => i.isChecked)).toEqual([true, false, true]);
    expect(items[0]!.checkedAt).toBeGreaterThanOrEqual(before);
    expect(items[1]!.checkedAt).toBeNull();
    expect(items[2]!.checkedAt).toBe(Date.parse("2020-01-01T00:00:00Z"));
  });
});

describe("Import CSV (F-51, Migration aus Mendix)", () => {
  const tree = async (client: Client, title: string) => {
    const list = (await client.get(`/api/v1/templates?search=${encodeURIComponent(title)}`)).json().templates[0];
    const t = (await client.get(`/api/v1/templates/${list.id}`)).json().template;
    const names = (items: { title: string; children: unknown[] }[]): unknown[] => items.map((i) => (i.children.length ? [i.title, names(i.children as never)] : i.title));
    return names(t.items);
  };

  it("liest Komma, Semikolon und Tab, gruppiert nach Vorlage und bildet Unterpunkte aus der Ebene", async () => {
    const rows = [["Vorlage", "Ebene", "Titel", "Beschreibung"], ["Packliste", "1", "Rucksack", "30 l"], ["Packliste", "2", "Sonnencreme", ""], ["Packliste", "2", "Regenjacke", ""], ["Packliste", "1", "Karte", ""], ["Therme", "1", "Handtuch", ""], ["Packliste", "3", "tief", ""]];
    // Zeile 7 ist absichtlich ungültig (Ebene 3 unter Ebene 1) → zuerst ohne sie
    const valid = rows.slice(0, 6);
    for (const d of [",", ";", "\t"]) {
      const ctx2 = setupApp();
      const u = await newUser(ctx2.app, "u@example.org", "U");
      const csv = valid.map((r) => r.join(d)).join("\r\n");
      const res = await u.post("/api/v1/import", { format: "csv", content: csv });
      expect(res.statusCode, d).toBe(201);
      expect(res.json().result).toMatchObject({ templates: 2, items: 5 });
      const list = (await u.get("/api/v1/templates?sort=title")).json().templates.map((t: { title: string }) => t.title);
      expect(list).toEqual(["Packliste", "Therme"]);
    }
    await importCsv(anna, valid.map((r) => r.join(";")).join("\n"));
    expect(await tree(anna, "Packliste")).toEqual([["Rucksack", ["Sonnencreme", "Regenjacke"]], "Karte"]);
    const first = (await anna.get("/api/v1/templates?search=Packliste")).json().templates[0].id;
    expect((await anna.get(`/api/v1/templates/${first}`)).json().template.items[0].description).toBe("30 l");
  });

  it("erkennt Mendix-typische Spaltennamen (Checklist, Task, Description) und ignoriert Zusatzspalten mit Hinweis", async () => {
    const csv = "Checklist;Task;Description;Checked;Erstellt\nPutzplan;Küche;Herd und Ofen;Nein;2025-01-01\nPutzplan;Bad;;Ja;2025-01-02";
    const dry = await importCsv(anna, csv, { dryRun: true });
    expect(dry.json()).toMatchObject({ valid: true, counts: { templates: 1, items: 2 } });
    expect(dry.json().warnings).toEqual(["Ignorierte Spalten: Checked, Erstellt"]);
    expect(dry.json().preview.templates[0]).toMatchObject({ title: "Putzplan", sample: ["Küche", "Bad"] });
    await importCsv(anna, csv);
    expect(await tree(anna, "Putzplan")).toEqual(["Küche", "Bad"]);
  });

  it("verwendet `title`, wenn die Datei keine Spalte „Vorlage“ hat (z. B. Aufgabenliste einer einzelnen Checkliste)", async () => {
    const csv = "Name,Beschreibung\nEins,\nZwei,mit Text";
    const noTitle = await importCsv(anna, csv, { dryRun: true });
    expect(noTitle.json().valid).toBe(false);
    expect(noTitle.json().issues[0].message).toMatch(/Vorlage/);
    expect((await importCsv(anna, csv, { title: "Meine Liste" })).statusCode).toBe(201);
    expect(await tree(anna, "Meine Liste")).toEqual(["Eins", "Zwei"]);
  });

  it("verarbeitet BOM, Anführungszeichen, Umbrüche und Umlaute; stellt Formel-Schutz wieder her", async () => {
    const csv = "﻿Vorlage;Titel;Beschreibung\r\n\"Übernachtung\";\"Zahnbürste, Zahnpasta\";\"Zeile 1\nZeile 2\"\r\nÜbernachtung;'=Sonderfall;\"sagt \"\"hi\"\"\"\r\n";
    expect((await importCsv(anna, csv)).statusCode).toBe(201);
    const id = (await anna.get("/api/v1/templates")).json().templates[0].id;
    const items = (await anna.get(`/api/v1/templates/${id}`)).json().template.items;
    expect(items.map((i: { title: string; description: string }) => [i.title, i.description])).toEqual([["Zahnbürste, Zahnpasta", "Zeile 1\nZeile 2"], ["=Sonderfall", 'sagt "hi"']]);
  });

  it("meldet Fehler je Zeile mit Zeilennummer und legt bei Fehlern nichts an", async () => {
    const csv = ["Vorlage,Ebene,Titel,Beschreibung", "A,1,ok,", "A,1,,fehlt", "A,x,kaputt,", "A,0,null,", ",1,ohne Vorlage,", "A,3,sprung,", `A,1,${"y".repeat(201)},`];
    const res = await importCsv(anna, csv.join("\n"), { dryRun: true });
    const issues = res.json().issues as Issue[];
    expect(res.json().valid).toBe(false);
    const byLine = (n: number) => issues.filter((i) => i.path === `Zeile ${n}`).map((i) => i.message);
    expect(byLine(3)).toEqual(["Titel fehlt"]);
    expect(byLine(4)[0]).toContain("„x“ ist keine ganze Zahl");
    expect(byLine(5)[0]).toContain("„0“");
    expect(byLine(6)).toEqual(["Vorlage fehlt"]);
    expect(byLine(7)[0]).toMatch(/Ebene springt von 1 auf 3/);
    expect(byLine(8)).toEqual(["Titel länger als 200 Zeichen"]);
    expect(issues.some((i) => i.path === "Zeile 2")).toBe(false); // gültige Zeile ohne Meldung

    const real = await importCsv(anna, csv.join("\n"));
    expect([real.statusCode, real.json().error]).toEqual([422, "import_invalid"]);
    expect((await anna.get("/api/v1/templates")).json().total).toBe(0);
  });

  it("meldet fehlende Titelspalte, leere Dateien, nicht geschlossene Anführungszeichen und Nicht-Text", async () => {
    const msg = async (content: string) => (await importCsv(anna, content, { dryRun: true })).json().issues[0].message as string;
    expect(await msg("Vorlage,Ebene\nA,1")).toMatch(/Spalte „Titel“ fehlt/);
    expect(await msg("")).toMatch(/leer/);
    expect(await msg("Vorlage,Titel\n")).toMatch(/Keine Datenzeilen/);
    expect(await msg('Vorlage,Titel\nA,"offen')).toMatch(/nicht geschlossen/);
    const notText = await anna.post("/api/v1/import", { format: "csv", content: { a: 1 } });
    expect(notText.statusCode).toBe(400);
  });

  it("Round-Trip: CSV-Export (Semikolon) einer verschachtelten Vorlage lässt sich wieder importieren", async () => {
    const s = await seed(anna);
    const csv = (await anna.get(`/api/v1/templates/${s.tag}/export?format=csv&delimiter=semicolon`)).body;
    expect((await importCsv(anna, csv)).statusCode).toBe(201);
    const templates = (await anna.get("/api/v1/templates?search=Tagesausflug&sort=updated")).json().templates as { id: string; description: string | null; tags: unknown[] }[];
    expect(templates).toHaveLength(2);
    const copy = (await anna.get(`/api/v1/templates/${templates[0]!.id}`)).json().template;
    const orig = (await anna.get(`/api/v1/templates/${s.tag}`)).json().template;
    const shape = (items: { title: string; description: string | null; children: unknown[] }[]): unknown[] => items.map((i) => [i.title, i.description, shape(i.children as never)]);
    expect(shape(copy.items)).toEqual(shape(orig.items));
  });
});

describe("Rechte und Grenzen beim Import", () => {
  it("verlangt Anmeldung; Lese-Token dürfen nicht importieren, Schreib-Token schon", async () => {
    const body = { format: "json", content: { templates: [{ title: "T" }] } };
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/import", payload: body })).statusCode).toBe(401);
    const mk = async (permission: string) => (await anna.post("/api/v1/me/tokens", { name: permission, permission })).json().token as string;
    const [ro, rw] = [await mk("read"), await mk("write")];
    const send = (token: string) => ctx.app.inject({ method: "POST", url: "/api/v1/import", payload: body, headers: { authorization: `Bearer ${token}` } });
    expect((await send(ro)).json().error).toBe("token_read_only");
    expect((await send(rw)).statusCode).toBe(201);
    expect((await anna.get("/api/v1/templates")).json().total).toBe(1);
  });

  it("lehnt zu große Anfragen ab (413) und validiert die Eingabe (400)", async () => {
    const huge = "x".repeat(13 * 1024 * 1024);
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/import", payload: { format: "csv", content: huge }, cookies: { session: anna.session } });
    expect(res.statusCode).toBe(413);
    expect((await anna.post("/api/v1/import", { format: "xml", content: "x" })).statusCode).toBe(400);
    expect((await anna.post("/api/v1/import", { format: "json" })).statusCode).toBe(400);
  });

  it("MCP und Import/Export sind getrennt: der MCP-Server bietet weder Import noch Export an", async () => {
    const { mcpToolNames } = await import("../src/mcp.js");
    expect(mcpToolNames(true).join(" ")).not.toMatch(/import|export/);
  });
});
