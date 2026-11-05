import type { Tag } from "../../api/types";

/** Farbige Markierung; Schriftfarbe kommt vom Server (schwarz/weiß mit ausreichendem Kontrast). */
export function TagChip({ tag }: { tag: Pick<Tag, "name" | "color" | "textColor"> }) {
  return <span className="tag" style={{ backgroundColor: tag.color, color: tag.textColor }}>{tag.name}</span>;
}
