import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { MAX_BULK_ITEMS, MAX_DEPTH, expandTemplate, type PlainItem } from "./template-items.js";

type RunItem = typeof schema.runItems.$inferSelect;
type Section = typeof schema.runSections.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export interface Progress { done: number; total: number }

export interface RunItemNode {
  id: string;
  title: string;
  position: number;
  isChecked: boolean;
  checkedAt: number | null;
  /** Fortschritt der direkten Unterpunkte (F-24: „x/y“ am Elternpunkt). */
  childProgress: Progress;
  children: RunItemNode[];
}

export interface SectionNode {
  id: string;
  title: string;
  position: number;
  sourceTemplateId: string | null;
  progress: Progress;
  items: RunItemNode[];
}

export class RunItemError extends Error {
  constructor(public code: "parent_not_found" | "section_not_found" | "cycle" | "too_deep" | "too_many_items") {
    super(code);
  }
}

export const loadSections = (db: Conn, runId: string): Section[] =>
  db.select().from(schema.runSections).where(eq(schema.runSections.runId, runId)).orderBy(schema.runSections.position, schema.runSections.id).all();

export function loadRunItems(db: Conn, runId: string): RunItem[] {
  const ids = loadSections(db, runId).map((s) => s.id);
  return ids.length ? db.select().from(schema.runItems).where(inArray(schema.runItems.sectionId, ids)).all() : [];
}

/** Fortschritt der obersten Ebene (Unterpunkte zählen nicht mit; ein Überpunkt ist erledigt, wenn alle seine Unterpunkte es sind). */
export const progressOf = (items: readonly { isChecked: boolean; parentItemId: string | null }[]): Progress => {
  const roots = items.filter((i) => !i.parentItemId);
  return { done: roots.filter((i) => i.isChecked).length, total: roots.length };
};

/** Baut je Abschnitt den verschachtelten Punktebaum inklusive Fortschritt. */
export function buildSections(sections: Section[], items: RunItem[]): SectionNode[] {
  const nodes = new Map<string, RunItemNode>(
    items.map((i) => [i.id, {
      id: i.id, title: i.title, position: i.position, isChecked: i.isChecked,
      checkedAt: i.checkedAt, childProgress: { done: 0, total: 0 }, children: [],
    }]),
  );
  const roots = new Map<string, RunItemNode[]>(sections.map((s) => [s.id, []]));
  for (const i of items) {
    const node = nodes.get(i.id)!;
    const parent = i.parentItemId ? nodes.get(i.parentItemId) : undefined;
    (parent ? parent.children : roots.get(i.sectionId))?.push(node);
  }
  const finish = (list: RunItemNode[]): Progress => {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    for (const n of list) n.childProgress = finish(n.children);
    return { done: list.filter((n) => n.isChecked).length, total: list.length };
  };
  return sections.map((s) => {
    const list = roots.get(s.id) ?? [];
    return { id: s.id, title: s.title, position: s.position, sourceTemplateId: s.sourceTemplateId, progress: finish(list), items: list };
  });
}

const sumProgress = (sections: readonly { progress: Progress }[]): Progress =>
  sections.reduce((a, s) => ({ done: a.done + s.progress.done, total: a.total + s.progress.total }), { done: 0, total: 0 });

export function runDetail(db: Conn, runId: string) {
  const sections = buildSections(loadSections(db, runId), loadRunItems(db, runId));
  return { sections, progress: sumProgress(sections) };
}

// ---------- Interner Abschnitt ----------
/** Jede Durchführung hat genau einen internen Abschnitt, der alle obersten Punkte enthält (für Nutzer gibt es keine Abschnitte). */
export function primarySection(db: Conn, run: { id: string; title: string }): Section {
  const existing = loadSections(db, run.id)[0];
  return existing ?? db.insert(schema.runSections).values({ runId: run.id, title: run.title, position: 0 }).returning().all()[0]!;
}

/**
 * Fügt eine Vorlage als Überpunkt ans Ende ein (F-21, F-22): Momentaufnahme; die Punkte der Vorlage (inklusive eingefügter
 * Vorlagen) stehen darunter.
 */
export function appendTemplateAsItem(db: Conn, run: { id: string; title: string }, template: { id: string; title: string }) {
  const section = primarySection(db, run);
  const position = db.select().from(schema.runItems)
    .where(and(eq(schema.runItems.sectionId, section.id), isNull(schema.runItems.parentItemId))).all().length;
  const insert = (nodes: PlainItem[], parentItemId: string | null) => nodes.forEach((n, i) => {
    const [row] = db.insert(schema.runItems)
      .values({ sectionId: section.id, parentItemId, title: n.title, position: i }).returning().all();
    insert(n.children ?? [], row!.id);
  });
  const [root] = db.insert(schema.runItems)
    .values({ sectionId: section.id, parentItemId: null, title: template.title, position }).returning().all();
  insert(expandTemplate(db, template.id), root!.id);
}

// ---------- Punkte ----------
const siblingIds = (db: Conn, sectionId: string, parentId: string | null, exceptId?: string): string[] =>
  db.select().from(schema.runItems)
    .where(and(eq(schema.runItems.sectionId, sectionId), parentId ? eq(schema.runItems.parentItemId, parentId) : isNull(schema.runItems.parentItemId)))
    .orderBy(schema.runItems.position, schema.runItems.id).all()
    .filter((i) => i.id !== exceptId).map((i) => i.id);

const renumber = (db: Conn, ids: string[]) =>
  ids.forEach((id, position) => db.update(schema.runItems).set({ position }).where(eq(schema.runItems.id, id)).run());

const depthOf = (byId: Map<string, RunItem>, id: string | null) => {
  let depth = 0;
  for (let cur = id ? byId.get(id) : undefined; cur; cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined) depth++;
  return depth;
};

const subtree = (items: RunItem[], id: string): RunItem[] => {
  const out: RunItem[] = [];
  const visit = (pid: string) => items.filter((i) => i.parentItemId === pid).forEach((c) => { out.push(c); visit(c.id); });
  visit(id);
  return out;
};

const height = (items: RunItem[], id: string): number =>
  1 + Math.max(0, ...items.filter((i) => i.parentItemId === id).map((c) => height(items, c.id)));

/**
 * Gleicht die Erledigt-Markierungen der Überpunkte an: ein Punkt mit Unterpunkten ist erledigt, wenn alle seine Unterpunkte
 * erledigt sind (von unten nach oben). Punkte ohne Unterpunkte behalten ihren Zustand.
 */
export function normalizeChecks(db: Conn, runId: string) {
  const items = loadRunItems(db, runId);
  const kids = new Map<string, RunItem[]>();
  for (const i of items) if (i.parentItemId) kids.set(i.parentItemId, [...(kids.get(i.parentItemId) ?? []), i]);
  const state = new Map(items.map((i) => [i.id, i.isChecked]));
  const now = Date.now();
  const visit = (id: string): boolean => {
    const children = kids.get(id);
    if (!children) return state.get(id)!;
    const all = children.map((c) => visit(c.id)).every(Boolean);
    if (all !== state.get(id)) {
      db.update(schema.runItems).set({ isChecked: all, checkedAt: all ? now : null }).where(eq(schema.runItems.id, id)).run();
      state.set(id, all);
    }
    return all;
  };
  items.filter((i) => !i.parentItemId).forEach((i) => visit(i.id));
}

const runIdOf = (db: Conn, sectionId: string) => db.select().from(schema.runSections).where(eq(schema.runSections.id, sectionId)).get()!.runId;

function insertRunItem(
  tx: Conn, section: Section,
  input: { title: string; parentItemId?: string | null; position?: number },
): RunItem {
  {
    const items = loadRunItems(tx, section.runId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const parentId = input.parentItemId ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parentId && (!parent || parent.sectionId !== section.id)) throw new RunItemError("parent_not_found");
    if (depthOf(byId, parentId) + 1 > MAX_DEPTH) throw new RunItemError("too_deep");
    const siblings = siblingIds(tx, section.id, parentId);
    const index = Math.min(Math.max(input.position ?? siblings.length, 0), siblings.length);
    const [item] = tx.insert(schema.runItems)
      .values({ sectionId: section.id, parentItemId: parentId, title: input.title, position: index }).returning().all();
    siblings.splice(index, 0, item!.id);
    renumber(tx, siblings);
    return { ...item!, position: index };
  }
}

export function addRunItem(
  db: Db, section: Section,
  input: { title: string; parentItemId?: string | null; position?: number },
): RunItem {
  return db.transaction((tx) => {
    const item = insertRunItem(tx, section, input);
    normalizeChecks(tx, section.runId); // ein neuer offener Unterpunkt macht den Überpunkt wieder offen
    return item;
  });
}

/**
 * Hängt einen ganzen Punktebaum ans Ende eines Abschnitts (oder unter `parentItemId`) in einer Transaktion an.
 * Gibt die IDs der obersten neuen Punkte zurück. Wirft RunItemError (`parent_not_found`, `too_deep`) bzw. bei mehr als
 * MAX_BULK_ITEMS Punkten `too_many_items`.
 */
export function addRunItemTree(db: Db, section: Section, tree: PlainItem[], parentItemId: string | null = null): string[] {
  let count = 0;
  const check = (nodes: PlainItem[]) => nodes.forEach((n) => { if (++count > MAX_BULK_ITEMS) throw new RunItemError("too_many_items"); check(n.children ?? []); });
  check(tree);
  return db.transaction((tx) => {
    const insert = (nodes: PlainItem[], parent: string | null): string[] =>
      nodes.map((n) => {
        const item = insertRunItem(tx, section, { title: n.title, parentItemId: parent });
        insert(n.children ?? [], item.id);
        return item.id;
      });
    const ids = insert(tree, parentItemId);
    normalizeChecks(tx, section.runId);
    return ids;
  });
}

/** Benennt einen Abschnitt um. */
export function renameSection(db: Db, section: Section, title: string) {
  db.update(schema.runSections).set({ title }).where(eq(schema.runSections.id, section.id)).run();
}

/** Verschiebt einen Punkt samt Unterpunkten, auch in einen anderen Abschnitt derselben Durchführung. */
export function moveRunItem(db: Db, item: RunItem, runId: string, targetSectionId: string, newParentId: string | null, position: number) {
  db.transaction((tx) => {
    const items = loadRunItems(tx, runId);
    const byId = new Map(items.map((i) => [i.id, i]));
    if (!loadSections(tx, runId).some((s) => s.id === targetSectionId)) throw new RunItemError("section_not_found");
    if (newParentId) {
      const parent = byId.get(newParentId);
      if (!parent || parent.sectionId !== targetSectionId) throw new RunItemError("parent_not_found");
      for (let cur: RunItem | undefined = parent; cur; cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined) {
        if (cur.id === item.id) throw new RunItemError("cycle");
      }
    }
    if (depthOf(byId, newParentId) + height(items, item.id) > MAX_DEPTH) throw new RunItemError("too_deep");

    const oldSection = item.sectionId;
    const oldParent = item.parentItemId;
    const target = siblingIds(tx, targetSectionId, newParentId, item.id);
    target.splice(Math.min(Math.max(position, 0), target.length), 0, item.id);
    tx.update(schema.runItems).set({ parentItemId: newParentId, sectionId: targetSectionId }).where(eq(schema.runItems.id, item.id)).run();
    if (oldSection !== targetSectionId) {
      for (const d of subtree(items, item.id)) tx.update(schema.runItems).set({ sectionId: targetSectionId }).where(eq(schema.runItems.id, d.id)).run();
    }
    renumber(tx, target);
    if (oldSection !== targetSectionId || (oldParent ?? null) !== (newParentId ?? null)) {
      renumber(tx, siblingIds(tx, oldSection, oldParent, item.id));
    }
    normalizeChecks(tx, runId);
  });
}

export function deleteRunItem(db: Db, item: RunItem) {
  db.transaction((tx) => {
    tx.delete(schema.runItems).where(eq(schema.runItems.id, item.id)).run();
    renumber(tx, siblingIds(tx, item.sectionId, item.parentItemId));
    normalizeChecks(tx, runIdOf(tx, item.sectionId));
  });
}

/**
 * Ändert den Titel und hakt ab bzw. nimmt zurück (F-24); der Zeitstempel ändert sich nur bei echtem Zustandswechsel.
 * Abhaken wirkt auf alle Unterpunkte und, wenn dadurch alle Geschwister erledigt sind, auf die Überpunkte (und umgekehrt).
 */
export function updateRunItem(
  db: Db, item: RunItem,
  patch: { title?: string; isChecked?: boolean },
) {
  db.transaction((tx) => {
    const checkedChanged = patch.isChecked !== undefined && patch.isChecked !== item.isChecked;
    tx.update(schema.runItems).set({
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.isChecked !== undefined && { isChecked: patch.isChecked }),
      ...(checkedChanged && { checkedAt: patch.isChecked ? Date.now() : null }),
    }).where(eq(schema.runItems.id, item.id)).run();
    if (patch.isChecked === undefined) return;
    const runId = runIdOf(tx, item.sectionId);
    const now = Date.now();
    for (const d of subtree(loadRunItems(tx, runId), item.id)) {
      if (d.isChecked !== patch.isChecked) tx.update(schema.runItems).set({ isChecked: patch.isChecked, checkedAt: patch.isChecked ? now : null }).where(eq(schema.runItems.id, d.id)).run();
    }
    normalizeChecks(tx, runId);
  });
}
