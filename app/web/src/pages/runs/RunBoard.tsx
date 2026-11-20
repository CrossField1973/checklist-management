import {
  DndContext, DragOverlay, MeasuringStrategy, closestCenter,
  type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Progress, RunItemNode, RunSection } from "../../api/types";
import { Button, Dialog } from "../../components/ui";
import {
  countNodes, descendantIds, findNode, getBoardProjection, indentTarget, isSamePlace, moveDownTarget, moveUpTarget, outdentTarget,
  treeGuides, type BoardRow, type BoardTarget, type MoveTarget, type TreeGuide,
} from "../../lib/tree";
import {
  CountToggle, DragPreview, DropLine, GripIcon, PlusIcon, INDENT, RowMenu, TreeGuides, dragStartFeedback, rowStyle, splitListeners, swallowNextClick, useTreeSensors, type MenuEntry,
} from "../../components/tree";

export interface BoardActions {
  onCheck: (item: RunItemNode, checked: boolean) => Promise<void>;
  onAdd: (sectionId: string, title: string, parentItemId: string | null) => Promise<void>;
  onDelete: (item: RunItemNode) => Promise<void>;
  /** Punkt verschieben: Ziehen (Ebene per horizontaler Bewegung) und Pfeil-Schaltflächen. */
  onMoveItem?: (item: RunItemNode, target: BoardTarget) => Promise<void>;
}

export function ProgressBar({ progress, label }: { progress: Progress; label: string }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-border">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm tabular-nums text-muted">{progress.done}/{progress.total}</span>
    </div>
  );
}

function AddForm({ label, onAdd, onClose, autoFocus }: { label: string; onAdd: (title: string) => Promise<void>; onClose?: () => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try { await onAdd(title); setValue(""); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex gap-2" noValidate>
      <input className="input min-w-0 flex-1" aria-label={label} placeholder={t("runs.addPlaceholder")} value={value} maxLength={200} autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && onClose) { e.preventDefault(); onClose(); } }} />
      <Button type="submit" variant={value.trim() ? "primary" : undefined} disabled={busy || !value.trim()}>{t("common.add")}</Button>
      {onClose && <Button onClick={onClose}>{t("common.cancel")}</Button>}
    </form>
  );
}

const isDone = (i: RunItemNode): boolean => i.isChecked && i.children.every(isDone);

/** Zeile der abgeflachten Liste eines Abschnitts (Eltern vor Kindern, Tiefe als Einrückung). */
interface Row extends BoardRow { node?: RunItemNode }
function flattenItems(items: RunItemNode[], sectionId: string, hideDone: boolean, collapsed: ReadonlySet<string>, parentId: string | null = null, depth = 0): Row[] {
  return items.filter((i) => !(hideDone && isDone(i))).flatMap((node) => [
    { id: node.id, sectionId, parentId, depth, isEnd: false, node, childCount: node.children.length },
    ...(collapsed.has(node.id) ? [] : flattenItems(node.children, sectionId, hideDone, collapsed, node.id, depth + 1)),
  ]);
}

interface RowProps {
  node: RunItemNode;
  depth: number;
  guide: TreeGuide;
  sectionId: string;
  sectionItems: RunItemNode[];
  readOnly: boolean;
  draggable: boolean;
  isDragging: boolean;
  adding: boolean;
  isCollapsed: boolean;
  actions: BoardActions;
  onToggleCollapse: () => void;
  onToggleAdd: () => void;
  onAskDelete: (i: RunItemNode) => void;
}

/**
 * Inhalt einer Zeile (wie Todoist): Griff links im Rand und ＋/⋯ rechts erscheinen beim Darüberfahren; auf Touch-Geräten nur „⋯“,
 * gezogen wird dort per langem Druck. Verschieben ohne Ziehen über das Menü (WCAG 2.5.7), Ein-/Ausrücken nur am Desktop.
 */
function RowBody({ node, sectionId, sectionItems, readOnly, draggable, adding, isCollapsed, actions, onToggleCollapse, onToggleAdd, onAskDelete, handle }: RowProps & { handle?: React.ReactNode }) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const pending = node.id.startsWith("tmp-"); // offline angelegt, noch nicht übertragen (F-74)
  const canMove = draggable && !pending && !!actions.onMoveItem;
  const move = (target: MoveTarget | null) => { if (target) void actions.onMoveItem?.(node, { sectionId, ...target }); };
  const title = node.title;
  const moves: MenuEntry[] = canMove ? [
    { label: t("items.upShort"), ariaLabel: t("items.up", { title }), target: moveUpTarget(sectionItems, node.id) },
    { label: t("items.downShort"), ariaLabel: t("items.down", { title }), target: moveDownTarget(sectionItems, node.id) },
    { label: t("items.indentShort"), ariaLabel: t("items.indent", { title }), target: indentTarget(sectionItems, node.id), desktopOnly: true },
    { label: t("items.outdentShort"), ariaLabel: t("items.outdent", { title }), target: outdentTarget(sectionItems, node.id), desktopOnly: true },
  ].map(({ target, ...e }) => ({ ...e, disabled: !target, onSelect: () => move(target) })) : [];
  const menu: MenuEntry[] = [
    ...moves,
    { label: t("runs.addChildShort"), ariaLabel: t("runs.addChild", { title }), onSelect: onToggleAdd },
    { label: t("common.delete"), ariaLabel: t("runs.deleteItem", { title }), onSelect: () => onAskDelete(node), danger: true },
  ];
  return (
    <div className="row relative flex flex-wrap items-center gap-x-1 px-1 py-0.5">
      {handle}
      <div className="flex min-h-10 min-w-0 flex-[1_1_12rem] items-center gap-1">
        <label className={`flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md py-1 pr-1 ${readOnly || pending ? "" : "cursor-pointer"}`}>
          <input
            type="checkbox" className="h-6 w-6 shrink-0" checked={node.isChecked} disabled={readOnly || pending}
            id={`chk-${node.id}`} onChange={(e) => void actions.onCheck(node, e.target.checked)}
          />
          <span className={`min-w-0 font-medium hyphens-auto [overflow-wrap:anywhere] ${node.isChecked ? "text-muted line-through" : ""}`}>{title}</span>
        </label>
        {pending && <span className="badge">{t("offline.waiting")}</span>}
        {hasChildren && (
          <CountToggle
            count={`${node.childProgress.done}/${node.childProgress.total}`} description={t("runs.subProgress", { done: node.childProgress.done, total: node.childProgress.total })}
            collapsed={isCollapsed} title={title} onToggle={onToggleCollapse} t={t}
          />
        )}
      </div>
      {!readOnly && !pending && (
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className="icon-btn row-actions touch-hide" aria-expanded={adding} onClick={onToggleAdd} aria-label={t("runs.addChild", { title })} title={t("runs.addChildShort")}><PlusIcon /></button>
          <RowMenu title={title} entries={menu} t={t} />
        </div>
      )}
    </div>
  );
}

function StaticRow(props: RowProps) {
  return (
    <li className="relative" style={rowStyle(props.depth)} data-testid={`item-${props.node.id}`}>
      <TreeGuides depth={props.depth} {...props.guide} />
      <RowBody {...props} />
    </li>
  );
}

function SortableRow(props: RowProps) {
  const { t } = useTranslation();
  const pending = props.node.id.startsWith("tmp-");
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: props.node.id, disabled: pending });
  const split = splitListeners(listeners);
  const handle = pending ? null : (
    <button
      ref={setActivatorNodeRef} type="button" {...attributes} {...split.handle}
      aria-label={t("items.dragHandle", { title: props.node.title })} title={t("items.dragHint")}
      className="icon-btn drag-handle row-actions"
    ><GripIcon /></button>
  );
  return (
    <li
      ref={setNodeRef} data-testid={`item-${props.node.id}`} {...split.row}
      style={{ transform: CSS.Translate.toString(transform), transition, ...rowStyle(props.depth) }}
      className="relative"
    >
      {props.isDragging ? <DropLine /> : (
        <>
          <TreeGuides depth={props.depth} {...props.guide} />
          <RowBody {...props} handle={handle} />
        </>
      )}
    </li>
  );
}

/** Ablageziel am Ende eines Abschnitts (auch für leere Abschnitte). */
function EndRow({ id, dragging, empty }: { id: string; dragging: boolean; empty: boolean }) {
  const { t } = useTranslation();
  const { setNodeRef, transform, transition } = useSortable({ id });
  return (
    <li
      ref={setNodeRef} aria-hidden="true" style={{ transform: CSS.Translate.toString(transform), transition }}
      className={dragging ? `my-1 rounded-lg border border-dashed border-border text-center text-sm text-muted ${empty ? "py-3" : "py-1"}` : "h-0"}
    >{dragging ? t("runs.dropHere") : null}</li>
  );
}

/** Abschnitte mit ihren Punkten (F-23 bis F-25). Wird von der eigenen Ansicht und der Freigabe-Ansicht genutzt; `readOnly` sperrt alles. */
export function RunBoard({ sections, readOnly, hideDone = false, actions }: { sections: RunSection[]; readOnly: boolean; hideDone?: boolean; actions: BoardActions }) {
  const { t } = useTranslation();
  const [toDelete, setToDelete] = useState<RunItemNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleCollapse = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // Ziehen nur, wenn alle Punkte sichtbar sind (ausgeblendete Erledigte würden die Zielposition verfälschen)
  const draggable = !readOnly && !!actions.onMoveItem && !hideDone;
  const sensors = useTreeSensors();

  const rows: Row[] = useMemo(() => sections.flatMap((s) => [
    ...flattenItems(s.items, s.id, hideDone, collapsed),
    ...(draggable ? [{ id: `end-${s.id}`, sectionId: s.id, parentId: null, depth: 0, isEnd: true } as Row] : []),
  ]), [sections, hideDone, draggable, collapsed]);

  const findItem = (id: string | null) => { for (const s of sections) { const n = id ? findNode(s.items, id) : null; if (n) return n as RunItemNode; } return null; };
  const descendants = useMemo(() => new Set(activeId ? descendantIds(findItem(activeId) ?? { children: [] } as never) : []), [activeId, sections]); // eslint-disable-line react-hooks/exhaustive-deps
  const projection = activeId && overId ? getBoardProjection(rows, activeId, overId, offsetX, INDENT, descendants, collapsed) : null;
  const reset = () => { setActiveId(null); setOverId(null); setOffsetX(0); swallowNextClick(); };
  const titleOf = (id: unknown) => findItem(String(id))?.title ?? "";

  function dragEnd(e: DragEndEvent) {
    const id = activeId;
    const proj = e.over && id ? getBoardProjection(rows, id, String(e.over.id), offsetX, INDENT, descendants, collapsed) : null;
    reset();
    const node = findItem(id);
    if (!proj || !node || !id) return;
    const target: BoardTarget = { sectionId: proj.sectionId, parentItemId: proj.parentId, position: proj.position };
    const home = sections.find((s) => findNode(s.items, id));
    if (home && home.id === target.sectionId && isSamePlace(home.items, id, target)) return;
    void actions.onMoveItem?.(node, target);
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      if (toDelete) await actions.onDelete(toDelete);
    } finally { setBusy(false); setToDelete(null); }
  }

  const renderSection = (s: RunSection) => {
    const sectionRows = rows.filter((r) => r.sectionId === s.id);
    const visibleRows = activeId ? sectionRows.filter((r) => !descendants.has(r.id)) : sectionRows; // Unterpunkte wandern beim Ziehen mit
    const guides = treeGuides(visibleRows.filter((r) => !r.isEnd).map((r) => r.depth));
    return (
      <section key={s.id} className="card" aria-label={t("runs.itemsLabel")}>
        <ul className="m-0 list-none p-0" aria-label={t("runs.itemsLabel")}>
          {visibleRows.map((r, i) => {
            if (r.isEnd) return <EndRow key={r.id} id={r.id} dragging={activeId !== null} empty={s.items.length === 0} />;
            const common: RowProps = {
              node: r.node!, depth: r.id === activeId && projection ? projection.depth : r.depth, guide: guides[i]!,
              sectionId: s.id, sectionItems: s.items,
              readOnly, draggable, isDragging: r.id === activeId, adding: addingUnder === r.id, isCollapsed: collapsed.has(r.id), actions,
              onToggleCollapse: () => toggleCollapse(r.id),
              onToggleAdd: () => { setAddingUnder((cur) => (cur === r.id ? null : r.id)); if (collapsed.has(r.id)) toggleCollapse(r.id); }, // neuer Unterpunkt soll sichtbar sein
              onAskDelete: setToDelete,
            };
            return (
              <FragmentRow key={r.id}>
                {draggable ? <SortableRow {...common} /> : <StaticRow {...common} />}
                {addingUnder === r.id && !readOnly && (
                  <li className="relative py-1" style={rowStyle(r.depth + 1)}>
                    <TreeGuides depth={r.depth + 1} guides={r.depth > 0 ? [...guides[i]!.guides, !guides[i]!.last] : []} last={r.node!.children.length === 0 || collapsed.has(r.id)} />
                    <AddForm label={t("runs.addChildLabel", { title: r.node!.title })} autoFocus onClose={() => setAddingUnder(null)} onAdd={(title) => actions.onAdd(s.id, title, r.id)} />
                  </li>
                )}
              </FragmentRow>
            );
          })}
        </ul>
        {s.items.length === 0 && <p className="hint">{t("runs.emptySection")}</p>}
        {hideDone && s.items.length > 0 && s.items.every(isDone) && <p className="hint">{t("runs.allHidden")}</p>}
        {!readOnly && <div className="mt-3"><AddForm label={t("runs.addLabel")} onAdd={(title) => actions.onAdd(s.id, title, null)} /></div>}
      </section>
    );
  };

  const body = (
    <div className="grid gap-4">
      {sections.length === 0 && <p className="hint">{t("runs.noSections")}</p>}
      {sections.map(renderSection)}
    </div>
  );

  return (
    <div>
      {draggable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={(e: DragStartEvent) => { setActiveId(String(e.active.id)); setOverId(String(e.active.id)); dragStartFeedback(e.activatorEvent); }}
          onDragMove={(e: DragMoveEvent) => setOffsetX(e.delta.x)}
          onDragOver={(e: DragOverEvent) => setOverId(e.over ? String(e.over.id) : null)}
          onDragEnd={dragEnd}
          onDragCancel={reset}
          accessibility={{
            screenReaderInstructions: { draggable: t("runs.a11y.instructions") },
            announcements: {
              onDragStart: ({ active }) => t("items.a11y.start", { title: titleOf(active.id) }),
              onDragOver: ({ active, over }) => (over ? t("items.a11y.over", { title: titleOf(active.id), target: titleOf(over.id) || t("runs.sectionEnd") }) : undefined),
              onDragEnd: ({ active }) => t("items.a11y.end", { title: titleOf(active.id) }),
              onDragCancel: ({ active }) => t("items.a11y.cancel", { title: titleOf(active.id) }),
            },
          }}
        >
          <SortableContext items={rows.filter((r) => !descendants.has(r.id)).map((r) => r.id)} strategy={verticalListSortingStrategy}>{body}</SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeId && <DragPreview title={titleOf(activeId)} childCount={descendants.size} checkbox />}
          </DragOverlay>
        </DndContext>
      ) : body}

      <Dialog
        open={toDelete !== null} onClose={() => setToDelete(null)}
        title={t("runs.deleteItemTitle")}
        footer={<><Button onClick={() => setToDelete(null)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>{t("common.delete")}</Button></>}
      >
        <p className="m-0">{toDelete ? t("runs.deleteItemText", { title: toDelete.title, count: countNodes(toDelete.children) }) : ""}</p>
      </Dialog>
    </div>
  );
}

/** Gruppiert eine Zeile mit ihrem Eingabefeld für Unterpunkte, ohne zusätzliches Element im DOM. */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
