import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "../components/ui";
import { restoreCache, startPersisting } from "./persist";
import { flushQueue, loadQueue, useQueue, type FlushResult } from "./queue";
import { useOnline } from "./useOnline";

/**
 * Im geschützten Bereich eingebunden: stellt den lokalen Datenbestand her, hält ihn aktuell, überträgt wartende Änderungen
 * (bei Verbindung, beim Start und alle 30 s) und informiert über Offline-Betrieb, Übertragung und Konflikte.
 */
export function OfflineManager({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const online = useOnline();
  const ops = useQueue();
  const [report, setReport] = useState<FlushResult | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      await restoreCache(qc, userId);
      await loadQueue(userId);
      if (!cancelled) stop = startPersisting(qc, userId);
    })();
    return () => { cancelled = true; stop?.(); };
  }, [qc, userId]);

  useEffect(() => {
    if (!online || ops.length === 0) return;
    const run = async () => {
      const res = await flushQueue();
      if (!mounted.current || (res.done.length === 0 && res.conflicts.length === 0)) return;
      setReport((old) => ({ done: [...(old?.done ?? []), ...res.done], conflicts: [...(old?.conflicts ?? []), ...res.conflicts] }));
      await Promise.all(["run", "runs"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    };
    void run();
    const timer = setInterval(() => void run(), 30_000);
    return () => clearInterval(timer);
  }, [online, ops.length, qc]);

  const showSynced = report && report.done.length > 0 && report.conflicts.length === 0 && ops.length === 0;
  if (online && ops.length === 0 && !showSynced && !report?.conflicts.length) return null;
  return (
    <div className="mb-4 grid gap-2">
      {!online && <Alert kind="info">{t("offline.offline")}{ops.length > 0 && ` ${t("offline.pending", { count: ops.length })}`}</Alert>}
      {online && ops.length > 0 && <Alert kind="info">{t("offline.syncing", { count: ops.length })}</Alert>}
      {showSynced && (
        <Alert kind="ok">{t("offline.synced", { count: report.done.length })} <Button size="sm" onClick={() => setReport(null)}>{t("offline.dismiss")}</Button></Alert>
      )}
      {report && report.conflicts.length > 0 && (
        <Alert kind="error">
          <p className="m-0 font-semibold">{t("offline.conflicts", { count: report.conflicts.length })}</p>
          <ul className="my-1">{report.conflicts.map((c) => <li key={c.op.id}>{c.op.label} – {t(`offline.reason.${c.error}`, { defaultValue: t("offline.reason.default") })}</li>)}</ul>
          <Button size="sm" onClick={() => setReport(null)}>{t("offline.dismiss")}</Button>
        </Alert>
      )}
    </div>
  );
}
