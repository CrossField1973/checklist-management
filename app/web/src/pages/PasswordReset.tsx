import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { AuthFrame } from "../components/Layout";
import { Alert, Button, Spinner, TextInput, useErrorText } from "../components/ui";

const back = (label: string) => <Link className="link" to="/login">{label}</Link>;

/** „Passwort vergessen“: antwortet immer gleich, damit nicht erkennbar ist, ob eine E-Mail existiert. */
export function ForgotPassword() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { config } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!config) return <AuthFrame title={t("auth.forgot.title")}><Spinner /></AuthFrame>;
  if (!config.smtpEnabled) {
    return (
      <AuthFrame title={t("auth.forgot.title")} footer={back(t("auth.backToLogin"))}>
        <div className="mt-3"><Alert kind="info">{t("auth.forgot.unavailable")}</Alert></div>
      </AuthFrame>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title={t("auth.forgot.title")} footer={back(t("auth.backToLogin"))}>
      {sent ? (
        <div className="mt-3"><Alert kind="ok">{t("auth.forgot.sent")}</Alert></div>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="hint mb-0">{t("auth.forgot.intro")}</p>
          <TextInput label={t("auth.email")} type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
          <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy}>{t("auth.forgot.submit")}</Button>
        </form>
      )}
    </AuthFrame>
  );
}

/** Neues Passwort setzen über den Link aus der E-Mail (`/reset-password?token=…`). */
export function ResetPassword() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return <AuthFrame title={t("auth.reset.title")} footer={back(t("auth.backToLogin"))}><div className="mt-3"><Alert kind="error">{t("auth.reset.noToken")}</Alert></div></AuthFrame>;
  }
  if (done) {
    return (
      <AuthFrame title={t("auth.reset.title")}>
        <div className="mt-3"><Alert kind="ok">{t("auth.reset.done")}</Alert></div>
        <Link className="btn btn-primary mt-4 w-full no-underline" to="/login">{t("auth.login.submit")}</Link>
      </AuthFrame>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError(t("errors.password_mismatch"));
    setBusy(true);
    try {
      await api.post("/auth/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "invalid_or_expired_token" ? t("auth.reset.invalidToken") : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title={t("auth.reset.title")} footer={back(t("auth.backToLogin"))}>
      <form onSubmit={submit} noValidate>
        <TextInput label={t("auth.newPassword")} type="password" name="password" autoComplete="new-password" required autoFocus minLength={12} hint={t("auth.passwordHint")} value={password} onChange={(e) => setPassword(e.target.value)} />
        <TextInput label={t("auth.confirmPassword")} type="password" name="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy}>{t("auth.reset.submit")}</Button>
      </form>
    </AuthFrame>
  );
}
