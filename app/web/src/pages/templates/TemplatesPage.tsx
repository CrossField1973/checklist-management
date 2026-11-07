import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { TemplateSummary } from "../../api/types";
import { Alert, Button, Dialog, Select, Spinner, TextInput, useErrorText } from "../../components/ui";
import { TagChip } from "./TagChip";
import { TagPicker } from "./TagPicker";
import { useTags } from "./TagManager";

const PAGE_SIZE = 20;

/** Eingaben erst nach kurzer Pause an den Server weitergeben (Suche beim Tippen). */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

/** F-11: Vorlagenliste mit Suche, Tag-Filter, Sortierung und Seiten; Neu, Duplizieren, Löschen (→ Papierkorb). */
export default function TemplatesPage() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();

  const tagId = params.get("tag") ?? "";
  const sort = params.get("sort") === "title" ? "title" : "updated";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const debounced = useDebounced(search.trim());

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page"); // Filter ändern → zurück auf Seite 1
    setParams(next, { replace: true });
  };
  // Suchbegriff in die Adresse übernehmen (teilbar, überlebt Neuladen)
  useEffect(() => { if ((params.get("q") ?? "") !== debounced) setParam("q", debounced); }, [debounced]);

  const tags = useTags();
  const list = useQuery({
    queryKey: ["templates", { q: debounced, tagId, sort, page }],
    queryFn: () => {
      const q = new URLSearchParams({ sort, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (debounced) q.set("search", debounced);
      if (tagId) q.set("tagId", tagId);
      return api.get<{ total: number; templates: TemplateSummary[] }>(`/templates?${q}`);
    },
    placeholderData: keepPreviousData,
  });

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newTagIds, setNewTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const notice = (location.state as { notice?: string } | null)?.notice;

  /** Der Dialog sammelt nur Titel und Tags; angelegt wird erst auf der Seite mit „Erstellen“. */
  function create(e: FormEvent) {
    e.preventDefault();
    navigate("/templates/new", { state: { draft: { title: newTitle.trim(), tagIds: newTagIds } } });
  }
  function openCreate() { setNewTitle(""); setNewTagIds([]); setError(null); setCreating(true); }
  /** Klick irgendwo in die Zeile öffnet die Vorlage – außer auf Links und Schaltflächen, die ihre eigene Aktion haben. */
  const openRow = (id: string) => (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("a,button")) navigate(`/templates/${id}`); };


  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const date = (ms: number) => new Date(ms).toLocaleDateString(i18n.language, { dateStyle: "medium" });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 text-2xl font-semibold">{t("nav.templates")}</h1>
        <Button variant="primary" data-shortcut="new" onClick={openCreate}>{t("templates.new")}</Button>
      </div>

      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && !creating && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="tpl-search" className="label mt-0">{t("templates.search")}</label>
          <input id="tpl-search" data-shortcut="search" type="search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("templates.searchPlaceholder")} />
        </div>
        <div className="w-44">
          <Select label={t("templates.sort")} value={sort} onChange={(e) => setParam("sort", e.target.value === "title" ? "title" : "")}>
            <option value="updated">{t("templates.sortUpdated")}</option>
            <option value="title">{t("templates.sortTitle")}</option>
          </Select>
        </div>
      </div>

      {tags.data && tags.data.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("templates.filterByTag")}>
          <button type="button" className={`btn btn-sm ${tagId === "" ? "btn-primary" : ""}`} aria-pressed={tagId === ""} onClick={() => setParam("tag", "")}>{t("templates.allTags")}</button>
          {tags.data.map((tag) => (
            <button key={tag.id} type="button" className={`btn btn-sm ${tagId === tag.id ? "btn-primary" : ""}`} aria-pressed={tagId === tag.id} onClick={() => setParam("tag", tagId === tag.id ? "" : tag.id)}>
              <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: tag.color }} /> {tag.name}
            </button>
          ))}
        </div>
      )}

      {list.isPending ? <Spinner /> : (list.isError && !list.data) ? <Alert kind="error">{errorText(list.error)}</Alert> : total === 0 ? (
        <div className="card text-center">
          <p className="m-0">{debounced || tagId ? t("templates.noResults") : t("templates.empty")}</p>
          {!debounced && !tagId && <Button variant="primary" className="mt-3" onClick={openCreate}>{t("templates.new")}</Button>}
        </div>
      ) : (
        <>
          <p className="hint mt-0" aria-live="polite">{t("templates.count", { count: total })}</p>
          <ul className="m-0 grid list-none gap-3 p-0">
            {list.data!.templates.map((tpl) => (
              <li key={tpl.id} className="card flex cursor-pointer flex-wrap items-center gap-3" onClick={openRow(tpl.id)}>
                <div className="min-w-0 flex-1">
                  <Link to={`/templates/${tpl.id}`} className="text-base font-semibold text-text no-underline hover:underline">{tpl.title}</Link>
                  <p className="hint m-0">{t("templates.items", { count: tpl.itemCount })} · {t("templates.changed", { date: date(tpl.updatedAt) })}</p>
                  {tpl.tags.length > 0 && <p className="m-0 mt-1 flex flex-wrap gap-1">{tpl.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</p>}
                </div>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="mt-4 flex items-center justify-center gap-3" aria-label={t("templates.pagination")}>
              <Button size="sm" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}>{t("common.previous")}</Button>
              <span className="text-sm">{t("templates.pageOf", { page, pages })}</span>
              <Button size="sm" disabled={page >= pages} onClick={() => setParam("page", String(page + 1))}>{t("common.next")}</Button>
            </nav>
          )}
        </>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title={t("templates.newTitle")}>
        <form onSubmit={create} noValidate>
          <TextInput label={t("templates.titleLabel")} required autoFocus maxLength={200} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          <TagPicker value={newTagIds} onChange={setNewTagIds} />
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!newTitle.trim()}>{t("templates.continueToItems")}</Button>
          </div>
        </form>
      </Dialog>


    </>
  );
}
