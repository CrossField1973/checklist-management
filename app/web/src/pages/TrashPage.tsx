import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { TrashEntry } from "../api/types";
import { Alert, Button, Dialog, Spinner, useErrorText } from "../components/ui";

type Confirm = { kind: "one"; entry: TrashEntry } | { kind: "all" } | null;

/** F-31: Papierkorb für Vorlagen und Durchführungen – wiederherstellen, endgültig löschen, leeren. */
export default function TrashPage() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["trash"], queryFn: () => api.get<{ retentionDays: number | null; items: TrashEntry[] }>("/trash") });
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => Promise.all(["trash", "runs", "templates", "tags", "shares"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  async function run(fn: () => Promise<unknown>, done: string) {
    setError(null); setNotice(null);
    try { await fn(); await refresh(); setNotice(done); } catch (err) { setError(errorText(err)); }
  }

  const date = (ms: number) => new Date(ms).toLocaleDateString(i18n.language, { dateStyle: "medium" });
  const items = q.data?.items ?? [];
  const retention = q.data?.retentionDays;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 text-2xl font-semibold">{t("nav.trash")}</h1>
        {items.length > 0 && <Button variant="danger" onClick={() => setConfirm({ kind: "all" })}>{t("trash.empty")}</Button>}
      </div>
      <p className="hint mt-0">{retention ? t("trash.retention", { days: retention }) : t("trash.retentionNever")}</p>
      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      {q.isPending ? <Spinner /> : q.isError ? <Alert kind="error">{errorText(q.error)}</Alert> : items.length === 0 ? (
        <div className="card text-center"><p className="m-0">{t("trash.isEmpty")}</p></div>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((e) => (
            <li key={`${e.type}-${e.id}`} className="card flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="m-0 break-words font-semibold">{e.title} <span className="badge">{e.type === "template" ? t("trash.template") : e.statusBeforeDelete === "archived" ? t("trash.runArchived") : t("trash.run")}</span></p>
                <p className="hint m-0">
                  {t("trash.deletedOn", { date: date(e.deletedAt) })} · {e.purgeAt ? t("trash.purgeOn", { date: date(e.purgeAt) }) : t("trash.purgeNever")}
                  {e.progress && e.progress.total > 0 && ` · ${e.progress.done}/${e.progress.total}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" aria-label={t("trash.restoreNamed", { title: e.title })} onClick={() => void run(() => api.post(`/trash/${e.type}/${e.id}/restore`), t("trash.restored", { title: e.title }))}>{t("trash.restore")}</Button>
                <Button size="sm" variant="danger" aria-label={t("trash.deleteNamed", { title: e.title })} onClick={() => setConfirm({ kind: "one", entry: e })}>{t("trash.deleteForever")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.kind === "all" ? t("trash.emptyTitle") : t("trash.deleteTitle")}
        footer={<><Button onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={() => {
            const c = confirm; setConfirm(null);
            if (c?.kind === "all") void run(() => api.del("/trash"), t("trash.emptied"));
            else if (c) void run(() => api.del(`/trash/${c.entry.type}/${c.entry.id}`), t("trash.deleted", { title: c.entry.title }));
          }}>{confirm?.kind === "all" ? t("trash.empty") : t("trash.deleteForever")}</Button></>}
      >
        <p className="m-0">{confirm?.kind === "all" ? t("trash.emptyText", { count: items.length }) : t("trash.deleteText", { title: confirm?.entry.title })}</p>
      </Dialog>
    </>
  );
}
