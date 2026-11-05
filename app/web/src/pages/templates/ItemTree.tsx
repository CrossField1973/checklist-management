import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragCancelEvent, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  descendantIds, findNode, flatten, getProjection, indentTarget, isSamePlace, moveDownTarget, moveUpTarget, outdentTarget,
  type FlatItem, type ItemNode, type MoveTarget,
} from "../../lib/tree";

const INDENT = 28; // Pixel je Ebene (Einrückung und Maß für die horizontale Ziehbewegung)

interface Actions {
  onAdd: (title: string, parentId: string | null) => Promise<void>;
  onEdit: (node: ItemNode) => void;
  onDelete: (node: ItemNode) => void;
  onMove: (id: string, target: MoveTarget) => Promise<void>;
}

/** Eingabefeld zum schnellen Anlegen: Enter fügt hinzu und behält den Fokus für den nächsten Punkt. */
function QuickAdd({ label, placeholder, onAdd, onClose, autoFocus }: { label: string; placeholder: string; onAdd: (title: string) => Promise<void>; onClose?: () => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onAdd(title);
      setValue("");
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2" noValidate>
      <input
        ref={input} className="input min-w-0 flex-1" aria-label={label} placeholder={placeholder} value={value} maxLength={200} autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && onClose) { e.preventDefault(); onClose(); } }}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>{t("common.add")}</button>
      {onClose && <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>}
    </form>
  );
}

interface RowProps extends Actions {
  item: FlatItem;
  depth: number;
  tree: ItemNode[];
  isCollapsed: boolean;
  isDragging: boolean;
  addingHere: boolean;
  onToggle: () => void;
  onToggleAdd: () => void;
}

function Row({ item, depth, tree, isCollapsed, isDragging, addingHere, onToggle, onToggleAdd, onAdd, onEdit, onDelete, onMove }: RowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: item.id });
  const node = item.node;
  const hasChildren = node.children.length > 0;
  const up = moveUpTarget(tree, node.id);
  const down = moveDownTarget(tree, node.id);
  const indent = indentTarget(tree, node.id);
  const outdent = outdentTarget(tree, node.id);

  const iconBtn = "btn btn-sm px-2";
  return (
    <>
      <li
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition, marginLeft: depth * INDENT }}
        className={`rounded-lg border border-border bg-surface ${isDragging ? "opacity-60 ring-2 ring-primary" : ""}`}
        data-testid={`item-${node.id}`}
      >
        <div className="flex flex-wrap items-center gap-2 p-2">
          <button
            ref={setActivatorNodeRef} type="button" {...attributes} {...listeners}
            aria-label={t("items.dragHandle", { title: node.title })}
            title={t("items.dragHint")}
            className="btn btn-sm cursor-grab touch-none px-2"
          >⋮⋮</button>
          {hasChildren ? (
            <button type="button" className={iconBtn} aria-expanded={!isCollapsed} aria-label={t(isCollapsed ? "items.expand" : "items.collapse", { title: node.title })} onClick={onToggle}>{isCollapsed ? "▸" : "▾"}</button>
          ) : <span className="inline-block w-9" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <p className="m-0 break-words font-medium">{node.title}{hasChildren && isCollapsed && <span className="badge ml-2">{t("items.hidden", { count: node.children.length })}</span>}</p>
            {node.description && <p className="hint m-0 whitespace-pre-wrap break-words">{node.description}</p>}
          </div>
          <div role="group" aria-label={t("items.actionsFor", { title: node.title })} className="flex flex-wrap gap-1">
            <button type="button" className={iconBtn} disabled={!up} onClick={() => up && void onMove(node.id, up)} aria-label={t("items.up", { title: node.title })} title={t("items.upShort")}>↑</button>
            <button type="button" className={iconBtn} disabled={!down} onClick={() => down && void onMove(node.id, down)} aria-label={t("items.down", { title: node.title })} title={t("items.downShort")}>↓</button>
            <button type="button" className={iconBtn} disabled={!outdent} onClick={() => outdent && void onMove(node.id, outdent)} aria-label={t("items.outdent", { title: node.title })} title={t("items.outdentShort")}>←</button>
            <button type="button" className={iconBtn} disabled={!indent} onClick={() => indent && void onMove(node.id, indent)} aria-label={t("items.indent", { title: node.title })} title={t("items.indentShort")}>→</button>
            <button type="button" className={iconBtn} aria-expanded={addingHere} onClick={onToggleAdd} aria-label={t("items.addChild", { title: node.title })} title={t("items.addChildShort")}>＋</button>
            <button type="button" className={iconBtn} onClick={() => onEdit(node)} aria-label={t("items.edit", { title: node.title })} title={t("common.edit")}>✎</button>
            <button type="button" className={`${iconBtn} btn-danger`} onClick={() => onDelete(node)} aria-label={t("items.delete", { title: node.title })} title={t("common.delete")}>🗑</button>
          </div>
        </div>
      </li>
      {addingHere && (
        <li style={{ marginLeft: (depth + 1) * INDENT }}>
          <QuickAdd label={t("items.addChildLabel", { title: node.title })} placeholder={t("items.addChildPlaceholder")} autoFocus onClose={onToggleAdd} onAdd={(title) => onAdd(title, node.id)} />
        </li>
      )}
    </>
  );
}

/**
 * Punktebaum einer Vorlage (F-13, F-14): Ziehen mit Maus/Touch/Tastatur (dnd-kit) – horizontale Bewegung ändert die Ebene –
 * und als gleichwertige Alternative Schaltflächen für Hoch, Runter, Ein- und Ausrücken (WCAG 2.5.7).
 */
export function ItemTree({ items, onAdd, onEdit, onDelete, onMove }: { items: ItemNode[] } & Actions) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), // kurze Klicks auf den Griff starten kein Ziehen
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const flat = useMemo(() => {
    const all = flatten(items, collapsed);
    if (!activeId) return all;
    const active = findNode(items, activeId);
    const hidden = new Set(active ? descendantIds(active) : []);
    return all.filter((i) => !hidden.has(i.id)); // Unterpunkte wandern beim Ziehen mit und sind ausgeblendet
  }, [items, collapsed, activeId]);

  const projection = activeId && overId ? getProjection(flatten(items, collapsed), activeId, overId, offsetX, INDENT, collapsed) : null;
  const title = (id: unknown) => findNode(items, String(id))?.title ?? "";
  const reset = () => { setActiveId(null); setOverId(null); setOffsetX(0); };

  function dragEnd(e: DragEndEvent) {
    const proj = e.over && activeId ? getProjection(flatten(items, collapsed), activeId, String(e.over.id), offsetX, INDENT, collapsed) : null;
    const id = activeId;
    reset();
    if (!proj || !id) return;
    const target: MoveTarget = { parentItemId: proj.parentId, position: proj.position };
    if (!isSamePlace(items, id, target)) void onMove(id, target);
  }

  const toggle = (id: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) => { setActiveId(String(e.active.id)); setOverId(String(e.active.id)); }}
        onDragMove={(e: DragMoveEvent) => setOffsetX(e.delta.x)}
        onDragOver={(e: DragOverEvent) => setOverId(e.over ? String(e.over.id) : null)}
        onDragEnd={dragEnd}
        onDragCancel={(_: DragCancelEvent) => reset()}
        accessibility={{
          screenReaderInstructions: { draggable: t("items.a11y.instructions") },
          announcements: {
            onDragStart: ({ active }) => t("items.a11y.start", { title: title(active.id) }),
            onDragOver: ({ active, over }) => (over ? t("items.a11y.over", { title: title(active.id), target: title(over.id) }) : undefined),
            onDragEnd: ({ active }) => t("items.a11y.end", { title: title(active.id) }),
            onDragCancel: ({ active }) => t("items.a11y.cancel", { title: title(active.id) }),
          },
        }}
      >
        <SortableContext items={flat.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="m-0 grid list-none gap-2 p-0" aria-label={t("items.listLabel")}>
            {flat.map((item) => (
              <Row
                key={item.id}
                item={item}
                depth={item.id === activeId && projection ? projection.depth : item.depth}
                tree={items}
                isCollapsed={collapsed.has(item.id)}
                isDragging={item.id === activeId}
                addingHere={addingUnder === item.id}
                onToggle={() => toggle(item.id)}
                onToggleAdd={() => setAddingUnder((cur) => (cur === item.id ? null : item.id))}
                onAdd={async (title, parentId) => { await onAdd(title, parentId); }}
                onEdit={onEdit}
                onDelete={onDelete}
                onMove={onMove}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {items.length === 0 && <p className="hint">{t("items.empty")}</p>}
      <div className="mt-3">
        <QuickAdd label={t("items.addLabel")} placeholder={t("items.addPlaceholder")} onAdd={(title) => onAdd(title, null)} />
        <p className="hint mt-1 mb-0">{t("items.addHint")}</p>
      </div>
    </div>
  );
}
