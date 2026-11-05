import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AuthFrame } from "../components/Layout";
import { Alert, Button, Spinner, TextInput, useErrorText } from "../components/ui";

export default function Register() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { config, setUser } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!config) return <AuthFrame title={t("auth.register.title")}><Spinner /></AuthFrame>;
  const back = <Link className="link" to="/login">{t("auth.backToLogin")}</Link>;

  if (!config.registrationEnabled) {
    return (
      <AuthFrame title={t("auth.register.title")} footer={back}>
        <div className="mt-3"><Alert kind="info">{t("auth.register.disabled")}</Alert></div>
      </AuthFrame>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: User }>("/auth/register", { displayName, email, password });
      setUser(res.user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title={t("auth.register.title")} footer={back}>
      <form onSubmit={submit} noValidate>
        <TextInput label={t("auth.displayName")} name="name" autoComplete="name" required autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextInput label={t("auth.email")} type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput label={t("auth.password")} type="password" name="password" autoComplete="new-password" required minLength={12} hint={t("auth.passwordHint")} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy}>{t("auth.register.submit")}</Button>
      </form>
    </AuthFrame>
  );
}
