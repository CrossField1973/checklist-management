import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { TwoFactorSetup, TwoFactorStatus, User } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";
import { saveTextFile, useCopy } from "../../lib/clipboard";

/** Wiederherstellungscodes: nur einmal sichtbar – Kopieren/Speichern anbieten und Bestätigung verlangen. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");
  return (
    <>
      <Alert kind="info">{t("profile.twoFactor.recoveryIntro")}</Alert>
      <ul className="code-box mono my-3 grid list-none grid-cols-2 gap-x-4 gap-y-1 p-3" aria-label={t("profile.twoFactor.recoveryList")}>
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copy(text)}>{copied ? t("common.copied") : t("common.copy")}</Button>
        <Button size="sm" onClick={() => saveTextFile("wiederherstellungscodes.txt", text + "\n")}>{t("profile.twoFactor.download")}</Button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("profile.twoFactor.recoverySaved")}</span>
      </label>
      <div className="mt-4 flex justify-end"><Button variant="primary" disabled={!saved} onClick={onDone}>{t("common.done")}</Button></div>
    </>
  );
}

type Flow = null | "setup" | "disable" | "regenerate";
/** Solange Wiederherstellungscodes angezeigt werden, lässt sich der Dialog nur über „Fertig“ schließen (sonst gingen sie verloren). */
const noop = () => undefined;

/** F-08: Zwei-Faktor-Authentifizierung per Authenticator-App. */
export function TwoFactorSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const status = useQuery({ queryKey: ["2fa"], queryFn: () => api.get<TwoFactorStatus>("/me/2fa") });
  const [flow, setFlow] = useState<Flow>(null);

  // gemeinsamer Zustand der Dialoge
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();

  const hasPassword = user?.hasPassword ?? false;
  const close = () => {
    setFlow(null); setPassword(""); setCode(""); setSetup(null); setRecoveryCodes(null); setError(null);
    void qc.invalidateQueries({ queryKey: ["2fa"] });
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  const startSetup = (e: FormEvent) => { e.preventDefault(); void run(async () => setSetup(await api.post<TwoFactorSetup>("/me/2fa/setup", hasPassword ? { password } : {}))); };
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.post<{ recoveryCodes: string[]; user: User }>("/me/2fa/enable", { code });
      setUser(res.user);
      setRecoveryCodes(res.recoveryCodes);
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post("/me/2fa/disable", { ...(hasPassword ? { password } : {}), code });
      if (user) setUser({ ...user, twoFactorEnabled: false });
      close();
    });
  };
  const regenerate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => setRecoveryCodes((await api.post<{ recoveryCodes: string[] }>("/me/2fa/recovery-codes", { ...(hasPassword ? { password } : {}), code })).recoveryCodes));
  };

  if (status.isPending) return <Card title={t("profile.twoFactor.title")}><Spinner /></Card>;
  const enabled = status.data?.enabled ?? false;

  return (
    <Card title={t("profile.twoFactor.title")} description={t("profile.twoFactor.description")}>
      {enabled ? (
        <>
          <Alert kind="ok">{t("profile.twoFactor.enabled", { count: status.data?.recoveryCodesRemaining ?? 0 })}</Alert>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => setFlow("regenerate")}>{t("profile.twoFactor.regenerate")}</Button>
            <Button variant="danger" onClick={() => setFlow("disable")}>{t("profile.twoFactor.disable")}</Button>
          </div>
        </>
      ) : (
        <Button variant="primary" onClick={() => setFlow("setup")}>{t("profile.twoFactor.setup")}</Button>
      )}

      {/* Einrichten: Passwort → QR-Code und Code → Wiederherstellungscodes */}
      <Dialog open={flow === "setup"} onClose={recoveryCodes ? noop : close} title={t("profile.twoFactor.setupTitle")}>
        {recoveryCodes ? (
          <RecoveryCodes codes={recoveryCodes} onDone={close} />
        ) : setup ? (
          <form onSubmit={enable} noValidate>
            <ol className="m-0 list-decimal space-y-2 pl-5 text-sm">
              <li>{t("profile.twoFactor.step1")}</li>
              <li>{t("profile.twoFactor.step2")}</li>
            </ol>
            <div className="my-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="rounded-lg bg-white p-2" aria-hidden="true"><QRCodeSVG value={setup.otpauthUrl} size={160} /></div>
              <div className="min-w-0 flex-1">
                <p className="hint m-0">{t("profile.twoFactor.manualKey")}</p>
                <p className="code-box mono mt-1 mb-2" data-testid="totp-secret">{setup.secret}</p>
                <Button size="sm" onClick={() => void copy(setup.secret)}>{copied ? t("common.copied") : t("common.copy")}</Button>
              </div>
            </div>
            <TextInput label={t("profile.twoFactor.codeLabel")} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={close}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>{t("profile.twoFactor.activate")}</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={startSetup} noValidate>
            <p className="m-0 text-sm">{t("profile.twoFactor.setupIntro")}</p>
            {hasPassword && <TextInput label={t("profile.twoFactor.confirmPassword")} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
            {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={close}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" disabled={busy || (hasPassword && !password)}>{t("common.next")}</Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Deaktivieren und Codes erneuern: Passwort + gültiger Code */}
      <Dialog open={flow === "disable" || flow === "regenerate"} onClose={recoveryCodes ? noop : close} title={flow === "disable" ? t("profile.twoFactor.disableTitle") : t("profile.twoFactor.regenerateTitle")}>
        {recoveryCodes ? (
          <RecoveryCodes codes={recoveryCodes} onDone={close} />
        ) : (
          <form onSubmit={flow === "disable" ? disable : regenerate} noValidate>
            <p className="m-0 text-sm">{flow === "disable" ? t("profile.twoFactor.disableIntro") : t("profile.twoFactor.regenerateIntro")}</p>
            {hasPassword && <TextInput label={t("profile.twoFactor.confirmPassword")} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
            <TextInput label={t("auth.twoFactor.label")} hint={t("auth.twoFactor.hint")} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={close}>{t("common.cancel")}</Button>
              <Button type="submit" variant={flow === "disable" ? "danger" : "primary"} disabled={busy || !code || (hasPassword && !password)}>
                {flow === "disable" ? t("profile.twoFactor.disable") : t("profile.twoFactor.regenerate")}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
