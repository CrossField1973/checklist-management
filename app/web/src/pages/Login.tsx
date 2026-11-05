import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AuthFrame } from "../components/Layout";
import { Alert, Button, TextInput, useErrorText } from "../components/ui";

export default function Login() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const { config, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ user: User; remaining: number } | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (needCode) codeRef.current?.focus(); }, [needCode]);

  // Fehler aus dem SSO-Ablauf (…/login?error=sso_failed)
  const ssoError = params.get("error");
  const ssoErrorText = ssoError ? (i18n.exists(`errors.${ssoError}`) ? t(`errors.${ssoError}`) : t("errors.sso_failed")) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: User; recoveryCodesRemaining?: number }>("/auth/login", { email, password, ...(needCode && code ? { code } : {}) });
      if (res.recoveryCodesRemaining !== undefined) {
        setRecovery({ user: res.user, remaining: res.recoveryCodesRemaining });
      } else {
        setUser(res.user);
        navigate(from, { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "two_factor_required") {
        setNeedCode(true); // Passwort stimmt: jetzt den Code abfragen
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (recovery) {
    return (
      <AuthFrame title={t("auth.recoveryUsed.title")}>
        <Alert kind="info">{t("auth.recoveryUsed.text", { count: recovery.remaining })}</Alert>
        <Button variant="primary" className="mt-4 w-full" onClick={() => { setUser(recovery.user); navigate(from, { replace: true }); }}>{t("common.continue")}</Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={t("auth.login.title")}
      footer={
        <>
          {config?.registrationEnabled && <p className="m-0">{t("auth.login.noAccount")} <Link className="link" to="/register">{t("auth.login.register")}</Link></p>}
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        {ssoErrorText && <div className="mt-3"><Alert kind="error">{ssoErrorText}</Alert></div>}
        <TextInput label={t("auth.email")} type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} readOnly={needCode} />
        <TextInput label={t("auth.password")} type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} readOnly={needCode} />
        {needCode && (
          <TextInput
            ref={codeRef}
            label={t("auth.twoFactor.label")}
            hint={t("auth.twoFactor.hint")}
            name="code"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy}>{needCode ? t("auth.login.verify") : t("auth.login.submit")}</Button>
        {config?.smtpEnabled && !needCode && <p className="mt-3 mb-0 text-center text-sm"><Link className="link" to="/forgot-password">{t("auth.login.forgot")}</Link></p>}
      </form>

      {config?.oidcEnabled && config.oidcLoginUrl && !needCode && (
        <div className="mt-4 border-t border-border pt-4">
          <a className="btn w-full no-underline" href={config.oidcLoginUrl}>{t("auth.login.sso", { name: config.oidcName ?? "SSO" })}</a>
        </div>
      )}
    </AuthFrame>
  );
}
