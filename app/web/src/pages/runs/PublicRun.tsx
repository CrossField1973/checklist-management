import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import type { RunSection } from "../../api/types";
import { Alert, Button, Spinner, TextInput, useErrorText } from "../../components/ui";
import { applyCheck, withProgress } from "../../lib/tree";
import { ProgressBar, RunBoard, type BoardActions } from "./RunBoard";

interface PublicView { permission: "view" | "edit"; run: { title: string; updatedAt: number; sections: RunSection[]; progress: { done: number; total: number } } }


/** Öffentliche Ansicht über einen Freigabelink (/s/<token>): ohne Anmeldung, optional mit Passwort, ansehen oder bearbeiten (F-40 bis F-43). */
export default function PublicRun() {
  const { token = "" } = useParams();
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [password, setPassword] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const headers = password ? { "x-share-password": password } : undefined;
  const key = ["public-run", token, password];

  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<PublicView>(`/public/runs/${token}`, headers),
    retry: false,
    refetchInterval: (query) => (query.state.data ? 5000 : false), // Änderungen anderer erscheinen von selbst
    refetchIntervalInBackground: false,
  });

  const needsPassword = q.error instanceof ApiError && (q.error.code === "password_required" || q.error.code === "invalid_password");
  const view = q.data;
  const readOnly = view?.permission !== "edit";
  const apply = (res: PublicView) => qc.setQueryData(key, res);

  async function call(fn: () => Promise<PublicView>) {
    setError(null);
    try { apply(await fn()); } catch (err) { setError(errorText(err)); void qc.invalidateQueries({ queryKey: key }); }
  }
  const base = `/public/runs/${token}`;
  const actions: BoardActions = {
    onCheck: async (item, checked) => {
      qc.setQueryData<PublicView>(key, (old) => old && { ...old, run: { ...old.run, ...withProgress(old.run.sections.map((s) => ({ ...s, items: applyCheck(s.items, item.id, checked) }))) } });
      await call(() => api.put(`${base}/items/${item.id}`, { isChecked: checked }, headers));
    },
    onAdd: (sectionId, title, parentItemId) => call(() => api.post(`${base}/sections/${sectionId}/items`, { title, parentItemId }, headers)),
    onDelete: (item) => call(() => api.del(`${base}/items/${item.id}`, undefined, headers)),
  };

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    setPassword(typed);
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl p-4 md:p-7">
      <header className="mb-4 flex items-center gap-2 text-lg font-semibold"><img src="/favicon.svg" alt="" width={24} height={24} /> {t("app.name")}</header>
      <main id="main">
        {q.isPending ? <Spinner /> : needsPassword ? (
          <form onSubmit={submitPassword} className="card max-w-md" noValidate>
            <h1 className="m-0 text-xl font-semibold">{t("publicRun.passwordTitle")}</h1>
            <p className="hint">{t("publicRun.passwordText")}</p>
            <TextInput label={t("publicRun.password")} type="password" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} error={q.error instanceof ApiError && q.error.code === "invalid_password" ? t("publicRun.wrongPassword") : null} />
            <Button type="submit" variant="primary" className="mt-3" disabled={!typed}>{t("publicRun.open")}</Button>
          </form>
        ) : q.isError ? (
          <Alert kind="error">{q.error instanceof ApiError && q.error.status === 404 ? t("publicRun.invalid") : errorText(q.error)}</Alert>
        ) : (
          <>
            <h1 className="mt-0 break-words text-2xl font-semibold">{view!.run.title}</h1>
            <div className="mb-3"><ProgressBar progress={view!.run.progress} label={t("runs.progressOf", { title: view!.run.title })} /></div>
            <div className="mb-4"><Alert kind="info">{readOnly ? t("publicRun.viewOnly") : t("publicRun.canEdit")}</Alert></div>
            {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}
            <RunBoard sections={view!.run.sections} readOnly={readOnly} actions={actions} />
          </>
        )}
      </main>
    </div>
  );
}
