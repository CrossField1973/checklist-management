import { PasswordSection } from "./PasswordSection";
import { TwoFactorSection } from "./TwoFactorSection";

/** Bereich „Sicherheit“: Passwort ändern und Zwei-Faktor-Anmeldung. */
export function SecurityPage() {
  return (
    <div className="grid gap-4">
      <PasswordSection />
      <TwoFactorSection />
    </div>
  );
}
