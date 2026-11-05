import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui";
import { AccountSection } from "./AccountSection";
import { DataSection } from "./DataSection";
import { DeleteAccountSection } from "./DeleteAccountSection";
import { PasswordSection } from "./PasswordSection";
import { SharesSection } from "./SharesSection";
import { SsoSection } from "./SsoSection";
import { TokensSection } from "./TokensSection";
import { TwoFactorSection } from "./TwoFactorSection";

/** F-05: Benutzerprofil mit Konto, Sicherheit, Zugriff (Token, Freigaben) und Daten. */
export default function Profile() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  return (
    <>
      <h1 className="mt-0 text-2xl font-semibold">{t("nav.profile")}</h1>
      {params.get("sso") === "linked" && <div className="mb-4"><Alert kind="ok">{t("profile.sso.justLinked")}</Alert></div>}
      <div className="grid gap-4">
        <AccountSection />
        <PasswordSection />
        <TwoFactorSection />
        <SsoSection />
        <TokensSection />
        <SharesSection />
        <DataSection />
        <DeleteAccountSection />
      </div>
    </>
  );
}
