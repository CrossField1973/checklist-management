/**
 * Reine Funktionen für den Punktebaum einer Vorlage. Die Semantik entspricht der des Servers
 * (`POST /template-items/:id/move`): Der Punkt wird samt Unterpunkten entnommen und als Kind von `parentId`
 * (null = oberste Ebene) an Position `position` unter den dortigen Geschwistern eingefügt (ohne den Punkt selbst gezählt).
 */

import { newId } from "./id";

export interface ItemNode {
  id: string;
  title: string;
  description: string | null;
  position: number;
  children: ItemNode[];
}

export interface FlatItem {
  id: string;
  parentId: string | null;
  depth: number;
  /** Index unter den Geschwistern */
  index: number;
  node: ItemNode;
}

export interface MoveTarget { parentItemId: string | null; position: number }

/** Pre-Order-Liste aller sichtbaren Punkte; Nachfahren eingeklappter Punkte fehlen. */
export function flatten(tree: ItemNode[], collapsed: ReadonlySet<string> = new Set(), parentId: string | null = null, depth = 0): FlatItem[] {
  return tree.flatMap((node, index) => [
    { id: node.id, parentId, depth, index, node },
    ...(collapsed.has(node.id) ? [] : flatten(node.children, collapsed, node.id, depth + 1)),
  ]);
}

export function findNode(tree: ItemNode[], id: string): ItemNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const inner = findNode(n.children, id);
    if (inner) return inner;
  }
  return null;
}

/** Elternpunkt-ID (null = oberste Ebene) oder `undefined`, wenn der Punkt nicht existiert. */
export function findParentId(tree: ItemNode[], id: string, parentId: string | null = null): string | null | undefined {
  for (const n of tree) {
    if (n.id === id) return parentId;
    const inner = findParentId(n.children, id, n.id);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** IDs aller Nachfahren (ohne den Punkt selbst). */
export function descendantIds(node: ItemNode): string[] {
  return node.children.flatMap((c) => [c.id, ...descendantIds(c)]);
}

export const countNodes = (tree: ItemNode[]): number => tree.reduce((n, c) => n + 1 + countNodes(c.children), 0);

const siblingsOf = (tree: ItemNode[], parentId: string | null): ItemNode[] | null =>
  parentId === null ? tree : findNode(tree, parentId)?.children ?? null;

/**
 * Verschiebt einen Punkt im Baum (unveränderlich). Gibt `null` zurück, wenn der Punkt oder der Elternpunkt fehlt
 * oder das Ziel in den eigenen Unterpunkten läge (Zyklus). Positionen werden wie beim Server auf die Länge begrenzt.
 */
export function moveInTree(tree: ItemNode[], id: string, parentId: string | null, position: number): ItemNode[] | null {
  const moving = findNode(tree, id);
  if (!moving) return null;
  if (parentId !== null && (parentId === id || descendantIds(moving).includes(parentId) || !findNode(tree, parentId))) return null;

  // Entnehmen und die Geschwister des alten Orts lückenlos neu nummerieren (wie der Server)
  const without = (nodes: ItemNode[]): ItemNode[] => renumber(nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: without(n.children) })));
  const stripped = without(tree);
  if (parentId !== null) return insertUnder(stripped, parentId, moving, position);
  const list = [...stripped];
  list.splice(Math.min(Math.max(position, 0), list.length), 0, moving);
  return renumber(list);
}

function insertUnder(nodes: ItemNode[], parentId: string, moving: ItemNode, position: number): ItemNode[] {
  return nodes.map((n) => {
    if (n.id === parentId) {
      const list = [...n.children];
      list.splice(Math.min(Math.max(position, 0), list.length), 0, moving);
      return { ...n, children: renumber(list) };
    }
    return { ...n, children: insertUnder(n.children, parentId, moving, position) };
  });
}

const renumber = (list: ItemNode[]): ItemNode[] => list.map((n, i) => (n.position === i ? n : { ...n, position: i }));

// ---------- Schaltflächen als Alternative zum Ziehen (WCAG 2.5.7) ----------

interface Place { siblings: ItemNode[]; index: number; parentId: string | null }
function placeOf(tree: ItemNode[], id: string): Place | null {
  const parentId = findParentId(tree, id);
  if (parentId === undefined) return null;
  const siblings = siblingsOf(tree, parentId)!;
  return { siblings, index: siblings.findIndex((n) => n.id === id), parentId };
}

export function moveUpTarget(tree: ItemNode[], id: string): MoveTarget | null {
  const p = placeOf(tree, id);
  return p && p.index > 0 ? { parentItemId: p.parentId, position: p.index - 1 } : null;
}

export function moveDownTarget(tree: ItemNode[], id: string): MoveTarget | null {
  const p = placeOf(tree, id);
  return p && p.index < p.siblings.length - 1 ? { parentItemId: p.parentId, position: p.index + 1 } : null;
}

/** Einrücken: wird letzter Unterpunkt des vorherigen Geschwisterpunkts. */
export function indentTarget(tree: ItemNode[], id: string): MoveTarget | null {
  const p = placeOf(tree, id);
  if (!p || p.index === 0) return null;
  const previous = p.siblings[p.index - 1]!;
  return { parentItemId: previous.id, position: previous.children.length };
}

/** Ausrücken: wird Geschwisterpunkt direkt nach dem bisherigen Elternpunkt. */
export function outdentTarget(tree: ItemNode[], id: string): MoveTarget | null {
  const p = placeOf(tree, id);
  if (!p || p.parentId === null) return null;
  const grand = placeOf(tree, p.parentId)!;
  return { parentItemId: grand.parentId, position: grand.index + 1 };
}

// ---------- Ziehen: Ziel aus Mausposition ableiten (nach dem Muster des dnd-kit-Baumbeispiels) ----------

export interface Projection { depth: number; parentId: string | null; position: number }

const arrayMove = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const copy = [...list];
  copy.splice(to, 0, copy.splice(from, 1)[0]!);
  return copy;
};

/**
 * Berechnet, wohin ein gezogener Punkt fiele: Index der Zielzeile plus horizontale Verschiebung (`offsetX` in Pixel)
 * bestimmen die Ebene. `flat` ist die sichtbare Liste; Nachfahren des gezogenen Punkts werden währenddessen ausgeblendet.
 * Gibt `null` zurück, wenn das Ziel unbekannt ist.
 */
export function getProjection(flat: readonly FlatItem[], activeId: string, overId: string, offsetX: number, indentWidth: number, collapsed: ReadonlySet<string> = new Set()): Projection | null {
  const active = flat.find((i) => i.id === activeId);
  if (!active) return null;
  const hidden = new Set(descendantIds(active.node));
  const visible = flat.filter((i) => !hidden.has(i.id));
  const activeIndex = visible.findIndex((i) => i.id === activeId);
  const overIndex = visible.findIndex((i) => i.id === overId);
  if (activeIndex < 0 || overIndex < 0) return null;

  const items = arrayMove(visible, activeIndex, overIndex);
  const previous = items[overIndex - 1];
  const next = items[overIndex + 1];
  const dragDepth = Math.round(offsetX / indentWidth);
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.min(Math.max(active.depth + dragDepth, minDepth), Math.max(maxDepth, minDepth));

  let parentId: string | null = null;
  if (depth > 0 && previous) {
    if (depth === previous.depth) parentId = previous.parentId;
    else if (depth > previous.depth) parentId = previous.id;
    else parentId = items.slice(0, overIndex).reverse().find((i) => i.depth === depth)?.parentId ?? null;
  }

  // Position: Geschwister mit gleichem Elternpunkt vor der Zielzeile; unter einem eingeklappten Elternpunkt wird angehängt
  let position = items.slice(0, overIndex).filter((i) => i.parentId === parentId && i.depth === depth).length;
  if (parentId !== null && previous?.id === parentId && collapsed.has(parentId)) {
    position = previous.node.children.filter((c) => c.id !== activeId).length;
  }
  return { depth, parentId, position };
}

/** Prüft, ob das Ziel dem aktuellen Ort entspricht (dann ist kein Serveraufruf nötig). */
export function isSamePlace(tree: ItemNode[], id: string, target: MoveTarget): boolean {
  const p = placeOf(tree, id);
  return !!p && p.parentId === target.parentItemId && p.index === Math.min(target.position, p.siblings.length - 1);
}

// ---------- Lokaler Entwurf: Bearbeiten ohne Serveraufruf (Speichern überträgt den ganzen Baum) ----------

/** Fügt einen Punkt mit vorläufiger ID ans Ende der Geschwister von `parentId` an (null = oberste Ebene). */
export function addToTree(tree: ItemNode[], title: string, parentId: string | null): ItemNode[] {
  const node: ItemNode = { id: `tmp-${newId()}`, title, description: null, position: 0, children: [] };
  return parentId === null ? renumber([...tree, node]) : addChild(tree, node, parentId);
}

function addChild(nodes: ItemNode[], node: ItemNode, parentId: string): ItemNode[] {
  return nodes.map((n) => (n.id === parentId ? { ...n, children: renumber([...n.children, node]) } : { ...n, children: addChild(n.children, node, parentId) }));
}

export function updateInTree(tree: ItemNode[], id: string, patch: { title: string; description: string | null }): ItemNode[] {
  return tree.map((n) => (n.id === id ? { ...n, ...patch } : { ...n, children: updateInTree(n.children, id, patch) }));
}

export function removeFromTree(tree: ItemNode[], id: string): ItemNode[] {
  return renumber(tree.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeFromTree(n.children, id) })));
}

export interface ItemInput { title: string; description?: string | null; children?: ItemInput[] }

/** Baum in die Form für `POST/PUT /templates` (ohne IDs; die Reihenfolge ergibt die Positionen). */
export function toInput(tree: ItemNode[]): ItemInput[] {
  return tree.map((n) => ({ title: n.title, description: n.description, ...(n.children.length ? { children: toInput(n.children) } : {}) }));
}

// ---------- Mehrere Abschnitte (Checklisten): Ziehen über Abschnittsgrenzen ----------

export interface BoardTarget { sectionId: string; parentItemId: string | null; position: number }

/**
 * Verschiebt einen Punkt samt Unterpunkten innerhalb oder zwischen Abschnitten (unveränderlich; Semantik wie
 * `POST /run-items/:id/move`). Gibt `null` zurück, wenn Punkt, Abschnitt oder Elternpunkt fehlen oder ein Zyklus entstünde.
 * Fortschrittszähler werden nicht angepasst – die Antwort des Servers ersetzt den Zwischenstand.
 */
export function moveBetweenSections<N extends ItemNode, S extends { id: string; items: N[] }>(sections: S[], id: string, target: BoardTarget): S[] | null {
  const from = sections.find((s) => findNode(s.items, id));
  const to = sections.find((s) => s.id === target.sectionId);
  if (!from || !to) return null;
  if (from.id === to.id) {
    const moved = moveInTree(from.items, id, target.parentItemId, target.position);
    return moved ? sections.map((s) => (s.id === from.id ? { ...s, items: moved as N[] } : s)) : null;
  }
  const node = findNode(from.items, id) as N;
  if (target.parentItemId !== null && !findNode(to.items, target.parentItemId)) return null;
  const rest = removeFromTree(from.items, id) as N[];
  let inserted: N[];
  if (target.parentItemId === null) {
    const list = [...to.items];
    list.splice(Math.min(Math.max(target.position, 0), list.length), 0, node);
    inserted = renumber(list) as N[];
  } else {
    inserted = insertUnder(to.items, target.parentItemId, node, target.position) as N[];
  }
  return sections.map((s) => (s.id === from.id ? { ...s, items: rest } : s.id === to.id ? { ...s, items: inserted } : s));
}

export interface BoardRow { id: string; sectionId: string; parentId: string | null; depth: number; isEnd: boolean }
export interface BoardProjection { sectionId: string; depth: number; parentId: string | null; position: number }

/**
 * Wohin fiele ein gezogener Punkt auf einer Seite mit mehreren Abschnitten? `rows` ist die sichtbare Reihenfolge aller Abschnitte;
 * je Abschnitt steht am Ende eine Zeile `isEnd` (Ablageziel für „ans Ende“ und für leere Abschnitte). Der Zielabschnitt ist
 * der der Zeile unter dem Zeiger; die Ebene folgt wie beim Punktebaum der horizontalen Bewegung (`offsetX` in Pixel).
 * `descendants` sind die Unterpunkte des gezogenen Punkts (wandern mit).
 */
export function getBoardProjection(rows: readonly BoardRow[], activeId: string, overId: string, offsetX: number, indentWidth: number, descendants: ReadonlySet<string>): BoardProjection | null {
  const active = rows.find((r) => r.id === activeId && !r.isEnd);
  const overIndex = rows.findIndex((r) => r.id === overId);
  const activeIndex = rows.findIndex((r) => r.id === activeId);
  if (!active || overIndex < 0) return null;
  const over = rows[overIndex]!;
  const sectionId = over.sectionId;
  // Reihenfolge im Zielabschnitt ohne den gezogenen Punkt und ohne seine Unterpunkte
  const list = rows.filter((r) => r.sectionId === sectionId && !r.isEnd && r.id !== activeId && !descendants.has(r.id));
  const before = (limit: number) => list.filter((r) => rows.indexOf(r) < limit).length;
  let idx: number;
  if (over.isEnd) idx = list.length;
  else if (over.id === activeId) idx = before(activeIndex); // unverändert über sich selbst
  else {
    const k = list.findIndex((r) => r.id === over.id);
    idx = k < 0 ? before(overIndex) : k + (activeIndex < overIndex ? 1 : 0); // nach unten gezogen: hinter die Zielzeile, sonst davor
  }
  const previous = list[idx - 1];
  const next = list[idx];
  const dragDepth = Math.round(offsetX / indentWidth);
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.min(Math.max(active.depth + dragDepth, minDepth), Math.max(maxDepth, minDepth));

  let parentId: string | null = null;
  if (depth > 0 && previous) {
    if (depth === previous.depth) parentId = previous.parentId;
    else if (depth > previous.depth) parentId = previous.id;
    else parentId = list.slice(0, idx).reverse().find((r) => r.depth === depth)?.parentId ?? null;
  }
  const position = list.slice(0, idx).filter((r) => r.parentId === parentId && r.depth === depth).length;
  return { sectionId, depth, parentId, position };
}

interface Counted { isChecked: boolean; childProgress: { done: number; total: number }; children: Counted[] }

/**
 * Berechnet die Fortschrittszähler (je Unterpunkt-Gruppe, je Abschnitt und für die ganze Checkliste) neu –
 * gleiche Zählweise wie der Server (alle Ebenen). So stimmen „x/y“ auch im Zwischenstand vor der Antwort des Servers.
 */
export function withProgress<N extends Counted, S extends { progress: { done: number; total: number }; items: N[] }>(sections: S[]): { sections: S[]; progress: { done: number; total: number } } {
  const walk = (list: N[]): { nodes: N[]; done: number; total: number } => {
    let done = 0;
    let total = 0;
    const nodes = list.map((n) => {
      const sub = walk(n.children as N[]);
      done += sub.done + (n.isChecked ? 1 : 0);
      total += sub.total + 1;
      return { ...n, children: sub.nodes, childProgress: { done: sub.done, total: sub.total } };
    });
    return { nodes, done, total };
  };
  const out = sections.map((s) => {
    const r = walk(s.items);
    return { ...s, items: r.nodes, progress: { done: r.done, total: r.total } };
  });
  return { sections: out, progress: out.reduce((a, s) => ({ done: a.done + s.progress.done, total: a.total + s.progress.total }), { done: 0, total: 0 }) };
}
