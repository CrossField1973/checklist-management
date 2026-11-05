import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { SsoStatus } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";

/** F-09: Konto mit dem Identitätsanbieter (SSO) verknüpfen oder die Verknüpfung lösen. Nur sichtbar, wenn SSO konfiguriert ist. */
export function SsoSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { config, user } = useAuth();
  const status = useQuery({ queryKey: ["sso"], queryFn: () => api.get<SsoStatus>("/me/sso"), enabled: config?.oidcEnabled ?? false });
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!config?.oidcEnabled) return null;
  if (status.isPending) return <Card title={t("profile.sso.title")}><Spinner /></Card>;
  const name = status.data?.name ?? config.oidcName ?? "SSO";
  const linked = status.data?.linked ?? false;

  const close = () => { setOpen(false); setPassword(""); setError(null); };
  async function unlink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/me/sso/unlink", { password });
      await qc.invalidateQueries({ queryKey: ["sso"] });
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("profile.sso.title")} description={t("profile.sso.description", { name })}>
      {linked ? (
        <>
          <Alert kind="ok">{t("profile.sso.linked", { name })}</Alert>
          <div className="mt-3">
            {user?.hasPassword
              ? <Button variant="danger" onClick={() => setOpen(true)}>{t("profile.sso.unlink")}</Button>
              : <p className="hint m-0">{t("profile.sso.needPassword")}</p>}
          </div>
        </>
      ) : (
        // Vollständiger Seitenwechsel: der Ablauf läuft über den Anbieter und kehrt zur App zurück
        <a className="btn btn-primary no-underline" href={`${config.oidcLoginUrl ?? "/api/v1/auth/oidc/login"}?link=1`}>{t("profile.sso.link", { name })}</a>
      )}

      <Dialog open={open} onClose={close} title={t("profile.sso.unlinkTitle", { name })}>
        <form onSubmit={unlink} noValidate>
          <p className="m-0 text-sm">{t("profile.sso.unlinkIntro")}</p>
          <TextInput label={t("profile.twoFactor.confirmPassword")} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" variant="danger" disabled={busy || !password}>{t("profile.sso.unlink")}</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
