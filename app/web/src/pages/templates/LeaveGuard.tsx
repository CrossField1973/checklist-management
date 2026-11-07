import { useEffect, useRef } from "react";
import { useBlocker } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../../components/ui";

/**
 * Fragt nach, bevor die Seite mit ungespeicherten Änderungen verlassen wird (Navigation in der App, Zurück-Taste,
 * Neuladen/Schließen des Tabs). `allowLeave()` vor einer gewollten Navigation (nach dem Speichern) aufrufen.
 */
export function useLeaveGuard(dirty: boolean) {
  const { t } = useTranslation();
  const allowed = useRef(false);
  const blocker = useBlocker(() => dirty && !allowed.current);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { if (!allowed.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const dialog = (
    <Dialog open={blocker.state === "blocked"} onClose={() => blocker.reset?.()} title={t("leave.title")}
      footer={<LeaveButtons onStay={() => blocker.reset?.()} onLeave={() => blocker.proceed?.()} />}>
      <p className="m-0">{t("leave.text")}</p>
    </Dialog>
  );
  return { dialog, allowLeave: () => { allowed.current = true; } };
}

function LeaveButtons({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Button variant="primary" onClick={onStay}>{t("leave.stay")}</Button>
      <Button variant="danger" onClick={onLeave}>{t("leave.leave")}</Button>
    </>
  );
}
