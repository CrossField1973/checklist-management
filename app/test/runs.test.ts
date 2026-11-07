import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
interface Progress { done: number; total: number }
interface Item { id: string; title: string; isChecked: boolean; checkedAt: number | null; childProgress: Progress; children: Item[] }
interface Section { id: string; title: string; position: number; sourceTemplateId: string | null; progress: Progress; items: Item[] }
interface Run { id: string; title: string; status: string; progress: Progress; sections: Section[] }

const names = (items: Item[]): unknown[] => items.map((n) => (n.children.length ? [n.title, names(n.children)] : n.title));

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

/** Legt eine Vorlage mit verschachtelten Punkten an: Struktur als [Titel, Kinder?]. */
async function template(client: Client, title: string, structure: (string | [string, unknown[]])[] = []) {
  const t = (await client.post("/api/v1/templates", { title })).json().template as { id: string };
  const add = async (list: (string | [string, unknown[]])[], parent: string | null) => {
    for (const entry of list) {
      const [name, children] = Array.isArray(entry) ? entry : [entry, []];
      const { itemId } = (await client.post(`/api/v1/templates/${t.id}/items`, { title: name, parentItemId: parent })).json();
      await add(children as (string | [string, unknown[]])[], itemId);
    }
  };
  await add(structure, null);
  return t.id;
}
const createRun = async (client: Client, title: string, templateIds: string[] = []) => {
  const res = await client.post("/api/v1/runs", { title, templateIds });
  return { status: res.statusCode, run: res.json().run as Run, body: res.json() };
};
const getRun = async (client: Client, id: string) => (await client.get(`/api/v1/runs/${id}`)).json().run as Run;

describe("Durchführung aus mehreren Vorlagen (F-21)", () => {
  it("kopiert jede Vorlage als Überpunkt in Auswahlreihenfolge samt Unterpunkten (ein interner Abschnitt)", async () => {
    const tag = await template(anna, "Tagesausflug", [["Rucksack", ["Sonnencreme", "Regenjacke"]], "Route prüfen"]);
    const therme = await template(anna, "Therme", ["Badesachen", "Handtuch"]);
    const { status, run } = await createRun(anna, "Ausflug Füssen mit Flo", [therme, tag]);
    expect(status).toBe(201);
    expect(run.sections).toHaveLength(1);
    expect(names(run.sections[0]!.items)).toEqual([["Therme", ["Badesachen", "Handtuch"]], ["Tagesausflug", [["Rucksack", ["Sonnencreme", "Regenjacke"]], "Route prüfen"]]]);
    expect(run.status).toBe("active");
    expect(run.progress).toEqual({ done: 0, total: 2 }); // zählt nur die oberste Ebene
    expect(run.sections[0]!.items[1]!.childProgress).toEqual({ done: 0, total: 2 });
  });

  it("legt auch eine leere Durchführung ohne Vorlage an (mit leerem internen Abschnitt)", async () => {
    const { status, run } = await createRun(anna, "Leer");
    expect(status).toBe(201);
    expect(run.sections).toHaveLength(1);
    expect(run.sections[0]!.items).toEqual([]);
    expect(run.progress).toEqual({ done: 0, total: 0 });
  });

  it("erlaubt dieselbe Vorlage mehrfach", async () => {
    const t = await template(anna, "Wandern", ["Schuhe"]);
    const { run } = await createRun(anna, "Doppelt", [t, t]);
    expect(names(run.sections[0]!.items)).toEqual([["Wandern", ["Schuhe"]], ["Wandern", ["Schuhe"]]]);
    expect(run.progress.total).toBe(2);
  });

  it("lehnt unbekannte, gelöschte und fremde Vorlagen ab (nichts wird angelegt)", async () => {
    const mine = await template(anna, "Mine");
    const deleted = await template(anna, "Weg");
    await anna.del(`/api/v1/templates/${deleted}`);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const theirs = await template(bob, "Bobs");
    for (const bad of [crypto.randomUUID(), deleted, theirs]) {
      const res = await createRun(anna, "X", [mine, bad]);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("unknown_template");
    }
    expect(ctx.db.select().from(schema.runs).all()).toHaveLength(0);
  });

  it("validiert Titel und Eingaben", async () => {
    expect((await anna.post("/api/v1/runs", { title: "  " })).statusCode).toBe(400);
    expect((await anna.post("/api/v1/runs", { title: "X", templateIds: ["kein-uuid"] })).statusCode).toBe(400);
  });

  it("ist eine Momentaufnahme: spätere Vorlagenänderungen und -löschung wirken nicht", async () => {
    const t = await template(anna, "Vorlage", ["A", "B"]);
    const { run } = await createRun(anna, "Lauf", [t]);
    await anna.post(`/api/v1/templates/${t}/items`, { title: "C" });
    await anna.put(`/api/v1/templates/${t}`, { title: "Umbenannt" });
    await anna.del(`/api/v1/templates/${t}`);
    const after = await getRun(anna, run.id);
    expect(names(after.sections[0]!.items)).toEqual([["Vorlage", ["A", "B"]]]);
  });

  it("löst eingefügte Vorlagen (Verweise) auf: die Punkte der anderen Vorlage stehen als Unterpunkte", async () => {
    const hygiene = await template(anna, "Hygiene", ["Zahnpasta", "Zahnbürste"]);
    const nacht = (await anna.post("/api/v1/templates", {
      title: "Übernachten",
      items: [{ title: "Schlafoberteil" }, { refTemplateId: hygiene }],
    })).json().template.id as string;
    const { run } = await createRun(anna, "Reise", [nacht]);
    expect(names(run.sections[0]!.items)).toEqual([["Übernachten", ["Schlafoberteil", ["Hygiene", ["Zahnpasta", "Zahnbürste"]]]]]);
    // gelöschte Vorlage: ihre Punkte fehlen
    await anna.del(`/api/v1/templates/${hygiene}`);
    const again = await createRun(anna, "Reise 2", [nacht]);
    expect(names(again.run.sections[0]!.items)).toEqual([["Übernachten", ["Schlafoberteil"]]]);
  });
});

describe("Vorlagen nachträglich ergänzen (F-22)", () => {
  it("hängt neue Überpunkte an, auch dieselbe Vorlage nochmals", async () => {
    const a = await template(anna, "A", ["a1"]);
    const b = await template(anna, "B", ["b1", "b2"]);
    const { run } = await createRun(anna, "Lauf", [a]);
    const res = await anna.post(`/api/v1/runs/${run.id}/templates`, { templateIds: [b, a] });
    expect(res.statusCode).toBe(201);
    const after = res.json().run as Run;
    expect(names(after.sections[0]!.items)).toEqual([["A", ["a1"]], ["B", ["b1", "b2"]], ["A", ["a1"]]]);
    expect(after.progress.total).toBe(3);
  });

  it("nimmt eigene Punkte direkt in der Durchführung auf (einzeln und als Baum)", async () => {
    const { run } = await createRun(anna, "Lauf");
    const one = await anna.post(`/api/v1/runs/${run.id}/items`, { title: "Kuchen mitbringen" });
    expect(one.statusCode).toBe(201);
    expect(names(one.json().run.sections[0].items)).toEqual(["Kuchen mitbringen"]);
    const bulk = await anna.post(`/api/v1/runs/${run.id}/items`, { items: [{ title: "Übernachten", children: [{ title: "Schlafhose" }, { title: "Schlafoberteil" }] }] });
    expect(bulk.statusCode).toBe(201);
    expect(names(bulk.json().run.sections[0].items)).toEqual(["Kuchen mitbringen", ["Übernachten", ["Schlafhose", "Schlafoberteil"]]]);
  });

  it("lehnt leere Anfragen und fremde/gelöschte Vorlagen ab", async () => {
    const { run } = await createRun(anna, "Lauf");
    expect((await anna.post(`/api/v1/runs/${run.id}/templates`, {})).statusCode).toBe(400);
    expect((await anna.post(`/api/v1/runs/${run.id}/templates`, { templateIds: [] })).statusCode).toBe(400);
    expect((await anna.post(`/api/v1/runs/${run.id}/templates`, { templateIds: [crypto.randomUUID()] })).statusCode).toBe(422);
  });
});

describe("Abhaken und Fortschritt (F-23, F-24)", () => {
  async function setup() {
    const t1 = await template(anna, "Eins", [["Eltern", ["k1", "k2"]], "solo"]);
    const t2 = await template(anna, "Zwei", ["x"]);
    return createRun(anna, "Lauf", [t1, t2]);
  }
  const find = (run: Run, title: string): Item => {
    const walk = (items: Item[]): Item | undefined => items.reduce<Item | undefined>((f, i) => f ?? (i.title === title ? i : walk(i.children)), undefined);
    return run.sections.reduce<Item | undefined>((f, s) => f ?? walk(s.items), undefined)!;
  };
  const check = (id: string, isChecked: boolean) => anna.put(`/api/v1/run-items/${id}`, { isChecked });

  it("speichert Abhaken mit Zeitstempel und macht es rückgängig", async () => {
    const { run } = await setup();
    const before = Date.now();
    const checked = (await check(find(run, "solo").id, true)).json().run as Run;
    const item = find(checked, "solo");
    expect(item.isChecked).toBe(true);
    expect(item.checkedAt).toBeGreaterThanOrEqual(before);
    const undone = find((await check(item.id, false)).json().run as Run, "solo");
    expect(undone).toMatchObject({ isChecked: false, checkedAt: null });
  });

  it("verändert den Zeitstempel nicht, wenn der Zustand gleich bleibt", async () => {
    const { run } = await setup();
    const id = find(run, "solo").id;
    const first = find((await check(id, true)).json().run as Run, "solo").checkedAt;
    await new Promise((r) => setTimeout(r, 5));
    expect(find((await check(id, true)).json().run as Run, "solo").checkedAt).toBe(first);
  });

  it("zählt nur die direkte Ebene: gesamt (oberste Ebene) und je Überpunkt (direkte Unterpunkte)", async () => {
    const { run } = await setup();
    let res = (await check(find(run, "k1").id, true)).json().run as Run;
    expect(find(res, "Eltern").childProgress).toEqual({ done: 1, total: 2 });
    expect(find(res, "Eltern").isChecked).toBe(false);
    expect(res.progress).toEqual({ done: 0, total: 2 });
    res = (await check(find(run, "k2").id, true)).json().run as Run;
    expect(find(res, "Eltern").isChecked).toBe(true); // alle Unterpunkte erledigt → Überpunkt erledigt
    expect(find(res, "Eltern").childProgress).toEqual({ done: 2, total: 2 });
    expect(find(res, "Eins").childProgress).toEqual({ done: 1, total: 2 }); // Eltern erledigt, solo offen
    expect(find(res, "Eins").isChecked).toBe(false);
    res = (await check(find(run, "solo").id, true)).json().run as Run;
    expect(find(res, "Eins").isChecked).toBe(true);
    expect(res.progress).toEqual({ done: 1, total: 2 });
  });

  it("Abhaken eines Überpunkts hakt alle Unterpunkte ab, Zurücknehmen nimmt sie zurück", async () => {
    const { run } = await setup();
    let res = (await check(find(run, "Eins").id, true)).json().run as Run;
    for (const t of ["Eins", "Eltern", "k1", "k2", "solo"]) expect(find(res, t).isChecked).toBe(true);
    expect(find(res, "Zwei").isChecked).toBe(false);
    res = (await check(find(run, "k1").id, false)).json().run as Run; // ein Unterpunkt offen → alle Überpunkte darüber offen
    expect(find(res, "Eltern").isChecked).toBe(false);
    expect(find(res, "Eins").isChecked).toBe(false);
    expect(find(res, "k2").isChecked).toBe(true);
    res = (await check(find(run, "Eins").id, false)).json().run as Run;
    for (const t of ["Eins", "Eltern", "k1", "k2", "solo"]) expect(find(res, t).isChecked).toBe(false);
  });

  it("neue offene Unterpunkte machen einen erledigten Überpunkt wieder offen", async () => {
    const { run } = await setup();
    await check(find(run, "Eltern").id, true);
    const res = (await anna.post(`/api/v1/runs/${run.id}/items`, { title: "k3", parentItemId: find(run, "Eltern").id })).json().run as Run;
    expect(find(res, "Eltern").isChecked).toBe(false);
    expect(find(res, "Eltern").childProgress).toEqual({ done: 2, total: 3 });
  });

  it("aktualisiert updatedAt der Durchführung und führt sie in der Liste mit Fortschritt", async () => {
    const { run } = await setup();
    const created = ctx.db.select().from(schema.runs).get()!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await check(find(run, "x").id, true);
    const list = (await anna.get("/api/v1/runs")).json();
    expect(list.runs[0]).toMatchObject({ title: "Lauf", itemTitles: ["Eins", "Zwei"], progress: { done: 1, total: 2 } });
    expect(list.runs[0].updatedAt).toBeGreaterThan(created);
  });
});

describe("Eigene Punkte bearbeiten (F-25)", () => {
  async function setup() {
    const t1 = await template(anna, "Eins", ["a", "b", "c"]);
    const { run } = await createRun(anna, "Lauf", [t1]);
    await anna.post(`/api/v1/runs/${run.id}/items`, { items: [{ title: "p", children: [{ title: "p1" }] }] });
    const current = await getRun(anna, run.id);
    const byTitle = (title: string) => {
      let found!: Item;
      const walk = (items: Item[]) => items.forEach((i) => { if (i.title === title) found = i; walk(i.children); });
      current.sections.forEach((s) => walk(s.items));
      return found.id;
    };
    return { run: current, byTitle };
  }

  it("fügt Punkte und Unterpunkte ein, ändert den Titel und löscht samt Unterpunkten", async () => {
    const { run, byTitle } = await setup();
    let res = (await anna.post(`/api/v1/runs/${run.id}/items`, { title: "neu", parentItemId: byTitle("Eins"), position: 1 })).json().run as Run;
    expect(names(res.sections[0]!.items)).toEqual([["Eins", ["a", "neu", "b", "c"]], ["p", ["p1"]]]);
    res = (await anna.put(`/api/v1/run-items/${byTitle("b")}`, { title: "B!" })).json().run as Run;
    expect(names(res.sections[0]!.items)).toEqual([["Eins", ["a", "neu", "B!", "c"]], ["p", ["p1"]]]);
    res = (await anna.del(`/api/v1/run-items/${byTitle("Eins")}`)).json().run as Run;
    expect(names(res.sections[0]!.items)).toEqual([["p", ["p1"]]]);
    expect(res.sections[0]!.items.map((i) => (i as Item & { position: number }).position)).toEqual([0]);
  });

  it("lehnt unbekannte Elternpunkte beim Anlegen ab", async () => {
    const { run } = await setup();
    const res = await anna.post(`/api/v1/runs/${run.id}/items`, { title: "x", parentItemId: crypto.randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("parent_not_found");
  });

  it("sortiert um und verschiebt zwischen Ebenen samt Unterpunkten", async () => {
    const { byTitle } = await setup();
    const move = (id: string, body: object) => anna.post(`/api/v1/run-items/${id}/move`, body);
    let res = (await move(byTitle("c"), { parentItemId: byTitle("Eins"), position: 0 })).json().run as Run;
    expect(names(res.sections[0]!.items)).toEqual([["Eins", ["c", "a", "b"]], ["p", ["p1"]]]);
    res = (await move(byTitle("p"), { parentItemId: byTitle("a"), position: 0 })).json().run as Run;
    expect(names(res.sections[0]!.items)).toEqual([["Eins", ["c", ["a", [["p", ["p1"]]]], "b"]]]);
    expect(res.progress).toEqual({ done: 0, total: 1 });
  });

  it("verbietet Zyklen, unbekannte Eltern und zu große Tiefe", async () => {
    const { run, byTitle } = await setup();
    const move = (id: string, body: object) => anna.post(`/api/v1/run-items/${id}/move`, body);
    const cyc = await move(byTitle("p"), { parentItemId: byTitle("p1"), position: 0 });
    expect([cyc.statusCode, cyc.json().error]).toEqual([422, "cycle"]);
    const noParent = await move(byTitle("a"), { parentItemId: crypto.randomUUID(), position: 0 });
    expect([noParent.statusCode, noParent.json().error]).toEqual([404, "parent_not_found"]);

    let parent: string | null = null;
    const deep = await createRun(anna, "Tief");
    for (let i = 1; i <= 50; i++) {
      parent = (await anna.post(`/api/v1/runs/${deep.run.id}/items`, { title: `E${i}`, parentItemId: parent })).json().itemId;
    }
    const tooDeep = await anna.post(`/api/v1/runs/${deep.run.id}/items`, { title: "zu tief", parentItemId: parent });
    expect([tooDeep.statusCode, tooDeep.json().error]).toEqual([422, "too_deep"]);
    expect(run.id).toBeTruthy();
  });
});

describe("Verwalten: Liste, Umbenennen, Löschen (F-20, F-27)", () => {
  it("listet nur aktive, nicht gelöschte eigene Durchführungen mit Suche und Paginierung", async () => {
    const t = await template(anna, "V", ["a"]);
    const a = await createRun(anna, "Ausflug Füssen", [t]);
    const b = await createRun(anna, "Übernachtung Berlin");
    const c = await createRun(anna, "Archiviert");
    const d = await createRun(anna, "Gelöscht");
    ctx.db.update(schema.runs).set({ status: "archived" }).where(eq(schema.runs.id, c.run.id)).run();
    await anna.del(`/api/v1/runs/${d.run.id}`);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    await createRun(bob, "Bobs Lauf");

    const list = async (q = "") => (await anna.get(`/api/v1/runs${q}`)).json();
    expect((await list()).runs.map((r: { title: string }) => r.title).sort()).toEqual(["Ausflug Füssen", "Übernachtung Berlin"]);
    expect((await list("?search=ÜBERN")).runs.map((r: { id: string }) => r.id)).toEqual([b.run.id]);
    expect((await list("?status=archived")).runs.map((r: { id: string }) => r.id)).toEqual([c.run.id]);
    const page = await list("?limit=1&offset=1");
    expect([page.total, page.runs.length]).toEqual([2, 1]);
    expect(a.run.id).toBeTruthy();
  });

  it("benennt um und merkt sich den Status beim Löschen für die Wiederherstellung", async () => {
    const { run } = await createRun(anna, "Alt");
    expect((await anna.put(`/api/v1/runs/${run.id}`, { title: "Neu" })).json().run.title).toBe("Neu");
    expect((await anna.put(`/api/v1/runs/${run.id}`, { title: " " })).statusCode).toBe(400);
    expect((await anna.del(`/api/v1/runs/${run.id}`)).statusCode).toBe(204);
    expect((await anna.get(`/api/v1/runs/${run.id}`)).statusCode).toBe(404);
    const row = ctx.db.select().from(schema.runs).get()!;
    expect(row.deletedAt).toBeGreaterThan(0);
    expect(row.statusBeforeDelete).toBe("active");
  });
});

describe("Archivierte Durchführungen sind schreibgeschützt", () => {
  it("lesen erlaubt, alle Änderungen liefern 409 run_not_active", async () => {
    const t = await template(anna, "V", ["a"]);
    const { run } = await createRun(anna, "Lauf", [t]);
    ctx.db.update(schema.runs).set({ status: "archived" }).run();
    const section = run.sections[0]!;
    const item = section.items[0]!.children[0]!;
    expect((await anna.get(`/api/v1/runs/${run.id}`)).statusCode).toBe(200);
    const results = await Promise.all([
      anna.put(`/api/v1/runs/${run.id}`, { title: "X" }),
      anna.post(`/api/v1/runs/${run.id}/templates`, { templateIds: [t] }),
      anna.post(`/api/v1/runs/${run.id}/items`, { title: "n" }),
      anna.post(`/api/v1/run-sections/${section.id}/items`, { title: "n" }),
      anna.put(`/api/v1/run-items/${item.id}`, { isChecked: true }),
      anna.del(`/api/v1/run-items/${item.id}`),
      anna.post(`/api/v1/run-items/${item.id}/move`, { parentItemId: null, position: 0 }),
    ]);
    expect(results.map((r) => [r.statusCode, r.json().error])).toEqual(Array(7).fill([409, "run_not_active"]));
    expect(ctx.db.select().from(schema.runItems).get()!.isChecked).toBe(false);
  });
});

describe("Mandantentrennung (N-04)", () => {
  it("fremde Durchführungen, Abschnitte und Punkte verhalten sich wie nicht vorhanden", async () => {
    const t = await template(anna, "V", ["a"]);
    const { run } = await createRun(anna, "Annas Lauf", [t]);
    const section = run.sections[0]!;
    const item = section.items[0]!;
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const results = await Promise.all([
      bob.get(`/api/v1/runs/${run.id}`),
      bob.put(`/api/v1/runs/${run.id}`, { title: "Gehackt" }),
      bob.del(`/api/v1/runs/${run.id}`),
      bob.post(`/api/v1/runs/${run.id}/templates`, { templateIds: [t] }),
      bob.post(`/api/v1/runs/${run.id}/items`, { title: "x" }),
      bob.post(`/api/v1/run-sections/${section.id}/items`, { title: "x" }),
      bob.put(`/api/v1/run-items/${item.id}`, { isChecked: true }),
      bob.del(`/api/v1/run-items/${item.id}`),
      bob.post(`/api/v1/run-items/${item.id}/move`, { parentItemId: null, position: 0 }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual(Array(9).fill(404));
    expect((await bob.get("/api/v1/runs")).json().total).toBe(0);
    expect(names((await getRun(anna, run.id)).sections[0]!.items)).toEqual([["V", ["a"]]]);
  });

  it("verlangt Anmeldung", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/runs" })).statusCode).toBe(401);
  });
});
