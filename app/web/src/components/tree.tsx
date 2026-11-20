import type { TFunction } from "i18next";
import type { TreeGuide } from "../lib/tree";

/** Gemeinsame Darstellung von Punktebäumen (Vorlagen-Editor und Checkliste). */
export const INDENT = 28; // Pixel je Ebene (Einrückung und Maß für die horizontale Ziehbewegung)
const ELBOW_Y = 28; // Höhe der Verbindungslinie zur Zeile (Mitte der ersten Zeile)

/** Zeilenstil: Einrückung als Innenabstand, damit die Baumlinien links daneben Platz haben. */
export const rowStyle = (depth: number) => ({ paddingLeft: depth * INDENT });

/** Baumlinien (├ └) links neben einer Zeile, damit die Zugehörigkeit zum Überpunkt erkennbar ist. Das `li` braucht `relative`. */
export function TreeGuides({ depth, guides, last }: { depth: number } & TreeGuide) {
  if (depth === 0) return null;
  const x = (k: number) => k * INDENT + INDENT / 2 - 1;
  return (
    <span aria-hidden="true">
      {guides.map((on, k) => on && <span key={k} className="tree-line" style={{ left: x(k), top: 0, bottom: 0 }} />)}
      <span className="tree-line" style={last ? { left: x(depth - 1), top: 0, height: ELBOW_Y + 1 } : { left: x(depth - 1), top: 0, bottom: 0 }} />
      <span className="tree-line" style={{ left: x(depth - 1), top: ELBOW_Y - 1, width: INDENT / 2 + 1, height: 2 }} />
    </span>
  );
}

/** Hinweis an der gezogenen Zeile, wo sie landet. */
export function dropInfoText(t: TFunction, parentTitle: string | null, movedChildren: number): string {
  return [
    parentTitle !== null ? t("items.dropInto", { title: parentTitle }) : t("items.dropTopLevel"),
    ...(movedChildren ? [t("items.dropWithChildren", { count: movedChildren })] : []),
  ].join(" · ");
}

/** Klassen der gezogenen Zeile und des künftigen Überpunkts (wirken auf das Element mit Klasse `row`). */
export const dragClasses = (isDragging: boolean, isDropParent: boolean) =>
  `${isDragging ? "z-10 [&_.row]:shadow-lg [&_.row]:ring-2 [&_.row]:ring-primary" : ""} ${isDropParent ? "[&_.row]:outline-2 [&_.row]:outline-dashed [&_.row]:outline-primary" : ""}`;

/** Gezogene Zeile folgt nur senkrecht; die Ebene zeigt die Einrückung (rastet je Ebene ein). */
export const lockX = <T extends { x: number }>(transform: T | null, isDragging: boolean): T | null => (transform && isDragging ? { ...transform, x: 0 } : transform);

/** „⋯“-Schaltfläche, die auf Touch-Geräten die Aktionen einer Zeile ein- und ausblendet (am Desktop unsichtbar). */
export function RowMenuToggle({ open, title, onToggle, t }: { open: boolean; title: string; onToggle: () => void; t: TFunction }) {
  return (
    <button type="button" className="btn btn-sm row-menu-toggle shrink-0 px-2" aria-expanded={open} aria-label={t("items.moreActions", { title })} title={t("items.moreActionsShort")} onClick={onToggle}>⋯</button>
  );
}
