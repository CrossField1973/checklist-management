import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { purgeExpiredTrash, purgeStaleResetTokens } from "../src/jobs.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
const DAY = 24 * 60 * 60 * 1000;

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

async function makeTemplate(client: Client, title = "Vorlage", items: string[] = ["a", "b"]) {
  const id = (await client.post("/api/v1/templates", { title })).json().template.id as string;
  for (const t of items) await client.post(`/api/v1/templates/${id}/items`, { title: t });
  return id;
}
async function makeRun(client: Client, title = "Lauf", templateIds: string[] = []) {
  return (await client.post("/api/v1/runs", { title, templateIds })).json().run as { id: string };
}
const runRow = (id: string) => ctx.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get()!;
const trash = async (client: Client = anna) => (await client.get("/api/v1/trash")).json() as {
  retentionDays: number | null;
  items: { type: string; id: string; title: string; deletedAt: number; purgeAt: number | null; statusBeforeDelete?: string }[];
};

describe("Archivieren und Wieder öffnen (F-28, F-30)", () => {
  it("archiviert eine aktive Durchführung und führt sie nur noch im Archiv", async () => {
    const run = await makeRun(anna, "Skiwochenende", [await makeTemplate(anna)]);
    const res = await anna.post(`/api/v1/runs/${run.id}/archive`);
    expect(res.statusCode).toBe(200);
    expect(res.json().run).toMatchObject({ status: "archived" });
    expect(res.json().run.archivedAt).toBeGreaterThan(0);

    const ids = async (status: string) => (await anna.get(`/api/v1/runs?status=${status}`)).json().runs.map((r: { id: string }) => r.id);
    expect(await ids("active")).toEqual([]);
    expect(await ids("archived")).toEqual([run.id]);
  });

  it("lässt eine archivierte Durchführung lesen, aber nicht ändern", async () => {
    const run = await makeRun(anna, "R", [await makeTemplate(anna)]);
    await anna.post(`/api/v1/runs/${run.id}/archive`);
    expect((await anna.get(`/api/v1/runs/${run.id}`)).statusCode).toBe(200);
    expect((await anna.put(`/api/v1/runs/${run.id}`, { title: "X" })).statusCode).toBe(409);
  });

  it("lehnt doppeltes Archivieren ab (409) und Wieder öffnen einer aktiven Durchführung", async () => {
    const run = await makeRun(anna);
    expect((await anna.post(`/api/v1/runs/${run.id}/reopen`)).json().error).toBe("run_not_archived");
    await anna.post(`/api/v1/runs/${run.id}/archive`);
    const again = await anna.post(`/api/v1/runs/${run.id}/archive`);
    expect([again.statusCode, again.json().error]).toEqual([409, "run_not_active"]);
  });

  it("öffnet wieder: Status aktiv, Archivzeit gelöscht, Änderungen wieder möglich", async () => {
    const run = await makeRun(anna, "R", [await makeTemplate(anna)]);
    await anna.post(`/api/v1/runs/${run.id}/archive`);
    const res = await anna.post(`/api/v1/runs/${run.id}/reopen`);
    expect(res.json().run).toMatchObject({ status: "active", archivedAt: null });
    expect((await anna.put(`/api/v1/runs/${run.id}`, { title: "Wieder da" })).statusCode).toBe(200);
  });

  it("widerruft beim Archivieren Freigabelinks (F-44), andere Durchführungen bleiben unberührt", async () => {
    const a = await makeRun(anna, "A");
    const b = await makeRun(anna, "B");
    const share = (runId: string, hash: string) =>
      ctx.db.insert(schema.runShares).values({ runId, tokenHash: hash, access: "anyone", permission: "view" }).run();
    share(a.id, "ha");
    share(b.id, "hb");
    await anna.post(`/api/v1/runs/${a.id}/archive`);
    const shares = ctx.db.select().from(schema.runShares).all();
    expect(shares.find((s) => s.tokenHash === "ha")!.revokedAt).toBeGreaterThan(0);
    expect(shares.find((s) => s.tokenHash === "hb")!.revokedAt).toBeNull();
  });
});

describe("Abschließen = in den Papierkorb (F-28)", () => {
  it("verschiebt eine aktive Durchführung in den Papierkorb, nicht ins Archiv", async () => {
    const run = await makeRun(anna, "Erledigt", [await makeTemplate(anna)]);
    expect((await anna.post(`/api/v1/runs/${run.id}/complete`)).statusCode).toBe(204);
    expect((await anna.get(`/api/v1/runs/${run.id}`)).statusCode).toBe(404);
    expect((await anna.get("/api/v1/runs?status=archived")).json().total).toBe(0);
    const t = await trash();
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ type: "run", id: run.id, title: "Erledigt", statusBeforeDelete: "active" });
  });

  it("funktioniert auch aus dem Archiv und merkt sich den Status", async () => {
    const run = await makeRun(anna);
    await anna.post(`/api/v1/runs/${run.id}/archive`);
    await anna.del(`/api/v1/runs/${run.id}`);
    expect((await trash()).items[0]!.statusBeforeDelete).toBe("archived");
  });
});

describe("Papierkorb (F-31)", () => {
  it("listet Vorlagen und Durchführungen, neueste zuerst, mit Löschdatum", async () => {
    const tpl = await makeTemplate(anna, "Alte Vorlage");
    const run = await makeRun(anna, "Alter Lauf", [tpl]);
    await anna.del(`/api/v1/templates/${tpl}`);
    await new Promise((r) => setTimeout(r, 5));
    await anna.del(`/api/v1/runs/${run.id}`);
    const t = await trash();
    expect(t.items.map((i) => [i.type, i.title])).toEqual([["run", "Alter Lauf"], ["template", "Alte Vorlage"]]);
    expect(t.items[0]!.deletedAt).toBeGreaterThanOrEqual(t.items[1]!.deletedAt);
  });

  it("nennt den Zeitpunkt der endgültigen Löschung gemäß Aufbewahrungsdauer (oder null bei „nie“)", async () => {
    const run = await makeRun(anna);
    await anna.del(`/api/v1/runs/${run.id}`);
    let t = await trash();
    expect(t.retentionDays).toBe(30);
    expect(t.items[0]!.purgeAt).toBe(t.items[0]!.deletedAt + 30 * DAY);
    await anna.put("/api/v1/me", { trashRetentionDays: null });
    t = await trash();
    expect([t.retentionDays, t.items[0]!.purgeAt]).toEqual([null, null]);
  });

  it("stellt eine Vorlage wieder her: wieder in der Liste, Punkte intakt", async () => {
    const tpl = await makeTemplate(anna, "V", ["a", "b"]);
    await anna.del(`/api/v1/templates/${tpl}`);
    expect((await anna.post(`/api/v1/trash/template/${tpl}/restore`)).statusCode).toBe(204);
    const res = (await anna.get(`/api/v1/templates/${tpl}`)).json().template;
    expect(res.items.map((i: { title: string }) => i.title)).toEqual(["a", "b"]);
    expect((await trash()).items).toEqual([]);
  });

  it("stellt Durchführungen in ihren früheren Status wieder her (aktiv bzw. archiviert) samt Fortschritt", async () => {
    const tpl = await makeTemplate(anna);
    const active = await makeRun(anna, "Aktiv", [tpl]);
    const archived = await makeRun(anna, "Archiv", [tpl]);
    await anna.post(`/api/v1/runs/${archived.id}/archive`);
    await anna.post(`/api/v1/runs/${active.id}/complete`);
    await anna.del(`/api/v1/runs/${archived.id}`);

    await anna.post(`/api/v1/trash/run/${active.id}/restore`);
    await anna.post(`/api/v1/trash/run/${archived.id}/restore`);
    expect(runRow(active.id)).toMatchObject({ status: "active", deletedAt: null, statusBeforeDelete: null });
    expect(runRow(archived.id)).toMatchObject({ status: "archived", deletedAt: null });
    expect((await anna.get(`/api/v1/runs/${active.id}`)).json().run.progress.total).toBe(2);
  });

  it("liefert 404 für nicht gelöschte, unbekannte oder falsch typisierte Einträge", async () => {
    const tpl = await makeTemplate(anna);
    const run = await makeRun(anna);
    const wrongType = await anna.post(`/api/v1/trash/run/${tpl}/restore`);
    expect(wrongType.statusCode).toBe(404);
    expect((await anna.post(`/api/v1/trash/run/${run.id}/restore`)).statusCode).toBe(404); // nicht im Papierkorb
    expect((await anna.del(`/api/v1/trash/run/${run.id}`)).statusCode).toBe(404); // aktive Daten bleiben geschützt
    expect((await anna.post(`/api/v1/trash/other/${run.id}/restore`)).statusCode).toBe(400);
    expect((await anna.get(`/api/v1/runs/${run.id}`)).statusCode).toBe(200);
  });

  it("löscht einzelne Einträge endgültig samt Abschnitten, Punkten und Freigaben", async () => {
    const run = await makeRun(anna, "R", [await makeTemplate(anna)]);
    ctx.db.insert(schema.runShares).values({ runId: run.id, tokenHash: "h", access: "anyone", permission: "view" }).run();
    await anna.del(`/api/v1/runs/${run.id}`);
    expect((await anna.del(`/api/v1/trash/run/${run.id}`)).statusCode).toBe(204);
    expect(ctx.db.select().from(schema.runs).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.runSections).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.runItems).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.runShares).all()).toHaveLength(0);
  });

  it("entfernt beim endgültigen Löschen einer Vorlage nur deren Punkte; Durchführungen behalten ihre Kopie", async () => {
    const tpl = await makeTemplate(anna, "V", ["a", "b"]);
    const run = await makeRun(anna, "R", [tpl]);
    await anna.del(`/api/v1/templates/${tpl}`);
    await anna.del(`/api/v1/trash/template/${tpl}`);
    expect(ctx.db.select().from(schema.templateItems).all()).toHaveLength(0);
    const detail = (await anna.get(`/api/v1/runs/${run.id}`)).json().run;
    expect(detail.sections[0]).toMatchObject({ title: "V", sourceTemplateId: null });
    expect(detail.progress.total).toBe(2);
  });

  it("leert den Papierkorb nur für den eigenen Nutzer und lässt aktive/archivierte Daten stehen", async () => {
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const keep = await makeRun(anna, "Bleibt");
    const archived = await makeRun(anna, "Archiv");
    await anna.post(`/api/v1/runs/${archived.id}/archive`);
    const tpl = await makeTemplate(anna);
    await anna.del(`/api/v1/templates/${tpl}`);
    await anna.del(`/api/v1/runs/${(await makeRun(anna, "Weg")).id}`);
    const bobRun = await makeRun(bob, "Bobs");
    await bob.del(`/api/v1/runs/${bobRun.id}`);

    const res = await anna.del("/api/v1/trash");
    expect(res.json()).toEqual({ templates: 1, runs: 1 });
    expect((await trash()).items).toEqual([]);
    expect((await trash(bob)).items).toHaveLength(1);
    expect((await anna.get(`/api/v1/runs/${keep.id}`)).statusCode).toBe(200);
    expect((await anna.get(`/api/v1/runs/${archived.id}`)).statusCode).toBe(200);
  });

  it("trennt Nutzer: fremder Papierkorb ist unsichtbar und nicht bedienbar; Anmeldung nötig", async () => {
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const run = await makeRun(anna);
    const tpl = await makeTemplate(anna);
    await anna.del(`/api/v1/runs/${run.id}`);
    await anna.del(`/api/v1/templates/${tpl}`);
    expect((await trash(bob)).items).toEqual([]);
    const results = await Promise.all([
      bob.post(`/api/v1/trash/run/${run.id}/restore`),
      bob.post(`/api/v1/trash/template/${tpl}/restore`),
      bob.del(`/api/v1/trash/run/${run.id}`),
      bob.del(`/api/v1/trash/template/${tpl}`),
      bob.post(`/api/v1/runs/${run.id}/archive`),
      bob.post(`/api/v1/runs/${run.id}/complete`),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(404));
    expect((await trash()).items).toHaveLength(2);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/trash" })).statusCode).toBe(401);
  });
});

describe("Automatisches Leeren des Papierkorbs (F-32)", () => {
  const setDeleted = (table: "runs" | "templates", id: string, daysAgo: number) =>
    ctx.db.update(schema[table]).set({ deletedAt: Date.now() - daysAgo * DAY }).where(eq(schema[table].id, id)).run();

  it("löscht nur Einträge, die älter als die Aufbewahrungsdauer sind", async () => {
    const [oldRun, freshRun] = [await makeRun(anna, "Alt"), await makeRun(anna, "Frisch")];
    const [oldTpl, freshTpl] = [await makeTemplate(anna, "AltV"), await makeTemplate(anna, "FrischV")];
    for (const id of [oldRun.id, freshRun.id]) await anna.del(`/api/v1/runs/${id}`);
    for (const id of [oldTpl, freshTpl]) await anna.del(`/api/v1/templates/${id}`);
    setDeleted("runs", oldRun.id, 31);
    setDeleted("runs", freshRun.id, 29);
    setDeleted("templates", oldTpl, 31);
    setDeleted("templates", freshTpl, 29);

    expect(purgeExpiredTrash(ctx.db)).toEqual({ templates: 1, runs: 1 });
    expect((await trash()).items.map((i) => i.title).sort()).toEqual(["Frisch", "FrischV"]);
  });

  it("beachtet die Frist je Nutzer und löscht bei „nie“ nichts", async () => {
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const [a, b] = [await makeRun(anna, "A"), await makeRun(bob, "B")];
    await anna.del(`/api/v1/runs/${a.id}`);
    await bob.del(`/api/v1/runs/${b.id}`);
    setDeleted("runs", a.id, 10);
    setDeleted("runs", b.id, 10);
    await anna.put("/api/v1/me", { trashRetentionDays: 7 });
    await bob.put("/api/v1/me", { trashRetentionDays: null });

    expect(purgeExpiredTrash(ctx.db).runs).toBe(1);
    expect((await trash(anna)).items).toEqual([]);
    expect((await trash(bob)).items).toHaveLength(1);
  });

  it("löscht nie aktive oder archivierte Durchführungen und nie das Archiv", async () => {
    const active = await makeRun(anna, "Aktiv");
    const archived = await makeRun(anna, "Archiv");
    await anna.post(`/api/v1/runs/${archived.id}/archive`);
    ctx.db.update(schema.runs).set({ updatedAt: Date.now() - 1000 * DAY, createdAt: Date.now() - 1000 * DAY, archivedAt: Date.now() - 1000 * DAY }).run();
    expect(purgeExpiredTrash(ctx.db, Date.now() + 1000 * DAY)).toEqual({ templates: 0, runs: 0 });
    expect(ctx.db.select().from(schema.runs).all().map((r) => r.id).sort()).toEqual([active.id, archived.id].sort());
  });

  it("bereinigt abgelaufene und verbrauchte Reset-Token, behält gültige", () => {
    const user = ctx.db.select().from(schema.users).get()!;
    const add = (hash: string, expiresAt: number, usedAt: number | null) =>
      ctx.db.insert(schema.passwordResets).values({ userId: user.id, tokenHash: hash, expiresAt, usedAt }).run();
    add("expired", Date.now() - 1000, null);
    add("used", Date.now() + 100000, Date.now());
    add("valid", Date.now() + 100000, null);
    expect(purgeStaleResetTokens(ctx.db)).toBe(2);
    expect(ctx.db.select().from(schema.passwordResets).all().map((r) => r.tokenHash)).toEqual(["valid"]);
  });
});
