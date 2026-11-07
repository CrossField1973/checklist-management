import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui";
import { AccountPage } from "./AccountPage";
import { DisplaySection } from "./DisplaySection";
import { DataSection } from "./DataSection";
import { SharesSection } from "./SharesSection";
import { SsoSection } from "./SsoSection";
import { TagsSection } from "./TagsSection";
import { TokensSection } from "./TokensSection";
import { SecurityPage } from "./SecurityPage";
import { ShortcutsSection } from "./ShortcutsSection";

const SECTIONS = [
  { id: "account", titleKey: "profile.account.title", Component: AccountPage },
  { id: "display", titleKey: "profile.display.title", Component: DisplaySection },
  { id: "tags", titleKey: "profile.tags.title", Component: TagsSection },
  { id: "security", titleKey: "profile.security.title", Component: SecurityPage },
  { id: "sso", titleKey: "profile.sso.title", Component: SsoSection },
  { id: "tokens", titleKey: "profile.tokens.title", Component: TokensSection },
  { id: "shares", titleKey: "profile.shares.title", Component: SharesSection },
  { id: "shortcuts", titleKey: "shortcuts.title", Component: ShortcutsSection },
  { id: "data", titleKey: "profile.data.title", Component: DataSection },
] as const;

/** F-05: Benutzerprofil zweigeteilt – links die Bereiche, rechts der gewählte Inhalt (Adresse: /profile?section=…). */
export default function Profile() {
  const { t } = useTranslation();
  const { config } = useAuth();
  const [params, setParams] = useSearchParams();
  const sections = SECTIONS.filter((s) => s.id !== "sso" || config?.oidcEnabled);
  const requested = params.get("section") ?? (params.get("sso") === "linked" ? "sso" : "account");
  const current = sections.find((s) => s.id === requested) ?? sections[0]!;
  const Current = current.Component;

  return (
    <>
      <h1 className="mt-0 text-2xl font-semibold">{t("nav.profile")}</h1>
      {params.get("sso") === "linked" && <div className="mb-4"><Alert kind="ok">{t("profile.sso.justLinked")}</Alert></div>}
      <div className="grid gap-4 md:grid-cols-[200px_1fr] md:items-start">
        <nav aria-label={t("nav.profileSections")}>
          <ul className="m-0 flex list-none flex-row flex-wrap gap-1 p-0 md:flex-col">
            {sections.map((s) => {
              const active = s.id === current.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setParams({ section: s.id })}
                    className={`w-full cursor-pointer rounded-lg border-0 px-3 py-2 text-left text-[inherit] ${active ? "bg-soft font-semibold text-primary" : "bg-transparent text-text hover:bg-bg"}`}
                  >
                    {t(s.titleKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div>
          <Current />
        </div>
      </div>
    </>
  );
}
