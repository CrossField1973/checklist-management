import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

/** Technische Obergrenze der Verschachtelung (F-75), nur als Schutz vor Endlosschleifen. */
export const MAX_DEPTH = 50;

type Item = typeof schema.templateItems.$inferSelect;
// Transaktionsobjekt hat dieselbe Abfrage-API wie die Datenbank.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/** Angaben zu einer verwiesenen Vorlage (`missing` = gelöscht oder nicht mehr vorhanden). */
export interface RefInfo { templateId: string; title: string; itemCount: number; missing: boolean }

export interface ItemNode {
  id: string;
  title: string;
  position: number;
  /** Verweis auf eine andere Vorlage (dann ohne eigene Unterpunkte); sonst null */
  ref: RefInfo | null;
  children: ItemNode[];
}

export class ItemError extends Error {
  constructor(public code: "parent_not_found" | "cycle" | "too_deep" | "not_found" | "too_many_items" | "ref_cycle" | "unknown_template" | "title_required") {
    super(code);
  }
}

export function loadItems(db: Conn, templateId: string): Item[] {
  return db.select().from(schema.templateItems).where(eq(schema.templateItems.templateId, templateId)).all();
}

/** Baut den verschachtelten Baum; Geschwister nach `position` sortiert. */
export function buildTree(items: Item[], refs: ReadonlyMap<string, RefInfo> = new Map()): ItemNode[] {
  const nodes = new Map<string, ItemNode>(
    items.map((i) => [i.id, {
      id: i.id, title: i.refTemplateId ? (refs.get(i.refTemplateId)?.title ?? i.title) : i.title, position: i.position, children: [],
      ref: i.refTemplateId ? (refs.get(i.refTemplateId) ?? { templateId: i.refTemplateId, title: i.title, itemCount: 0, missing: true }) : null,
    }]),
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
  input: { title: string; parentItemId?: string | null; position?: number },
): Item {
  return db.transaction((tx) => {
    const items = loadItems(tx, templateId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const parentId = input.parentItemId ?? null;
    if (parentId && (!byId.has(parentId) || byId.get(parentId)!.refTemplateId)) throw new ItemError("parent_not_found");
    if (depthOf(byId, parentId) + 1 > MAX_DEPTH) throw new ItemError("too_deep");

    const siblings = siblingIds(tx, templateId, parentId);
    const index = Math.min(Math.max(input.position ?? siblings.length, 0), siblings.length);
    const [item] = tx.insert(schema.templateItems)
      .values({ templateId, parentItemId: parentId, title: input.title, position: index })
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
      if (!parent || parent.refTemplateId) throw new ItemError("parent_not_found");
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

/** Obergrenze der Punkte, die auf einmal geschrieben werden (Anlegen/Speichern einer ganzen Vorlage). */
export const MAX_BULK_ITEMS = 5000;

/** Punkt ohne Verweis (Durchführungen, Exporte). */
export interface PlainItem { title: string; children?: PlainItem[] }
export interface ItemInput { title?: string; children?: ItemInput[]; refTemplateId?: string }

/** Eigene Vorlage (auch aus dem Papierkorb), sonst undefined. */
const ownedTemplate = (db: Conn, id: string, ownerId: string) =>
  db.select().from(schema.templates).where(and(eq(schema.templates.id, id), eq(schema.templates.ownerId, ownerId))).get();

/** Führt von `from` über Verweise zu `target`? (Schutz vor Kreisen: A enthält B enthält A.) */
function reaches(db: Conn, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.select({ ref: schema.templateItems.refTemplateId }).from(schema.templateItems)
      .where(eq(schema.templateItems.templateId, cur)).all()) {
      if (r.ref) stack.push(r.ref);
    }
  }
  return false;
}

/**
 * Ersetzt alle Punkte einer Vorlage durch den übergebenen Baum (Reihenfolge = Position). Punkt-IDs werden neu vergeben;
 * sie werden nirgends sonst referenziert (Durchführungen sind Momentaufnahmen). Punkte mit `refTemplateId` verweisen auf eine
 * andere eigene Vorlage (ohne eigene Unterpunkte); Verweise auf die Vorlage selbst oder Kreise werden abgelehnt.
 */
export function replaceItems(db: Conn, templateId: string, tree: ItemInput[], ownerId: string): void {
  let count = 0;
  const refs = new Map<string, string>();
  const check = (nodes: ItemInput[], depth: number) => {
    if (depth > MAX_DEPTH) throw new ItemError("too_deep");
    for (const n of nodes) {
      if (++count > MAX_BULK_ITEMS) throw new ItemError("too_many_items");
      if (n.refTemplateId) {
        const target = ownedTemplate(db, n.refTemplateId, ownerId);
        if (!target) throw new ItemError("unknown_template");
        if (target.id === templateId || reaches(db, target.id, templateId)) throw new ItemError("ref_cycle");
        refs.set(target.id, target.title);
      } else {
        if (!n.title) throw new ItemError("title_required");
        check(n.children ?? [], depth + 1);
      }
    }
  };
  check(tree, 1);
  db.delete(schema.templateItems).where(eq(schema.templateItems.templateId, templateId)).run();
  const insert = (nodes: ItemInput[], parentItemId: string | null) => {
    nodes.forEach((n, position) => {
      const refTitle = n.refTemplateId ? refs.get(n.refTemplateId) : undefined;
      const [row] = db.insert(schema.templateItems)
        .values({ templateId, parentItemId, title: refTitle ?? n.title!, position, refTemplateId: n.refTemplateId ?? null }).returning().all();
      if (!n.refTemplateId) insert(n.children ?? [], row!.id);
    });
  };
  insert(tree, null);
}

/** Löscht einen Punkt samt Unterpunkten (Cascade) und schließt die Lücke bei den Geschwistern. */
export function deleteItem(db: Db, item: Item): void {
  db.transaction((tx) => {
    tx.delete(schema.templateItems).where(eq(schema.templateItems.id, item.id)).run();
    renumber(tx, siblingIds(tx, item.templateId, item.parentItemId));
  });
}

/** Kopiert alle Punkte einer Vorlage in eine andere (neue IDs, gleiche Struktur, Verweise bleiben Verweise). */
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
     
      position: i.position,
      refTemplateId: i.refTemplateId,
    }).run();
  }
}

// ---------- Verweise auflösen ----------
/** Anzahl der Punkte einer Vorlage inklusive der Punkte verwiesener Vorlagen (jeder Verweis zählt selbst mit). */
function expandedCount(db: Conn, templateId: string, path: Set<string>): number {
  if (path.has(templateId)) return 0;
  const next = new Set(path).add(templateId);
  let n = 0;
  for (const i of loadItems(db, templateId)) {
    n += 1;
    if (i.refTemplateId) {
      const t = db.select().from(schema.templates).where(eq(schema.templates.id, i.refTemplateId)).get();
      if (t && t.deletedAt === null) n += expandedCount(db, t.id, next);
    }
  }
  return n;
}

/** Infos zu allen Vorlagen, auf die die Punkte verweisen. */
export function refInfos(db: Conn, items: Item[]): Map<string, RefInfo> {
  const ids = [...new Set(items.map((i) => i.refTemplateId).filter((x): x is string => !!x))];
  const out = new Map<string, RefInfo>();
  if (!ids.length) return out;
  const found = new Map(db.select().from(schema.templates).where(inArray(schema.templates.id, ids)).all().map((t) => [t.id, t]));
  for (const id of ids) {
    const t = found.get(id);
    out.set(id, t && t.deletedAt === null
      ? { templateId: id, title: t.title, itemCount: expandedCount(db, id, new Set()), missing: false }
      : { templateId: id, title: t?.title ?? "", itemCount: 0, missing: true });
  }
  return out;
}

/** Punktebaum einer Vorlage mit Angaben zu den Verweisen. */
export const treeOf = (db: Conn, templateId: string): ItemNode[] => {
  const items = loadItems(db, templateId);
  return buildTree(items, refInfos(db, items));
};

/**
 * Punktebaum mit aufgelösten Verweisen (Momentaufnahme für Durchführungen und Exporte): ein Verweis wird zum Punkt mit dem
 * Namen der Vorlage, deren Punkte darunter stehen. Gelöschte Vorlagen fehlen dann.
 */
export function expandTemplate(db: Conn, templateId: string, path: ReadonlySet<string> = new Set(), counter = { n: 0 }): PlainItem[] {
  const next = new Set(path).add(templateId);
  const walk = (nodes: ItemNode[]): PlainItem[] => nodes.flatMap((n): PlainItem[] => {
    if (++counter.n > MAX_BULK_ITEMS) throw new ItemError("too_many_items");
    if (n.ref) {
      if (n.ref.missing || next.has(n.ref.templateId)) return [];
      return [{ title: n.ref.title, children: expandTemplate(db, n.ref.templateId, next, counter) }];
    }
    return [{ title: n.title, children: walk(n.children) }];
  });
  return walk(treeOf(db, templateId));
}

/** In wie vielen (nicht gelöschten) anderen Vorlagen wird diese Vorlage eingefügt? */
export function usedInCount(db: Conn, templateId: string): number {
  const rows = db.select({ templateId: schema.templateItems.templateId, deletedAt: schema.templates.deletedAt }).from(schema.templateItems)
    .innerJoin(schema.templates, eq(schema.templates.id, schema.templateItems.templateId))
    .where(eq(schema.templateItems.refTemplateId, templateId)).all();
  return new Set(rows.filter((r) => r.deletedAt === null && r.templateId !== templateId).map((r) => r.templateId)).size;
}
