import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, Dialog, TextInput, useErrorText } from "../../components/ui";

/** F-52: Konto samt allen Daten endgültig löschen (Passwortbestätigung). */
export function DeleteAccountSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setOpen(false); setPassword(""); setError(null); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.del("/me", { password });
      await logout().catch(() => undefined); // Sitzung ist bereits beendet
      navigate("/login", { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Card title={t("profile.delete.title")} description={t("profile.delete.description")}>
      {user?.hasPassword ? (
        <Button variant="danger" onClick={() => setOpen(true)}>{t("profile.delete.button")}</Button>
      ) : (
        <Alert kind="info">{t("profile.delete.needPassword")}</Alert>
      )}
      <Dialog open={open} onClose={close} title={t("profile.delete.dialogTitle")}>
        <form onSubmit={submit} noValidate>
          <Alert kind="error">{t("profile.delete.warning")}</Alert>
          <TextInput label={t("profile.twoFactor.confirmPassword")} type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" variant="danger" disabled={busy || !password}>{t("profile.delete.confirm")}</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
