import { AccountSection } from "./AccountSection";
import { DeleteAccountSection } from "./DeleteAccountSection";

/** Bereich „Konto“: Profildaten und Konto löschen untereinander. */
export function AccountPage() {
  return (
    <div className="grid gap-4">
      <AccountSection />
      <DeleteAccountSection />
    </div>
  );
}
