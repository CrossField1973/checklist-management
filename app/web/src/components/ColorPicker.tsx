import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Auswahl gut unterscheidbarer Farben (Tailwind-Palette, 500er/600er Töne). */
const SWATCHES = [
  "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#65a30d", "#16a34a", "#0d9488", "#0891b2",
  "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#c026d3", "#db2777", "#e11d48", "#64748b",
];
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Farbwahl ohne Betriebssystem-Dialog: Farbfelder zum Anklicken plus Eingabe eines Hex-Werts.
 * `onChange` wird bei jeder bestätigten Wahl aufgerufen (Klick auf ein Feld, Enter oder Verlassen des Hex-Felds).
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => setHex(value), [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (c: string) => { onChange(c.toLowerCase()); setOpen(false); };
  const commitHex = () => {
    const v = (hex.startsWith("#") ? hex : `#${hex}`).trim();
    if (HEX.test(v) && v.toLowerCase() !== value.toLowerCase()) onChange(v.toLowerCase());
    else setHex(value);
  };

  return (
    <div ref={root} className="relative" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
        className="h-9 w-10 cursor-pointer rounded border border-border p-1" style={{ backgroundColor: "transparent" }}>
        <span className="block h-full w-full rounded-sm" style={{ backgroundColor: value }} />
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={label} className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-border bg-surface p-3 shadow-lg">
          <div className="grid grid-cols-8 gap-1.5">
            {SWATCHES.map((c) => (
              <button key={c} type="button" onClick={() => pick(c)} aria-label={c} aria-pressed={c.toLowerCase() === value.toLowerCase()} title={c}
                className={`h-5 w-5 cursor-pointer rounded-full border border-border p-0 ${c.toLowerCase() === value.toLowerCase() ? "ring-2 ring-primary ring-offset-1" : ""}`}
                style={{ backgroundColor: c }} />
            ))}
          </div>
          <label className="label mb-1 mt-3 block" htmlFor={`${panelId}-hex`}>{t("tags.hex")}</label>
          <input id={`${panelId}-hex`} className="input" value={hex} maxLength={7} spellCheck={false} autoComplete="off"
            onChange={(e) => setHex(e.target.value)} onBlur={commitHex}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitHex(); } }} />
        </div>
      )}
    </div>
  );
}
