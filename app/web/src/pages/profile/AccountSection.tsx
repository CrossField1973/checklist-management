import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Language, Theme, User } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, Select, TextInput, useErrorText } from "../../components/ui";

const RETENTION = ["7", "30", "90", "365", "never"] as const;
const toRetention = (days: number | null) => (days === null ? "never" : String(days));

/** F-05: Anzeigename, E-Mail, Sprache, Design, Aufbewahrung des Papierkorbs. */
export function AccountSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { user, setUser } = useAuth();
  const u = user!;
  const [displayName, setDisplayName] = useState(u.displayName);
  const [email, setEmail] = useState(u.email);
  const [language, setLanguage] = useState<Language>(u.language);
  const [theme, setTheme] = useState<Theme>(u.theme);
  const [retention, setRetention] = useState(toRetention(u.trashRetentionDays));
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== u.email;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.put<{ user: User }>("/me", {
        displayName, language, theme,
        trashRetentionDays: retention === "never" ? null : Number(retention),
        ...(emailChanged ? { email, currentPassword } : {}),
      });
      setUser(res.user); // Sprache und Design wirken sofort
      setCurrentPassword("");
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("profile.account.title")}>
      <form onSubmit={submit} noValidate>
        <TextInput label={t("auth.displayName")} name="displayName" autoComplete="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextInput label={t("auth.email")} type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {emailChanged && u.hasPassword && (
          <TextInput label={t("profile.account.passwordForEmail")} hint={t("profile.account.passwordForEmailHint")} type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        )}
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Select label={t("profile.account.language")} value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </Select>
          <Select label={t("profile.account.theme")} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">{t("profile.account.themeSystem")}</option>
            <option value="light">{t("profile.account.themeLight")}</option>
            <option value="dark">{t("profile.account.themeDark")}</option>
          </Select>
        </div>
        <Select label={t("profile.account.trash")} hint={t("profile.account.trashHint")} value={retention} onChange={(e) => setRetention(e.target.value)}>
          {RETENTION.map((r) => <option key={r} value={r}>{r === "never" ? t("profile.account.trashNever") : t("profile.account.trashDays", { count: Number(r) })}</option>)}
        </Select>
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        {saved && <div className="mt-3"><Alert kind="ok">{t("common.saved")}</Alert></div>}
        <Button type="submit" variant="primary" className="mt-4" disabled={busy}>{t("common.save")}</Button>
      </form>
    </Card>
  );
}
