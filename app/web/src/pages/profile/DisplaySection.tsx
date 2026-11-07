import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ACCENTS, type Accent, type FontSize, type Theme, type User } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Card, Select, useErrorText } from "../../components/ui";

/** Farbvorschau je Akzent (hell); die vollständigen Werte stehen in styles.css. */
const PREVIEW: Record<Accent, string> = {
  blue: "#2563eb", indigo: "#4f46e5", violet: "#7c3aed", rose: "#be185d", orange: "#c2410c", green: "#15803d", teal: "#0f766e", slate: "#475569",
};

/** Darstellung: Design, Akzentfarbe, Schriftgröße und Erledigte ausblenden – gelten für das ganze Benutzerkonto und wirken sofort. */
export function DisplaySection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { user, setUser } = useAuth();
  const u = user!;
  const [error, setError] = useState<string | null>(null);

  /** Wendet die Änderung sofort an (optimistisch) und stellt bei einem Fehler den alten Stand wieder her. */
  async function change(patch: Partial<Pick<User, "theme" | "accent" | "fontSize" | "hideDone">>) {
    setError(null);
    const before = u;
    setUser({ ...u, ...patch });
    try {
      setUser((await api.put<{ user: User }>("/me", patch)).user);
    } catch (err) {
      setUser(before);
      setError(errorText(err));
    }
  }

  return (
    <Card title={t("profile.display.title")} description={t("profile.display.description")}>
      <Select label={t("profile.display.theme")} value={u.theme} onChange={(e) => void change({ theme: e.target.value as Theme })}>
        <option value="system">{t("profile.display.themeSystem")}</option>
        <option value="light">{t("profile.display.themeLight")}</option>
        <option value="dark">{t("profile.display.themeDark")}</option>
      </Select>

      <fieldset className="m-0 mt-3 border-0 p-0">
        <legend className="label m-0 mb-1 p-0">{t("profile.display.accent")}</legend>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button key={a} type="button" aria-pressed={u.accent === a} aria-label={t(`profile.display.accents.${a}`)} title={t(`profile.display.accents.${a}`)}
              onClick={() => void change({ accent: a })}
              className={`h-9 w-9 cursor-pointer rounded-full border border-border p-0 ${u.accent === a ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : ""}`}
              style={{ backgroundColor: PREVIEW[a] }}>
              {u.accent === a && <span aria-hidden="true" className="text-sm font-bold text-white">✓</span>}
            </button>
          ))}
        </div>
      </fieldset>

      <Select label={t("profile.display.fontSize")} hint={t("profile.display.fontSizeHint")} value={u.fontSize} onChange={(e) => void change({ fontSize: e.target.value as FontSize })}>
        <option value="normal">{t("profile.display.fontNormal")}</option>
        <option value="large">{t("profile.display.fontLarge")}</option>
        <option value="xlarge">{t("profile.display.fontXLarge")}</option>
      </Select>

      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2">
        <input type="checkbox" className="h-4 w-4" checked={u.hideDone} onChange={(e) => void change({ hideDone: e.target.checked })} /> {t("runs.hideDone")}
      </label>

      {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
    </Card>
  );
}
