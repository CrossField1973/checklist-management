import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { TemplateSummary } from "../../api/types";
import { Spinner } from "../../components/ui";

/** Mehrfachauswahl von Vorlagen; die Klickreihenfolge bestimmt die Reihenfolge der Abschnitte (F-21, F-22). */
export function TemplatePicker({ enabled, selected, onChange, exclude = [] }: { enabled: boolean; selected: string[]; onChange: (ids: string[], titles: string[]) => void; exclude?: string[] }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const templates = useQuery({
    queryKey: ["templates", "all"], enabled,
    queryFn: () => api.get<{ templates: TemplateSummary[] }>("/templates?sort=title&limit=100"),
  });
  const titleOf = (id: string) => templates.data?.templates.find((x) => x.id === id)?.title ?? "";
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange(next, next.map(titleOf));
  };
  const list = (templates.data?.templates ?? []).filter((x) => !exclude.includes(x.id)).filter((x) => x.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));

  return (
    <fieldset className="mt-4 min-w-0 border-0 p-0">
      <legend className="label mt-0">{t("runs.pickTemplates")}</legend>
      <p className="hint mt-0">{t("runs.pickHint")}</p>
      {templates.isPending ? <Spinner /> : (templates.data?.templates.length ?? 0) === 0 ? (
        <p className="hint">{t("runs.noTemplates")} <Link to="/templates">{t("nav.templates")}</Link></p>
      ) : (
        <>
          <input type="search" className="input mb-2" aria-label={t("runs.filterTemplates")} placeholder={t("runs.filterTemplates")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="m-0 max-h-60 list-none divide-y divide-border overflow-auto rounded-lg border border-border p-0">
            {list.map((tpl) => {
              const idx = selected.indexOf(tpl.id);
              return (
                <li key={tpl.id}>
                  <label className="flex cursor-pointer items-center gap-3 p-2">
                    <input type="checkbox" className="h-5 w-5" checked={idx >= 0} onChange={() => toggle(tpl.id)} />
                    <span className="min-w-0 flex-1 break-words">{tpl.title}</span>
                    {idx >= 0 && <span className="badge" aria-label={t("runs.sectionNumber", { n: idx + 1 })}>{idx + 1}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="hint mb-0" aria-live="polite">{t("runs.selectedCount", { count: selected.length })}</p>
    </fieldset>
  );
}
