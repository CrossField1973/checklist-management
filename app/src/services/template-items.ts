import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

/** Technische Obergrenze der Verschachtelung (F-75), nur als Schutz vor Endlosschleifen. */
export const MAX_DEPTH = 50;

type Item = typeof schema.templateItems.$inferSelect;
// Transaktionsobjekt hat dieselbe Abfrage-API wie die Datenbank.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export interface ItemNode {
  id: string;
  title: string;
  description: string | null;
  position: number;
  children: ItemNode[];
}

export class ItemError extends Error {
  constructor(public code: "parent_not_found" | "cycle" | "too_deep" | "not_found") {
    super(code);
  }
}

export function loadItems(db: Conn, templateId: string): Item[] {
  return db.select().from(schema.templateItems).where(eq(schema.templateItems.templateId, templateId)).all();
}

/** Baut den verschachtelten Baum; Geschwister nach `position` sortiert. */
export function buildTree(items: Item[]): ItemNode[] {
  const nodes = new Map<string, ItemNode>(
    items.map((i) => [i.id, { id: i.id, title: i.title, description: i.description, position: i.position, children: [] }]),
  );
  const roots: ItemNode[] = [];
  for (const i of items) {
    const node = nodes.get(i.id)!;
    const parent = i.parentItemId ? nodes.get(i.parentItemId) : null;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: ItemNode[]) => {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}


const siblingIds = (db: Conn, templateId: string, parentId: string | null, exceptId?: string): string[] =>
  db.select().from(schema.templateItems)
    .where(and(eq(schema.templateItems.templateId, templateId), parentId ? eq(schema.templateItems.parentItemId, parentId) : isNull(schema.templateItems.parentItemId)))
    .orderBy(schema.templateItems.position, schema.templateItems.id)
    .all()
    .filter((i) => i.id !== exceptId)
    .map((i) => i.id);

/** Schreibt die Positionen 0..n-1 in der angegebenen Reihenfolge. */
function renumber(db: Conn, ids: string[]) {
  ids.forEach((id, position) => db.update(schema.templateItems).set({ position }).where(eq(schema.templateItems.id, id)).run());
}

function depthOf(byId: Map<string, Item>, id: string | null): number {
  let depth = 0;
  for (let cur = id ? byId.get(id) : undefined; cur; cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined) depth++;
  return depth;
}

function subtreeHeight(items: Item[], id: string): number {
  const children = items.filter((i) => i.parentItemId === id);
  return 1 + Math.max(0, ...children.map((c) => subtreeHeight(items, c.id)));
}

/** Fügt einen Punkt ein (position = Index unter den Geschwistern, Standard: ans Ende). */
export function addItem(
  db: Db,
  templateId: string,
  input: { title: string; description?: string | null; parentItemId?: string | null; position?: number },
): Item {
  return db.transaction((tx) => {
    const items = loadItems(tx, templateId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const parentId = input.parentItemId ?? null;
    if (parentId && !byId.has(parentId)) throw new ItemError("parent_not_found");
    if (depthOf(byId, parentId) + 1 > MAX_DEPTH) throw new ItemError("too_deep");

    const siblings = siblingIds(tx, templateId, parentId);
    const index = Math.min(Math.max(input.position ?? siblings.length, 0), siblings.length);
    const [item] = tx.insert(schema.templateItems)
      .values({ templateId, parentItemId: parentId, title: input.title, description: input.description ?? null, position: index })
      .returning().all();
    siblings.splice(index, 0, item!.id);
    renumber(tx, siblings);
    return { ...item!, position: index };
  });
}

/** Verschiebt einen Punkt samt Unterpunkten (Drag-and-Drop, auch zwischen Ebenen). */
export function moveItem(db: Db, item: Item, newParentId: string | null, position: number): void {
  db.transaction((tx) => {
    const items = loadItems(tx, item.templateId);
    const byId = new Map(items.map((i) => [i.id, i]));
    if (newParentId) {
      const parent = byId.get(newParentId);
      if (!parent) throw new ItemError("parent_not_found");
      // Zyklus: neuer Elternpunkt darf der Punkt selbst oder einer seiner Nachfahren sein → verboten.
      for (let cur: Item | undefined = parent; cur; cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined) {
        if (cur.id === item.id) throw new ItemError("cycle");
      }
    }
    if (depthOf(byId, newParentId) + subtreeHeight(items, item.id) > MAX_DEPTH) throw new ItemError("too_deep");

    const oldParentId = item.parentItemId;
    const target = siblingIds(tx, item.templateId, newParentId, item.id);
    const index = Math.min(Math.max(position, 0), target.length);
    target.splice(index, 0, item.id);
    tx.update(schema.templateItems).set({ parentItemId: newParentId }).where(eq(schema.templateItems.id, item.id)).run();
    renumber(tx, target);
    if ((oldParentId ?? null) !== (newParentId ?? null)) {
      renumber(tx, siblingIds(tx, item.templateId, oldParentId, item.id));
    }
  });
}

/** Löscht einen Punkt samt Unterpunkten (Cascade) und schließt die Lücke bei den Geschwistern. */
export function deleteItem(db: Db, item: Item): void {
  db.transaction((tx) => {
    tx.delete(schema.templateItems).where(eq(schema.templateItems.id, item.id)).run();
    renumber(tx, siblingIds(tx, item.templateId, item.parentItemId));
  });
}

/** Kopiert alle Punkte einer Vorlage in eine andere (neue IDs, gleiche Struktur). */
export function copyItems(db: Conn, fromTemplateId: string, toTemplateId: string): void {
  const items = loadItems(db, fromTemplateId);
  const idMap = new Map<string, string>(items.map((i) => [i.id, crypto.randomUUID()]));
  // Eltern vor Kindern einfügen, damit Fremdschlüssel erfüllt sind.
  const ordered: Item[] = [];
  const visit = (parentId: string | null) => {
    for (const i of items.filter((x) => (x.parentItemId ?? null) === parentId)) {
      ordered.push(i);
      visit(i.id);
    }
  };
  visit(null);
  for (const i of ordered) {
    db.insert(schema.templateItems).values({
      id: idMap.get(i.id)!,
      templateId: toTemplateId,
      parentItemId: i.parentItemId ? idMap.get(i.parentItemId)! : null,
      title: i.title,
      description: i.description,
      position: i.position,
    }).run();
  }
}
