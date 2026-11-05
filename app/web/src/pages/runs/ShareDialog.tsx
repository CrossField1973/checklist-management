import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import type { OwnShare } from "../../api/types";
import { Alert, Button, Dialog, Select, Spinner, TextInput, useErrorText } from "../../components/ui";
import { useCopy } from "../../lib/clipboard";

/** F-40 bis F-43: Freigabelink anlegen, Einstellungen ändern, neu erzeugen oder beenden. */
export function ShareDialog({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { copied, copy } = useCopy();
  const key = ["run-share", runId];
  const q = useQuery({ queryKey: key, enabled: open, queryFn: () => api.get<{ share: OwnShare | null }>(`/runs/${runId}/share`) });
  const share = q.data?.share ?? null;

  const [access, setAccess] = useState<"anyone" | "password">("anyone");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword(""); setError(null); setNotice(null);
  }, [open]);
  useEffect(() => {
    if (share) { setAccess(share.access); setPermission(share.permission); }
  }, [share?.id, share?.access, share?.permission]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ["run", runId] });
    await qc.invalidateQueries({ queryKey: ["runs"] });
    await qc.invalidateQueries({ queryKey: ["shares"] });
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); await refresh(); setPassword(""); setNotice(done); }
    catch (err) { setError(err instanceof ApiError && err.code === "password_required" ? t("share.passwordRequired") : errorText(err)); }
    finally { setBusy(false); }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.put(`/runs/${runId}/share`, { access, permission, ...(access === "password" && password ? { password } : {}) }), share ? t("share.saved") : t("share.created"));
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("share.title")} footer={<Button variant="primary" onClick={onClose}>{t("common.done")}</Button>}>
      {q.isPending ? <Spinner /> : q.isError ? <Alert kind="error">{errorText(q.error)}</Alert> : (
        <>
          <p className="hint mt-0">{share ? t("share.activeIntro") : t("share.intro")}</p>
          {share?.url && (
            <div className="mb-4 flex gap-2">
              <input className="input min-w-0 flex-1" readOnly aria-label={t("share.link")} value={share.url} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => void copy(share.url!)}>{copied ? t("common.copied") : t("common.copy")}</Button>
            </div>
          )}
          <form onSubmit={save} noValidate>
            <Select label={t("profile.shares.accessLabel")} value={access} onChange={(e) => setAccess(e.target.value as "anyone" | "password")}>
              <option value="anyone">{t("profile.shares.anyone")}</option>
              <option value="password">{t("profile.shares.withPassword")}</option>
            </Select>
            {access === "password" && (
              <TextInput label={t("profile.shares.password")} hint={share?.access === "password" ? t("share.passwordKeep") : t("profile.shares.passwordHint")} type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
            <Select label={t("profile.shares.permissionLabel")} value={permission} onChange={(e) => setPermission(e.target.value as "view" | "edit")}>
              <option value="view">{t("profile.shares.view")}</option>
              <option value="edit">{t("profile.shares.edit")}</option>
            </Select>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={busy}>{share ? t("common.save") : t("share.create")}</Button>
              {share && <Button disabled={busy} onClick={() => void act(() => api.post(`/runs/${runId}/share/regenerate`), t("share.regenerated"))}>{t("share.regenerate")}</Button>}
              {share && <Button variant="danger" disabled={busy} onClick={() => void act(() => api.del(`/runs/${runId}/share`), t("share.stopped"))}>{t("share.stop")}</Button>}
            </div>
          </form>
          {share && <p className="hint mb-0">{t("share.regenerateHint")}</p>}
          {notice && <div className="mt-3"><Alert kind="ok">{notice}</Alert></div>}
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        </>
      )}
    </Dialog>
  );
}
