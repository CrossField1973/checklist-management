import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, TextInput, useErrorText } from "../../components/ui";

/** F-06: Passwort ändern. Nach der Änderung sind alle anderen Sitzungen abgemeldet. */
export function PasswordSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user?.hasPassword) {
    return <Card title={t("profile.password.title")}><Alert kind="info">{t("profile.password.none")}</Alert></Card>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) return setError(t("errors.password_mismatch"));
    setBusy(true);
    try {
      await api.post("/me/password", { currentPassword: current, newPassword: next });
      setCurrent(""); setNext(""); setConfirm("");
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("profile.password.title")} description={t("profile.password.description")}>
      <form onSubmit={submit} noValidate>
        <TextInput label={t("profile.password.current")} type="password" name="current" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextInput label={t("auth.newPassword")} type="password" name="new" autoComplete="new-password" required hint={t("auth.passwordHint")} value={next} onChange={(e) => setNext(e.target.value)} />
        <TextInput label={t("auth.confirmPassword")} type="password" name="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        {done && <div className="mt-3"><Alert kind="ok">{t("profile.password.done")}</Alert></div>}
        <Button type="submit" variant="primary" className="mt-4" disabled={busy}>{t("profile.password.submit")}</Button>
      </form>
    </Card>
  );
}
