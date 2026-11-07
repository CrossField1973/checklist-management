import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { kvDel, kvGet, kvSet } from "./idb";
import { resetQueue } from "./queue";

/** Nur diese Abfragen bleiben offline verfügbar (F-74). Freigabe-Links und Kontodaten gehören bewusst nicht dazu. */
const OFFLINE_KEYS = new Set(["runs", "run", "templates", "template", "tags"]);
/** Bei geänderter Form der Antworten erhöhen: ein älterer Zwischenspeicher wird dann verworfen statt angezeigt. */
const CACHE_VERSION = 2;
interface Saved { version?: number; userId: string; savedAt: number; state: ReturnType<typeof dehydrate> }

let stopCurrent: (() => void) | null = null;

/** Stellt den zwischengespeicherten Datenbestand wieder her – nur für denselben Nutzer. */
export async function restoreCache(qc: QueryClient, userId: string) {
  const saved = await kvGet<Saved>("cache");
  if (!saved) return;
  if (saved.userId !== userId || saved.version !== CACHE_VERSION) return void (await kvDel("cache"));
  hydrate(qc, saved.state);
}

/** Schreibt Änderungen am Zwischenspeicher (verzögert gebündelt) nach IndexedDB. Gibt eine Funktion zum Beenden zurück. */
export function startPersisting(qc: QueryClient, userId: string): () => void {
  stopCurrent?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const state = dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.status === "success" && OFFLINE_KEYS.has(String(q.queryKey[0])) });
      void kvSet("cache", { version: CACHE_VERSION, userId, savedAt: Date.now(), state } satisfies Saved);
    }, 800);
  };
  const unsubscribe = qc.getQueryCache().subscribe(save);
  const stop = () => { unsubscribe(); clearTimeout(timer); if (stopCurrent === stop) stopCurrent = null; };
  stopCurrent = stop;
  save();
  return stop;
}

/** Entfernt alle lokal gespeicherten Daten (Abmeldung, Sitzungsende). */
export async function clearOfflineData() {
  stopCurrent?.();
  resetQueue();
  await Promise.all([kvDel("cache"), kvDel("queue"), kvDel("user")]);
}
