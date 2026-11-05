import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ShareInfo } from "../../api/types";
import { Alert, Button, Card, Dialog, Select, Spinner, TextInput, useErrorText } from "../../components/ui";
import { useCopy } from "../../lib/clipboard";

type Dlg = null | { kind: "edit"; share: ShareInfo } | { kind: "revoke"; share: ShareInfo } | { kind: "revokeAll" };

/** F-45: Alle Freigabelinks verwalten – kopieren, Einstellungen ändern, zurückziehen (einzeln oder alle). */
export function SharesSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["shares"], queryFn: () => api.get<{ shares: ShareInfo[] }>("/me/shares") });
  const [dlg, setDlg] = useState<Dlg>(null);
  const [access, setAccess] = useState<"anyone" | "password">("anyone");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const close = () => { setDlg(null); setPassword(""); setError(null); };
  const refresh = () => qc.invalidateQueries({ queryKey: ["shares"] });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await refresh(); close(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const openEdit = (share: ShareInfo) => { setAccess(share.access); setPermission(share.permission); setPassword(""); setDlg({ kind: "edit", share }); };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (dlg?.kind !== "edit") return;
    const id = dlg.share.runId;
    void run(async () => { await api.put(`/runs/${id}/share`, { access, permission, ...(access === "password" && password ? { password } : {}) }); });
  };

  const shares = list.data?.shares ?? [];
  const label = (s: ShareInfo) => `${s.access === "password" ? t("profile.shares.withPassword") : t("profile.shares.anyone")} · ${s.permission === "edit" ? t("profile.shares.edit") : t("profile.shares.view")}`;

  return (
    <Card title={t("profile.shares.title")} description={t("profile.shares.description")}>
      {list.isPending ? <Spinner /> : shares.length === 0 ? <p className="hint m-0">{t("profile.shares.empty")}</p> : (
        <>
          <ul className="m-0 list-none divide-y divide-border p-0">
            {shares.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-semibold">{s.runTitle} {s.runDeleted && <span className="badge">{t("profile.shares.inTrash")}</span>}</p>
                  <p className="hint m-0">{label(s)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.url && <Button size="sm" onClick={() => { void copy(s.url!); setCopiedId(s.id); }}>{copied && copiedId === s.id ? t("common.copied") : t("profile.shares.copyLink")}</Button>}
                  <Button size="sm" onClick={() => openEdit(s)} disabled={s.runDeleted} aria-label={t("profile.shares.settingsFor", { title: s.runTitle })}>{t("profile.shares.settings")}</Button>
                  <Button size="sm" variant="danger" onClick={() => setDlg({ kind: "revoke", share: s })} aria-label={t("profile.shares.revokeFor", { title: s.runTitle })}>{t("profile.shares.revoke")}</Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3"><Button variant="danger" size="sm" onClick={() => setDlg({ kind: "revokeAll" })}>{t("profile.shares.revokeAll")}</Button></div>
        </>
      )}

      <Dialog open={dlg?.kind === "edit"} onClose={close} title={t("profile.shares.settingsTitle")}>
        <form onSubmit={save} noValidate>
          <Select label={t("profile.shares.accessLabel")} value={access} onChange={(e) => setAccess(e.target.value as "anyone" | "password")}>
            <option value="anyone">{t("profile.shares.anyone")}</option>
            <option value="password">{t("profile.shares.withPassword")}</option>
          </Select>
          {access === "password" && <TextInput label={t("profile.shares.password")} hint={t("profile.shares.passwordHint")} type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />}
          <Select label={t("profile.shares.permissionLabel")} value={permission} onChange={(e) => setPermission(e.target.value as "view" | "edit")}>
            <option value="view">{t("profile.shares.view")}</option>
            <option value="edit">{t("profile.shares.edit")}</option>
          </Select>
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy}>{t("common.save")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={dlg?.kind === "revoke" || dlg?.kind === "revokeAll"}
        onClose={close}
        title={dlg?.kind === "revokeAll" ? t("profile.shares.revokeAllTitle") : t("profile.shares.revokeTitle")}
        footer={<>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run(async () => {
            if (dlg?.kind === "revoke") await api.del(`/me/shares/${dlg.share.id}`);
            else await api.del("/me/shares");
          })}>{t("profile.shares.revoke")}</Button>
        </>}
      >
        <p className="m-0">{dlg?.kind === "revoke" ? t("profile.shares.revokeText", { title: dlg.share.runTitle }) : t("profile.shares.revokeAllText", { count: shares.length })}</p>
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
      </Dialog>
    </Card>
  );
}
