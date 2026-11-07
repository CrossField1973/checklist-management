import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "./ui";

/** Alle Kürzel mit Erklärung – im Hilfe-Dialog (?) und im Profil. */
export function ShortcutList() {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    ["Strg + S", t("shortcuts.save")],
    ["N", t("shortcuts.new")],
    ["/", t("shortcuts.search")],
    ["?", t("shortcuts.help")],
    ["Esc", t("shortcuts.close")],
  ];
  return (
    <>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {rows.map(([k, text]) => (
          <div key={k} className="contents"><dt><kbd className="badge">{k}</kbd></dt><dd className="m-0">{text}</dd></div>
        ))}
      </dl>
      <p className="hint mb-0">{t("shortcuts.hint")}</p>
    </>
  );
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const click = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return false;
  el.click();
  return true;
};

/**
 * Globale Tastenkürzel. Strg/Cmd+S speichert (auch in Textfeldern), die Einzeltasten N, / und ? gelten nur,
 * wenn man nicht gerade tippt und kein Dialog offen ist. Die Seiten markieren ihre Ziele mit `data-shortcut`.
 */
export function Shortcuts() {
  const { t } = useTranslation();
  const [help, setHelp] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault(); // das Speichern-Fenster des Browsers soll nie aufgehen
        click('[data-shortcut="save"]');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector("dialog[open]")) return;
      if (e.key === "n" || e.key === "N") { if (click('[data-shortcut="new"]')) e.preventDefault(); }
      else if (e.key === "/") {
        const input = document.querySelector<HTMLInputElement>('[data-shortcut="search"]');
        if (input) { e.preventDefault(); input.focus(); input.select(); }
      } else if (e.key === "?") { e.preventDefault(); setHelp(true); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={help} onClose={() => setHelp(false)} title={t("shortcuts.title")} footer={<Button onClick={() => setHelp(false)}>{t("common.done")}</Button>}>
      <ShortcutList />
    </Dialog>
  );
}
