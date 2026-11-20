import {
  DndContext, DragOverlay, MeasuringStrategy, closestCenter,
  type DragCancelEvent, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  descendantIds, findNode, flatten, getProjection, indentTarget, isSamePlace, moveDownTarget, moveUpTarget, outdentTarget,
  treeGuides, type FlatItem, type ItemNode, type MoveTarget, type TreeGuide,
} from "../../lib/tree";
import {
  CountToggle, DragPreview, DropLine, EditIcon, GripIcon, PlusIcon, INDENT, RowMenu, TreeGuides, dragStartFeedback, rowStyle, splitListeners, swallowNextClick, useTreeSensors, type MenuEntry,
} from "../../components/tree";

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
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <div className="flex gap-2">
        <input
          ref={input} className="input min-w-0 flex-1" aria-label={label} placeholder={placeholder} value={value} maxLength={200} autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && onClose) { e.preventDefault(); onClose(); } }}
        />
        <button type="submit" className={`btn ${value.trim() ? "btn-primary" : ""}`} disabled={busy || !value.trim()}>{t("common.add")}</button>
        {onClose && <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>}
      </div>
    </form>
  );
}

interface RowProps extends Actions {
  item: FlatItem;
  depth: number;
  guide: TreeGuide;
  tree: ItemNode[];
  isCollapsed: boolean;
  isDragging: boolean;
  addingHere: boolean;
  onToggle: () => void;
  onToggleAdd: () => void;
}

function Row({ item, depth, guide, tree, isCollapsed, isDragging, addingHere, onToggle, onToggleAdd, onAdd, onEdit, onDelete, onMove }: RowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: item.id });
  const node = item.node;
  const hasChildren = node.children.length > 0;
  const up = moveUpTarget(tree, node.id);
  const down = moveDownTarget(tree, node.id);
  const indent = indentTarget(tree, node.id);
  const outdent = outdentTarget(tree, node.id);
  const split = splitListeners(listeners);
  const title = node.title;
  const menu: MenuEntry[] = [ // Verschieben ohne Ziehen (WCAG 2.5.7); Ein-/Ausrücken nur am Desktop, am Handy seitlich ziehen
    ...[
      { label: t("items.upShort"), ariaLabel: t("items.up", { title }), target: up },
      { label: t("items.downShort"), ariaLabel: t("items.down", { title }), target: down },
      { label: t("items.indentShort"), ariaLabel: t("items.indent", { title }), target: indent, desktopOnly: true },
      { label: t("items.outdentShort"), ariaLabel: t("items.outdent", { title }), target: outdent, desktopOnly: true },
    ].map(({ target, ...e }) => ({ ...e, disabled: !target, onSelect: () => { if (target) void onMove(node.id, target); } })),
    ...(node.ref ? [] : [
      { label: t("items.addChildShort"), ariaLabel: t("items.addChild", { title }), onSelect: onToggleAdd },
      { label: t("common.edit"), ariaLabel: t("items.edit", { title }), onSelect: () => onEdit(node) },
    ]),
    { label: t("common.delete"), ariaLabel: t("items.delete", { title }), onSelect: () => onDelete(node), danger: true },
  ];

  return (
    <>
      <li
        ref={setNodeRef} {...split.row}
        style={{ transform: CSS.Translate.toString(transform), transition, ...rowStyle(depth) }}
        className="relative"
        data-testid={`item-${node.id}`}
      >
        {isDragging ? <DropLine /> : (
          <>
            <TreeGuides depth={depth} {...guide} />
            <div className="row relative flex flex-wrap items-center gap-x-1 px-1 py-0.5">
              <button
                ref={setActivatorNodeRef} type="button" {...attributes} {...split.handle}
                aria-label={t("items.dragHandle", { title })} title={t("items.dragHint")}
                className="icon-btn drag-handle row-actions"
              ><GripIcon /></button>
              <div className="flex min-h-10 min-w-0 flex-[1_1_12rem] items-center gap-1">
                <div className="min-w-0 flex-1 px-1 py-1">
                  {node.ref ? (
                    <p className="m-0 font-medium hyphens-auto [overflow-wrap:anywhere]">
                      <span className="badge mr-2">{t("items.templateBadge")}</span>
                      {node.ref.missing ? <span className="text-danger">{node.title || t("items.missingTemplate")} – {t("items.missingTemplate")}</span> : (
                        <>
                          <Link className="link" to={`/templates/${node.ref.templateId}`}>{node.ref.title}</Link>
                          {node.ref.itemCount > 0 && <span className="hint ml-2">{t("items.refCount", { count: node.ref.itemCount })}</span>}
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="m-0 font-medium hyphens-auto [overflow-wrap:anywhere]">{title}</p>
                  )}
                </div>
                {hasChildren && (
                  <CountToggle count={String(node.children.length)} description={t("items.hidden", { count: node.children.length })} collapsed={isCollapsed} title={title} onToggle={onToggle} t={t} />
                )}
              </div>
              <div className="ml-auto flex items-center gap-0.5">
                {!node.ref && <button type="button" className="icon-btn row-actions touch-hide" aria-expanded={addingHere} onClick={onToggleAdd} aria-label={t("items.addChild", { title })} title={t("items.addChildShort")}><PlusIcon /></button>}
                {!node.ref && <button type="button" className="icon-btn row-actions touch-hide" onClick={() => onEdit(node)} aria-label={t("items.edit", { title })} title={t("common.edit")}><EditIcon /></button>}
                <RowMenu title={title} entries={menu} t={t} />
              </div>
            </div>
          </>
        )}
      </li>
      {addingHere && (
        <li className="relative py-1" style={rowStyle(depth + 1)}>
          <TreeGuides depth={depth + 1} guides={depth > 0 ? [...guide.guides, !guide.last] : []} last={isCollapsed || !hasChildren} />
          <QuickAdd label={t("items.addChildLabel", { title: node.title })} placeholder={t("items.addChildPlaceholder")} autoFocus onClose={onToggleAdd} onAdd={(title) => onAdd(title, node.id)} />
        </li>
      )}
    </>
  );
}

/**
 * Punktebaum einer Vorlage (F-13, F-14): Ziehen mit Maus/Touch/Tastatur (dnd-kit) – horizontale Bewegung ändert die Ebene –
 * und als gleichwertige Alternative das „⋯“-Menü mit Hoch, Runter, Ein- und Ausrücken (WCAG 2.5.7).
 */
export function ItemTree({ items, onAdd, onEdit, onDelete, onMove }: { items: ItemNode[] } & Actions) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);

  const sensors = useTreeSensors();

  const flat = useMemo(() => {
    const all = flatten(items, collapsed);
    if (!activeId) return all;
    const active = findNode(items, activeId);
    const hidden = new Set(active ? descendantIds(active) : []);
    return all.filter((i) => !hidden.has(i.id)); // Unterpunkte wandern beim Ziehen mit und sind ausgeblendet
  }, [items, collapsed, activeId]);

  const projection = activeId && overId ? getProjection(flatten(items, collapsed), activeId, overId, offsetX, INDENT, collapsed) : null;
  const title = (id: unknown) => findNode(items, String(id))?.title ?? "";
  const guides = treeGuides(flat.map((i) => i.depth));
  const active = activeId ? findNode(items, activeId) : null;
  const reset = () => { setActiveId(null); setOverId(null); setOffsetX(0); swallowNextClick(); };

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
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(e: DragStartEvent) => { setActiveId(String(e.active.id)); setOverId(String(e.active.id)); dragStartFeedback(e.activatorEvent); }}
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
          <ul className="m-0 list-none p-0" aria-label={t("items.listLabel")}>
            {flat.map((item, i) => (
              <Row
                key={item.id}
                item={item}
                depth={item.id === activeId && projection ? projection.depth : item.depth}
                guide={guides[i]!}
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
        <DragOverlay dropAnimation={null}>
          {active && <DragPreview title={active.ref?.title ?? active.title} childCount={descendantIds(active).length} />}
        </DragOverlay>
      </DndContext>

      {items.length === 0 && <p className="hint">{t("items.empty")}</p>}
      <div className="mt-3">
        <QuickAdd label={t("items.addLabel")} placeholder={t("items.addPlaceholder")} onAdd={(title) => onAdd(title, null)} />
        <p className="hint mt-1 mb-0">{t("items.addHint")}</p>
      </div>
    </div>
  );
}
