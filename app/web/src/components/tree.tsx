import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState, type MouseEventHandler, type ReactNode, type TouchEventHandler } from "react";
import type { TreeGuide } from "../lib/tree";

/** Gemeinsame Darstellung von Punktebäumen (Vorlagen-Editor und Checkliste). */
export const INDENT = 28; // Pixel je Ebene (Einrückung und Maß für die horizontale Ziehbewegung)
const ELBOW_Y = 22; // Höhe der Verbindungslinie zur Zeile (Mitte der ersten Zeile)
const ROW_PAD = 4; // Innenabstand links in der Zeile (px-1)
const LINE_X = ROW_PAD + 12; // senkrechte Linie unter dem Kästchen (24 px) des Überpunkts

/** Zeilenstil: Einrückung als Innenabstand, damit die Baumlinien links daneben Platz haben. */
export const rowStyle = (depth: number) => ({ paddingLeft: depth * INDENT });

/** Baumlinien (├ └) unter dem Kästchen des Überpunkts, damit die Zugehörigkeit erkennbar ist. Das `li` braucht `relative`. */
export function TreeGuides({ depth, guides, last }: { depth: number } & TreeGuide) {
  if (depth === 0) return null;
  const x = (k: number) => k * INDENT + LINE_X - 1;
  const reach = depth * INDENT + ROW_PAD; // bis zum Inhalt der Zeile
  return (
    <span aria-hidden="true">
      {guides.map((on, k) => on && <span key={k} className="tree-line" style={{ left: x(k), top: 0, bottom: 0 }} />)}
      <span className="tree-line" style={last ? { left: x(depth - 1), top: 0, height: ELBOW_Y + 1 } : { left: x(depth - 1), top: 0, bottom: 0 }} />
      <span className="tree-line" style={{ left: x(depth - 1), top: ELBOW_Y - 1, width: reach - x(depth - 1) - 2, height: 2 }} />
    </span>
  );
}

/**
 * Ziehen wie bei Todoist: Maus an der ganzen Zeile (außer Schaltflächen, Links, Eingabefeldern) oder am Griff links,
 * Touch per langem Druck auf die Zeile, Tastatur über den Griff. Zum Aufteilen der dnd-kit-Listener siehe `splitListeners`.
 */
export function useTreeSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), // kurze Klicks auf den Griff starten kein Ziehen
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }), // langer Druck; vorher bewegt = scrollen
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** Touch und Maus an die Zeile (Maus nicht auf Bedienelementen), Maus und Tastatur an den Griff. */
export function splitListeners(listeners: DraggableSyntheticListeners) {
  const { onTouchStart, ...handle } = listeners ?? {};
  const onMouseDown: MouseEventHandler = (e) => {
    if (!(e.target as Element).closest("button, a, input, textarea, select")) handle.onMouseDown?.(e);
  };
  return { row: onTouchStart ? { onTouchStart: onTouchStart as TouchEventHandler, onMouseDown } : {}, handle };
}

/** Nach dem Ablegen den folgenden Klick schlucken, damit Ziehen an einer Zeile sie nicht zusätzlich abhakt. */
export function swallowNextClick() {
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 100);
}

/** Kurzes Vibrieren, wenn langer Druck das Ziehen startet (nur Touch). */
export function dragStartFeedback(activator: Event) {
  if (activator.type.startsWith("touch")) navigator.vibrate?.(15);
}

/** Einfüge-Linie an der Stelle der gezogenen Zeile; ihre Einrückung zeigt die künftige Ebene. */
export function DropLine() {
  return <div className="drop-line" aria-hidden="true" />;
}

/** Vorschau der gezogenen Zeile, die dem Zeiger folgt (in `DragOverlay`). */
export function DragPreview({ title, childCount, checkbox = false }: { title: string; childCount: number; checkbox?: boolean }) {
  return (
    <div className="drag-preview">
      {checkbox && <span className="h-5 w-5 shrink-0 rounded border-2 border-muted" />}
      <span className="min-w-0 truncate font-medium">{title}</span>
      {childCount > 0 && <span className="badge shrink-0">+{childCount}</span>}
    </div>
  );
}

/** Strich-Icons der Zeilen (wie bei Todoist), Größe folgt `.icon-btn`. */
const svg = (children: ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" aria-hidden="true" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />);
export const EditIcon = () => svg(<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />);
export const MoreIcon = () => svg(<><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></>, true);
export const GripIcon = () => svg(<><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></>, true);

/** Zähler der Unterpunkte, zugleich Schalter zum Auf-/Zuklappen; `description` nennt den Zähler für Screenreader. */
export function CountToggle({ count, description, collapsed, title, onToggle, t }: { count: string; description: string; collapsed: boolean; title: string; onToggle: () => void; t: TFunction }) {
  const id = useId();
  return (
    <button type="button" className="count-btn" aria-expanded={!collapsed} aria-describedby={id} aria-label={t(collapsed ? "items.expand" : "items.collapse", { title })} onClick={onToggle}>
      <span aria-hidden="true">{count}</span>
      <span aria-hidden="true" className={`inline-block transition-transform ${collapsed ? "-rotate-90" : ""}`}>▾</span>
      <span id={id} className="sr-only">{description}</span>
    </button>
  );
}

/** Eintrag im „⋯“-Menü; `ariaLabel` nennt den Punkt mit, `desktopOnly` blendet ihn auf Touch-Geräten aus (Ebene dort per Ziehen). */
export interface MenuEntry { label: string; ariaLabel?: string; onSelect: () => void; disabled?: boolean; danger?: boolean; desktopOnly?: boolean }

/** „⋯“-Menü einer Zeile: am Desktop beim Darüberfahren, auf Touch-Geräten immer sichtbar. */
export function RowMenu({ title, entries, t }: { title: string; entries: MenuEntry[]; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="row-actions relative">
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t("items.moreActions", { title })} title={t("items.moreActionsShort")} onClick={() => setOpen((o) => !o)}><MoreIcon /></button>
      {open && (
        <div role="menu" aria-label={t("items.actionsFor", { title })} className="menu-pop">
          {entries.map((e) => (
            <button
              key={e.label} type="button" role="menuitem" disabled={e.disabled} aria-label={e.ariaLabel}
              className={`menu-item ${e.danger ? "text-danger" : ""} ${e.desktopOnly ? "touch-hide" : ""}`}
              onClick={() => { setOpen(false); e.onSelect(); }}
            >{e.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
