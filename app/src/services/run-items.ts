import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { MAX_DEPTH, loadItems as loadTemplateItems } from "./template-items.js";

type RunItem = typeof schema.runItems.$inferSelect;
type Section = typeof schema.runSections.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export interface Progress { done: number; total: number }

export interface RunItemNode {
  id: string;
  title: string;
  description: string | null;
  position: number;
  isChecked: boolean;
  checkedAt: number | null;
  /** Fortschritt aller Unterpunkte (F-24: „x/y“ am Elternpunkt). */
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
  constructor(public code: "parent_not_found" | "section_not_found" | "cycle" | "too_deep") {
    super(code);
  }
}

export const loadSections = (db: Conn, runId: string): Section[] =>
  db.select().from(schema.runSections).where(eq(schema.runSections.runId, runId)).orderBy(schema.runSections.position, schema.runSections.id).all();

export function loadRunItems(db: Conn, runId: string): RunItem[] {
  const ids = loadSections(db, runId).map((s) => s.id);
  return ids.length ? db.select().from(schema.runItems).where(inArray(schema.runItems.sectionId, ids)).all() : [];
}

/** Zählt erledigte und alle Punkte (alle Ebenen). */
export const progressOf = (items: readonly { isChecked: boolean }[]): Progress => ({
  done: items.filter((i) => i.isChecked).length,
  total: items.length,
});

/** Baut je Abschnitt den verschachtelten Punktebaum inklusive Fortschritt. */
export function buildSections(sections: Section[], items: RunItem[]): SectionNode[] {
  const nodes = new Map<string, RunItemNode>(
    items.map((i) => [i.id, {
      id: i.id, title: i.title, description: i.description, position: i.position, isChecked: i.isChecked,
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
    const sum: Progress = { done: 0, total: 0 };
    for (const n of list) {
      const sub = finish(n.children);
      n.childProgress = sub;
      sum.done += sub.done + (n.isChecked ? 1 : 0);
      sum.total += sub.total + 1;
    }
    return sum;
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

// ---------- Abschnitte ----------
const renumberSections = (db: Conn, ids: string[]) =>
  ids.forEach((id, position) => db.update(schema.runSections).set({ position }).where(eq(schema.runSections.id, id)).run());

/** Kopiert eine Vorlage als neuen Abschnitt ans Ende der Durchführung (F-21, F-22): Momentaufnahme. */
export function appendSectionFromTemplate(db: Conn, runId: string, template: { id: string; title: string }): Section {
  const position = loadSections(db, runId).length;
  const [section] = db.insert(schema.runSections)
    .values({ runId, sourceTemplateId: template.id, title: template.title, position }).returning().all();
  const items = loadTemplateItems(db, template.id);
  const idMap = new Map(items.map((i) => [i.id, crypto.randomUUID()]));
  const visit = (parentId: string | null) => {
    for (const i of items.filter((x) => (x.parentItemId ?? null) === parentId)) {
      db.insert(schema.runItems).values({
        id: idMap.get(i.id)!, sectionId: section!.id, parentItemId: parentId ? idMap.get(parentId)! : null,
        title: i.title, description: i.description, position: i.position,
      }).run();
      visit(i.id);
    }
  };
  visit(null);
  return section!;
}

export function appendEmptySection(db: Conn, runId: string, title: string): Section {
  const position = loadSections(db, runId).length;
  return db.insert(schema.runSections).values({ runId, title, position }).returning().all()[0]!;
}

export function deleteSection(db: Db, section: Section) {
  db.transaction((tx) => {
    tx.delete(schema.runSections).where(eq(schema.runSections.id, section.id)).run();
    renumberSections(tx, loadSections(tx, section.runId).map((s) => s.id));
  });
}

export function moveSection(db: Db, section: Section, position: number) {
  db.transaction((tx) => {
    const ids = loadSections(tx, section.runId).map((s) => s.id).filter((id) => id !== section.id);
    ids.splice(Math.min(Math.max(position, 0), ids.length), 0, section.id);
    renumberSections(tx, ids);
  });
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

export function addRunItem(
  db: Db, section: Section,
  input: { title: string; description?: string | null; parentItemId?: string | null; position?: number },
): RunItem {
  return db.transaction((tx) => {
    const items = loadRunItems(tx, section.runId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const parentId = input.parentItemId ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parentId && (!parent || parent.sectionId !== section.id)) throw new RunItemError("parent_not_found");
    if (depthOf(byId, parentId) + 1 > MAX_DEPTH) throw new RunItemError("too_deep");
    const siblings = siblingIds(tx, section.id, parentId);
    const index = Math.min(Math.max(input.position ?? siblings.length, 0), siblings.length);
    const [item] = tx.insert(schema.runItems)
      .values({ sectionId: section.id, parentItemId: parentId, title: input.title, description: input.description ?? null, position: index }).returning().all();
    siblings.splice(index, 0, item!.id);
    renumber(tx, siblings);
    return { ...item!, position: index };
  });
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
  });
}

export function deleteRunItem(db: Db, item: RunItem) {
  db.transaction((tx) => {
    tx.delete(schema.runItems).where(eq(schema.runItems.id, item.id)).run();
    renumber(tx, siblingIds(tx, item.sectionId, item.parentItemId));
  });
}

/** Ändert Titel/Beschreibung und hakt ab bzw. nimmt zurück (F-24); der Zeitstempel ändert sich nur bei echtem Zustandswechsel. */
export function updateRunItem(
  db: Db, item: RunItem,
  patch: { title?: string; description?: string | null; isChecked?: boolean },
) {
  const checkedChanged = patch.isChecked !== undefined && patch.isChecked !== item.isChecked;
  db.update(schema.runItems).set({
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.isChecked !== undefined && { isChecked: patch.isChecked }),
    ...(checkedChanged && { checkedAt: patch.isChecked ? Date.now() : null }),
  }).where(eq(schema.runItems.id, item.id)).run();
}
