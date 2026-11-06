import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { RunDetail, RunSummary, ShareBadge } from "../../api/types";
import { Alert, Button, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";
import { ProgressBar } from "./RunBoard";
import { TemplatePicker } from "./TemplatePicker";

export function ShareBadgeView({ share }: { share: ShareBadge | null }) {
  const { t } = useTranslation();
  if (!share) return null;
  const text = `${t("runs.shared")} · ${share.permission === "edit" ? t("profile.shares.edit") : t("profile.shares.view")}${share.access === "password" ? ` · ${t("profile.shares.withPassword")}` : ""}`;
  return <span className="badge" data-testid="share-badge">🔗 {text}</span>;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

/** Dialog „Neue Durchführung“: Titel und beliebig viele Vorlagen (F-21); die Auswahlreihenfolge bestimmt die Abschnitte. */
function NewRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [titleTouched, setTitleTouched] = useState(false);
  const { i18n } = useTranslation();
  const suggest = (titles: string[]) => {
    if (titleTouched || titles.length === 0) return;
    const day = new Date().toLocaleDateString(i18n.language, { day: "numeric", month: "short" });
    setTitle(`${titles.length > 2 ? `${titles.slice(0, 2).join(" + ")} + …` : titles.join(" + ")} – ${day}`);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(""); setTitleTouched(false); setSelected([]); setError(null); } }, [open]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ run: RunDetail }>("/runs", { title: title.trim(), templateIds: selected });
      await qc.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${res.run.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("runs.newTitle")}>
      <form onSubmit={create} noValidate>
        <TemplatePicker enabled={open} selected={selected} onChange={(ids, titles) => { setSelected(ids); suggest(titles); }} />
        <div className="mt-4">
          <TextInput label={t("runs.titleLabel")} hint={selected.length > 0 && !titleTouched ? t("runs.titleHint") : undefined} required maxLength={200} value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} />
        </div>
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy || !title.trim()}>{t("runs.create")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

const PAGE_SIZE = 20;

/** Startseite (aktive Durchführungen, F-20) und Archiv (F-29): Suche, Fortschritt, Kennzeichnung geteilter Durchführungen. */
export default function RunsPage({ status }: { status: "active" | "archived" }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const archived = status === "archived";
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [debounced, status]);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>((useLocation().state as { notice?: string } | null)?.notice ?? null);

  const list = useQuery({
    queryKey: ["runs", { status, q: debounced, page }],
    queryFn: () => {
      const q = new URLSearchParams({ status, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (debounced) q.set("search", debounced);
      return api.get<{ total: number; runs: RunSummary[] }>(`/runs?${q}`);
    },
    placeholderData: keepPreviousData,
  });

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ["runs"] }); if (done) setNotice(done); } catch (err) { setError(errorText(err)); }
  };

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const date = (ms: number) => new Date(ms).toLocaleDateString(i18n.language, { dateStyle: "medium" });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 text-2xl font-semibold">{archived ? t("nav.archive") : t("nav.runs")}</h1>
        {!archived && <Button variant="primary" onClick={() => setCreating(true)}>＋ {t("runs.new")}</Button>}
      </div>
      {archived && <p className="hint mt-0">{t("runs.archiveIntro")}</p>}
      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      {((list.data?.total ?? 0) > 5 || search) && <div className="mb-4">
        <label htmlFor="run-search" className="label mt-0">{t("runs.search")}</label>
        <input id="run-search" type="search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("runs.searchPlaceholder")} />
      </div>}

      {list.isPending ? <Spinner /> : (list.isError && !list.data) ? <Alert kind="error">{errorText(list.error)}</Alert> : total === 0 ? (
        <div className="card text-center">
          <p className="m-0">{debounced ? t("runs.noResults") : archived ? t("runs.archiveEmpty") : t("runs.empty")}</p>
          {!archived && !debounced && (
            <>
              <p className="hint">{t("runs.step1")}<br />{t("runs.step2")}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Link className="btn no-underline" to="/templates">{t("runs.newTemplate")}</Link>
                <Button variant="primary" onClick={() => setCreating(true)}>＋ {t("runs.new")}</Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="hint mt-0" aria-live="polite">{t("runs.count", { count: total })}</p>
          <ul className="m-0 grid list-none gap-3 p-0">
            {list.data!.runs.map((r) => (
              <li key={r.id} className="card">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <Link to={`/runs/${r.id}`} className="text-base font-semibold text-text no-underline hover:underline">{r.title}</Link>{" "}
                    <ShareBadgeView share={r.share} />
                    <p className="hint m-0">{r.sectionTitles.join(" · ") || t("runs.noSections")} · {archived && r.archivedAt ? t("runs.archivedOn", { date: date(r.archivedAt) }) : t("runs.changed", { date: date(r.updatedAt) })}</p>
                  </div>
                  {archived && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void run(() => api.post(`/runs/${r.id}/reopen`), t("runs.reopened", { title: r.title }))} aria-label={t("runs.reopenNamed", { title: r.title })}>{t("runs.reopen")}</Button>
                      <Button size="sm" variant="danger" onClick={() => setToDelete(r)} aria-label={t("runs.deleteNamed", { title: r.title })}>{t("common.delete")}</Button>
                    </div>
                  )}
                </div>
                <div className="mt-2"><ProgressBar progress={r.progress} label={t("runs.progressOf", { title: r.title })} /></div>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="mt-4 flex items-center justify-center gap-3" aria-label={t("templates.pagination")}>
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("common.previous")}</Button>
              <span className="text-sm">{t("templates.pageOf", { page, pages })}</span>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t("common.next")}</Button>
            </nav>
          )}
        </>
      )}

      <NewRunDialog open={creating} onClose={() => setCreating(false)} />
      <Dialog
        open={toDelete !== null} onClose={() => setToDelete(null)} title={t("runs.deleteTitle")}
        footer={<><Button onClick={() => setToDelete(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={() => { const r = toDelete!; setToDelete(null); void run(() => api.del(`/runs/${r.id}`), t("runs.deleted", { title: r.title })); }}>{t("common.delete")}</Button></>}
      >
        <p className="m-0">{t("runs.deleteText", { title: toDelete?.title })}</p>
      </Dialog>
    </>
  );
}
