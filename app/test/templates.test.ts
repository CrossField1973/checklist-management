import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
interface Node { id: string; title: string; position: number; children: Node[] }

const titles = (nodes: Node[]): unknown[] => nodes.map((n) => (n.children.length ? [n.title, titles(n.children)] : n.title));

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

async function makeTemplate(client: Client, title = "Tagesausflug", extra: object = {}) {
  const res = await client.post("/api/v1/templates", { title, ...extra });
  return res.json().template as { id: string; items: Node[]; tags: { id: string }[]; itemCount: number; title: string };
}
async function addItem(client: Client, templateId: string, title: string, parentItemId: string | null = null, position?: number) {
  const res = await client.post(`/api/v1/templates/${templateId}/items`, { title, parentItemId, ...(position !== undefined && { position }) });
  expect(res.statusCode).toBe(201);
  return res.json() as { itemId: string; items: Node[] };
}

describe("Tags (F-17, F-18)", () => {
  it("vergibt automatisch unterschiedliche Farben und liefert Textfarbe", async () => {
    const a = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    const b = (await anna.post("/api/v1/tags", { name: "Outdoor" })).json().tag;
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.color).not.toBe(a.color);
    expect(["#ffffff", "#000000"]).toContain(a.textColor);
  });

  it("übernimmt eine gewählte Farbe und lehnt ungültige ab", async () => {
    expect((await anna.post("/api/v1/tags", { name: "Rot", color: "#DC2626" })).json().tag.color).toBe("#dc2626");
    expect((await anna.post("/api/v1/tags", { name: "Kaputt", color: "rot" })).statusCode).toBe(400);
  });

  it("verhindert doppelte Namen (ohne Beachtung der Groß-/Kleinschreibung), erlaubt sie aber bei anderen Nutzern", async () => {
    await anna.post("/api/v1/tags", { name: "Reisen" });
    expect((await anna.post("/api/v1/tags", { name: "reisen" })).statusCode).toBe(409);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    expect((await bob.post("/api/v1/tags", { name: "Reisen" })).statusCode).toBe(201);
  });

  it("benennt um und ändert die Farbe", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Alt" })).json().tag;
    const res = await anna.put(`/api/v1/tags/${tag.id}`, { name: "Neu", color: "#16a34a" });
    expect(res.json().tag).toMatchObject({ name: "Neu", color: "#16a34a" });
  });

  it("löscht nur die Zuordnung, nicht die Vorlagen", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    const tpl = await makeTemplate(anna, "T", { tagIds: [tag.id] });
    expect((await anna.del(`/api/v1/tags/${tag.id}`)).statusCode).toBe(204);
    const after = (await anna.get(`/api/v1/templates/${tpl.id}`)).json().template;
    expect(after.tags).toEqual([]);
  });

  it("listet Tags mit Anzahl verwendeter Vorlagen", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    await makeTemplate(anna, "A", { tagIds: [tag.id] });
    await makeTemplate(anna, "B", { tagIds: [tag.id] });
    expect((await anna.get("/api/v1/tags")).json().tags[0].templateCount).toBe(2);
  });
});

describe("Vorlagen (F-11, F-12, F-15, F-16)", () => {
  it("verlangt Anmeldung", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/templates" })).statusCode).toBe(401);
  });

  it("legt an, liest, ändert Titel, Beschreibung und Tags", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    const tpl = await makeTemplate(anna, "  Tagesausflug  ", { description: "Für unterwegs" });
    expect(tpl.title).toBe("Tagesausflug");
    const res = await anna.put(`/api/v1/templates/${tpl.id}`, { title: "Ausflug", tagIds: [tag.id], description: null });
    expect(res.json().template).toMatchObject({ title: "Ausflug", description: null, tags: [{ id: tag.id }] });
  });

  it("lehnt leere Titel und fremde Tags ab", async () => {
    expect((await anna.post("/api/v1/templates", { title: "   " })).statusCode).toBe(400);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const bobTag = (await bob.post("/api/v1/tags", { name: "Bob" })).json().tag;
    const res = await anna.post("/api/v1/templates", { title: "X", tagIds: [bobTag.id] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_tag");
  });

  it("sucht, filtert nach Tag, sortiert und paginiert", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    await makeTemplate(anna, "Übernachtung", { tagIds: [tag.id] });
    await makeTemplate(anna, "Therme", { tagIds: [tag.id] });
    await makeTemplate(anna, "Wohnung putzen");
    const list = async (q: string) => (await anna.get(`/api/v1/templates${q}`)).json();
    expect((await list("")).total).toBe(3);
    expect((await list("?search=ÜBERN")).templates.map((t: { title: string }) => t.title)).toEqual(["Übernachtung"]);
    expect((await list(`?tagId=${tag.id}&sort=title`)).templates.map((t: { title: string }) => t.title)).toEqual(["Therme", "Übernachtung"]);
    const page = await list("?sort=title&limit=1&offset=1");
    expect(page.total).toBe(3);
    expect(page.templates.map((t: { title: string }) => t.title)).toEqual(["Übernachtung"]); // Reihenfolge: Therme, Übernachtung, Wohnung
  });

  it("zeigt die Anzahl der Punkte (auch Unterpunkte) in der Liste", async () => {
    const tpl = await makeTemplate(anna);
    const a = await addItem(anna, tpl.id, "A");
    await addItem(anna, tpl.id, "A1", a.itemId);
    expect((await anna.get("/api/v1/templates")).json().templates[0].itemCount).toBe(2);
  });

  it("dupliziert Vorlage samt verschachtelter Punkte und Tags", async () => {
    const tag = (await anna.post("/api/v1/tags", { name: "Reisen" })).json().tag;
    const tpl = await makeTemplate(anna, "Original", { tagIds: [tag.id] });
    const a = await addItem(anna, tpl.id, "A");
    await addItem(anna, tpl.id, "A1", a.itemId);
    await addItem(anna, tpl.id, "B");
    const copy = (await anna.post(`/api/v1/templates/${tpl.id}/duplicate`)).json().template;
    expect(copy.title).toBe("Original (Kopie)");
    expect(copy.id).not.toBe(tpl.id);
    expect(titles(copy.items)).toEqual([["A", ["A1"]], "B"]);
    expect(copy.tags).toHaveLength(1);
    expect(copy.items[0].id).not.toBe(a.items[0]!.id);
  });

  it("löscht in den Papierkorb (Soft-Delete) und blendet die Vorlage aus", async () => {
    const tpl = await makeTemplate(anna);
    expect((await anna.del(`/api/v1/templates/${tpl.id}`)).statusCode).toBe(204);
    expect((await anna.get(`/api/v1/templates/${tpl.id}`)).statusCode).toBe(404);
    expect((await anna.get("/api/v1/templates")).json().total).toBe(0);
    const row = ctx.db.select().from(schema.templates).where(eq(schema.templates.id, tpl.id)).get();
    expect(row?.deletedAt).toBeGreaterThan(0);
  });
});

describe("Mandantentrennung (N-04)", () => {
  it("fremde Vorlagen, Punkte und Tags verhalten sich wie nicht vorhanden", async () => {
    const tpl = await makeTemplate(anna);
    const item = await addItem(anna, tpl.id, "A");
    const tag = (await anna.post("/api/v1/tags", { name: "T" })).json().tag;
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");

    const responses = await Promise.all([
      bob.get(`/api/v1/templates/${tpl.id}`),
      bob.put(`/api/v1/templates/${tpl.id}`, { title: "Gehackt" }),
      bob.del(`/api/v1/templates/${tpl.id}`),
      bob.post(`/api/v1/templates/${tpl.id}/duplicate`),
      bob.post(`/api/v1/templates/${tpl.id}/items`, { title: "X" }),
      bob.put(`/api/v1/template-items/${item.itemId}`, { title: "X" }),
      bob.del(`/api/v1/template-items/${item.itemId}`),
      bob.post(`/api/v1/template-items/${item.itemId}/move`, { parentItemId: null, position: 0 }),
      bob.put(`/api/v1/tags/${tag.id}`, { name: "X" }),
      bob.del(`/api/v1/tags/${tag.id}`),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual(Array(10).fill(404));
    expect((await bob.get("/api/v1/templates")).json().total).toBe(0);
    expect((await anna.get(`/api/v1/templates/${tpl.id}`)).json().template.title).toBe("Tagesausflug");
  });
});

describe("Punkte und Unterpunkte (F-13, F-14)", () => {
  it("fügt Punkte in Reihenfolge ein und unterstützt Einfügen an Position", async () => {
    const tpl = await makeTemplate(anna);
    await addItem(anna, tpl.id, "A");
    await addItem(anna, tpl.id, "C");
    const res = await addItem(anna, tpl.id, "B", null, 1);
    expect(titles(res.items)).toEqual(["A", "B", "C"]);
    expect(res.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("erlaubt beliebig tiefe Verschachtelung (hier 6 Ebenen)", async () => {
    const tpl = await makeTemplate(anna);
    let parent: string | null = null;
    let last!: { itemId: string; items: Node[] };
    for (let i = 1; i <= 6; i++) {
      last = await addItem(anna, tpl.id, `Ebene ${i}`, parent);
      parent = last.itemId;
    }
    expect(titles(last.items)).toEqual([["Ebene 1", [["Ebene 2", [["Ebene 3", [["Ebene 4", [["Ebene 5", ["Ebene 6"]]]]]]]]]]]);
  });

  it("ändert Titel/Beschreibung und aktualisiert die Vorlage (updatedAt)", async () => {
    const tpl = await makeTemplate(anna);
    const { itemId } = await addItem(anna, tpl.id, "A");
    const before = ctx.db.select().from(schema.templates).get()!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const res = await anna.put(`/api/v1/template-items/${itemId}`, { title: "A neu", description: "Details" });
    expect(res.json().items[0]).toMatchObject({ title: "A neu", description: "Details" });
    expect(ctx.db.select().from(schema.templates).get()!.updatedAt).toBeGreaterThan(before);
  });

  it("löscht einen Punkt samt Unterpunkten und schließt Lücken", async () => {
    const tpl = await makeTemplate(anna);
    await addItem(anna, tpl.id, "A");
    const b = await addItem(anna, tpl.id, "B");
    await addItem(anna, tpl.id, "B1", b.itemId);
    await addItem(anna, tpl.id, "C");
    const res = (await anna.del(`/api/v1/template-items/${b.itemId}`)).json();
    expect(titles(res.items)).toEqual(["A", "C"]);
    expect(res.items.map((i: Node) => i.position)).toEqual([0, 1]);
    expect(ctx.db.select().from(schema.templateItems).all()).toHaveLength(2);
  });

  it("lehnt unbekannten Elternpunkt (auch aus anderer Vorlage) ab", async () => {
    const t1 = await makeTemplate(anna, "T1");
    const t2 = await makeTemplate(anna, "T2");
    const foreign = await addItem(anna, t2.id, "X");
    const res = await anna.post(`/api/v1/templates/${t1.id}/items`, { title: "A", parentItemId: foreign.itemId });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("parent_not_found");
  });
});

describe("Verschieben per Drag-and-Drop (F-14)", () => {
  async function build() {
    const tpl = await makeTemplate(anna);
    const a = await addItem(anna, tpl.id, "A");
    const b = await addItem(anna, tpl.id, "B");
    const c = await addItem(anna, tpl.id, "C");
    const a1 = await addItem(anna, tpl.id, "A1", a.itemId);
    const a2 = await addItem(anna, tpl.id, "A2", a.itemId);
    return { tpl, a: a.itemId, b: b.itemId, c: c.itemId, a1: a1.itemId, a2: a2.itemId };
  }
  const move = async (id: string, parentItemId: string | null, position: number) =>
    anna.post(`/api/v1/template-items/${id}/move`, { parentItemId, position });

  it("sortiert innerhalb derselben Ebene um", async () => {
    const t = await build();
    const res = (await move(t.c, null, 0)).json();
    expect(titles(res.items)).toEqual(["C", ["A", ["A1", "A2"]], "B"]);
    expect(res.items.map((i: Node) => i.position)).toEqual([0, 1, 2]);
  });

  it("verschiebt zwischen Ebenen (rein, raus) und nummeriert beide Ebenen neu", async () => {
    const t = await build();
    let res = (await move(t.b, t.a, 1)).json(); // B unter A zwischen A1 und A2
    expect(titles(res.items)).toEqual([["A", ["A1", "B", "A2"]], "C"]);
    res = (await move(t.a1, null, 2)).json(); // A1 auf oberste Ebene ans Ende
    expect(titles(res.items)).toEqual([["A", ["B", "A2"]], "C", "A1"]);
    const all = ctx.db.select().from(schema.templateItems).all();
    const positions = (parent: string | null) => all.filter((i) => i.parentItemId === parent).map((i) => i.position).sort();
    expect(positions(null)).toEqual([0, 1, 2]);
    expect(positions(t.a)).toEqual([0, 1]);
  });

  it("nimmt Unterpunkte beim Verschieben mit", async () => {
    const t = await build();
    const res = (await move(t.a, t.c, 0)).json();
    expect(titles(res.items)).toEqual(["B", ["C", [["A", ["A1", "A2"]]]]]);
  });

  it("begrenzt zu große Positionen auf das Ende", async () => {
    const t = await build();
    expect(titles((await move(t.a, null, 999)).json().items)).toEqual(["B", "C", ["A", ["A1", "A2"]]]);
  });

  it("verbietet Zyklen (in sich selbst oder in Nachfahren)", async () => {
    const t = await build();
    for (const target of [t.a, t.a1]) {
      const res = await move(t.a, target, 0);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("cycle");
    }
    // Struktur unverändert
    expect(titles((await anna.get(`/api/v1/templates/${t.tpl.id}`)).json().template.items)).toEqual([["A", ["A1", "A2"]], "B", "C"]);
  });

  it("lehnt unbekannte Zielpunkte ab und lässt keine Verschiebung in andere Vorlagen zu", async () => {
    const t = await build();
    const other = await makeTemplate(anna, "Andere");
    const x = await addItem(anna, other.id, "X");
    const res = await move(t.b, x.itemId, 0);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("parent_not_found");
  });

  it("begrenzt die Tiefe technisch auf 50 Ebenen", async () => {
    const tpl = await makeTemplate(anna);
    let parent: string | null = null;
    for (let i = 1; i <= 50; i++) parent = (await addItem(anna, tpl.id, `E${i}`, parent)).itemId;
    const res = await anna.post(`/api/v1/templates/${tpl.id}/items`, { title: "zu tief", parentItemId: parent });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("too_deep");
    // Verschieben eines Teilbaums unter die tiefste Ebene ist ebenfalls verboten
    const solo = await addItem(anna, tpl.id, "Solo");
    const mv = await anna.post(`/api/v1/template-items/${solo.itemId}/move`, { parentItemId: parent, position: 0 });
    expect(mv.statusCode).toBe(422);
  });
});
