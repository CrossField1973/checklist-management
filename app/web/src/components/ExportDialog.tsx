import { useTranslation } from "react-i18next";
import { Button, Dialog } from "./ui";

export interface ExportOption { id: string; label: string; hint: string; run: () => void | Promise<unknown> }

/** Auswahl der Exportformate; schließt sich nach der Wahl, Fehler zeigt die aufrufende Seite. */
export function ExportDialog({ open, onClose, title, options }: { open: boolean; onClose: () => void; title: string; options: ExportOption[] }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<Button onClick={onClose}>{t("common.cancel")}</Button>}>
      <ul className="m-0 grid list-none gap-3 p-0">
        {options.map((o) => (
          <li key={o.id} className="flex items-center gap-3">
            <Button className="min-w-32" onClick={() => { onClose(); void o.run(); }}>{o.label}</Button>
            <span className="hint">{o.hint}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
