import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import type { RunDetail, RunItemNode, RunSection } from "../../api/types";
import { Alert, Button, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";
import { enqueue } from "../../offline/queue";
import { ProgressBar, RunBoard, type BoardActions } from "./RunBoard";
import { ShareBadgeView } from "./RunsPage";
import { ShareDialog } from "./ShareDialog";
import { TemplatePicker } from "./TemplatePicker";

const mapItems = (items: RunItemNode[], id: string, checked: boolean): RunItemNode[] =>
  items.map((i) => ({ ...i, isChecked: i.id === id ? checked : i.isChecked, children: mapItems(i.children, id, checked) }));

/** Fügt einen noch nicht übertragenen Punkt in den lokalen Zwischenspeicher ein. */
const withTempItem = (run: RunDetail, sectionId: string, parentItemId: string | null, node: RunItemNode): RunDetail => {
  const insert = (items: RunItemNode[]): RunItemNode[] =>
    items.map((i) => (i.id === parentItemId ? { ...i, children: [...i.children, node] } : { ...i, children: insert(i.children) }));
  const total = run.progress.total + 1;
  return {
    ...run, progress: { ...run.progress, total },
    sections: run.sections.map((s) => (s.id !== sectionId ? s : { ...s, progress: { ...s.progress, total: s.progress.total + 1 }, items: parentItemId ? insert(s.items) : [...s.items, node] })),
  };
};
const isOffline = (err: unknown) => err instanceof ApiError && err.status === 0;

type Dlg = "share" | "templates" | "section" | "finish" | null;

/** F-23 bis F-30: Durchführung ansehen, abhaken, ergänzen, teilen, abschließen oder archivieren. */
export default function RunView() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["run", id];
  const q = useQuery({ queryKey: key, queryFn: async () => (await api.get<{ run: RunDetail }>(`/runs/${id}`)).run });
  const [dlg, setDlg] = useState<Dlg>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sectionTitle, setSectionTitle] = useState("");

  const run = q.data;
  const readOnly = run?.status !== "active";
  const apply = (res: { run: RunDetail }) => qc.setQueryData(key, res.run);
  const invalidateLists = () => qc.invalidateQueries({ queryKey: ["runs"] });

  /** Führt eine Änderung aus, übernimmt die Antwort des Servers und lädt bei Fehlern neu (der Server hat das letzte Wort). */
  async function call(fn: () => Promise<{ run: RunDetail }>, whenOffline?: () => void) {
    setError(null);
    if (whenOffline && !navigator.onLine) return whenOffline();
    try { apply(await fn()); void invalidateLists(); }
    catch (err) {
      if (whenOffline && isOffline(err)) return whenOffline(); // Server nicht erreichbar: lokal vormerken (F-74)
      setError(errorText(err));
      void qc.invalidateQueries({ queryKey: key });
    }
  }

  const actions: BoardActions = {
    onCheck: async (item, checked) => {
      qc.setQueryData<RunDetail>(key, (old) => old && { ...old, sections: old.sections.map((s) => ({ ...s, items: mapItems(s.items, item.id, checked) })) });
      await call(() => api.put(`/run-items/${item.id}`, { isChecked: checked }), () => enqueue({ kind: "check", runId: id, label: item.title, itemId: item.id, checked }));
    },
    onAdd: (sectionId, title, parentItemId) => call(() => api.post(`/run-sections/${sectionId}/items`, { title, parentItemId }), () => {
      const tempId = `tmp-${crypto.randomUUID()}`;
      enqueue({ kind: "add", runId: id, label: title, sectionId, parentItemId, title, tempId });
      const node: RunItemNode = { id: tempId, title, description: null, position: 0, isChecked: false, checkedAt: null, childProgress: { done: 0, total: 0 }, children: [] };
      qc.setQueryData<RunDetail>(key, (old) => old && withTempItem(old, sectionId, parentItemId, node));
    }),
    onDelete: (item) => call(() => api.del(`/run-items/${item.id}`)),
    onDeleteSection: (s: RunSection) => call(() => api.del(`/run-sections/${s.id}`)),
  };

  async function addTemplates() {
    setBusy(true);
    await call(() => api.post(`/runs/${id}/sections`, { templateIds: picked }));
    setBusy(false); setDlg(null); setPicked([]);
  }
  async function addSection(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await call(() => api.post(`/runs/${id}/sections`, { title: sectionTitle.trim() }));
    setBusy(false); setDlg(null); setSectionTitle("");
  }
  async function finish(kind: "complete" | "archive") {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/runs/${id}/${kind}`);
      await invalidateLists();
      await qc.invalidateQueries({ queryKey: ["shares"] });
      navigate(kind === "archive" ? "/archive" : "/", { state: { notice: kind === "archive" ? t("runs.archivedNotice", { title: run?.title }) : t("runs.completedNotice", { title: run?.title }) } });
    } catch (err) {
      setError(errorText(err)); setDlg(null); setBusy(false);
    }
  }
  async function reopen() {
    setError(null);
    try { apply(await api.post<{ run: RunDetail }>(`/runs/${id}/reopen`)); void invalidateLists(); setNotice(t("runs.reopened", { title: run?.title })); }
    catch (err) { setError(errorText(err)); }
  }

  if (q.isPending) return <Spinner />;
  if (q.isError && !q.data) {
    return (
      <>
        <Alert kind="error">{q.error instanceof ApiError && q.error.status === 404 ? t("runs.notFound") : errorText(q.error)}</Alert>
        <p><Link to="/">{t("notFound.home")}</Link></p>
      </>
    );
  }
  const r = run!;

  return (
    <>
      <p className="mt-0"><Link to={r.status === "archived" ? "/archive" : "/"}>← {r.status === "archived" ? t("nav.archive") : t("nav.runs")}</Link></p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 break-words text-2xl font-semibold">{r.title}</h1>
        <ShareBadgeView share={r.share} />
        {r.status === "archived" && <span className="badge">{t("runs.archivedBadge")}</span>}
      </div>
      <div className="mb-4"><ProgressBar progress={r.progress} label={t("runs.progressOf", { title: r.title })} /></div>

      <div className="mb-4 flex flex-wrap gap-2">
        {r.status === "active" ? (
          <>
            <Button onClick={() => setDlg("templates")}>＋ {t("runs.addTemplates")}</Button>
            <Button onClick={() => setDlg("section")}>＋ {t("runs.addSection")}</Button>
            <Button onClick={() => setDlg("share")}>{t("runs.share")}</Button>
            <Button variant="primary" onClick={() => setDlg("finish")}>{t("runs.finish")}</Button>
          </>
        ) : (
          <Button onClick={() => void reopen()}>{t("runs.reopen")}</Button>
        )}
      </div>

      {readOnly && <div className="mb-3"><Alert kind="info">{t("runs.readOnly")}</Alert></div>}
      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      <RunBoard sections={r.sections} readOnly={readOnly} actions={actions} />

      <ShareDialog runId={id} open={dlg === "share"} onClose={() => setDlg(null)} />

      <Dialog open={dlg === "templates"} onClose={() => setDlg(null)} title={t("runs.addTemplates")}
        footer={<><Button onClick={() => setDlg(null)}>{t("common.cancel")}</Button><Button variant="primary" disabled={busy || picked.length === 0} onClick={() => void addTemplates()}>{t("runs.addSelected")}</Button></>}>
        <p className="hint mt-0">{t("runs.addTemplatesHint")}</p>
        <TemplatePicker enabled={dlg === "templates"} selected={picked} onChange={setPicked} />
      </Dialog>

      <Dialog open={dlg === "section"} onClose={() => setDlg(null)} title={t("runs.addSection")}>
        <form onSubmit={addSection} noValidate>
          <TextInput label={t("runs.sectionTitle")} hint={t("runs.sectionHint")} autoFocus required maxLength={200} value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} />
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setDlg(null)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy || !sectionTitle.trim()}>{t("common.add")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={dlg === "finish"} onClose={() => setDlg(null)} title={t("runs.finishTitle")} footer={<Button onClick={() => setDlg(null)}>{t("common.cancel")}</Button>}>
        <div className="grid gap-4">
          <div>
            <p className="m-0 font-semibold">{t("runs.completeHeading")}</p>
            <p className="hint mt-1">{t("runs.completeText")}</p>
            <Button disabled={busy} onClick={() => void finish("complete")}>{t("runs.complete")}</Button>
          </div>
          <div>
            <p className="m-0 font-semibold">{t("runs.archiveHeading")}</p>
            <p className="hint mt-1">{t("runs.archiveText")}</p>
            <Button variant="primary" disabled={busy} onClick={() => void finish("archive")}>{t("runs.archive")}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
