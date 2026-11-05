/** Minimaler Schlüssel-Wert-Speicher auf IndexedDB. Ist IndexedDB nicht verfügbar (z. B. privater Modus), arbeiten alle Funktionen als Leerlauf. */
const DB = "checklisten-offline";
const STORE = "kv";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export const kvGet = <T>(key: string) => run<T>("readonly", (s) => s.get(key) as IDBRequest<T>);
export const kvSet = (key: string, value: unknown) => run("readwrite", (s) => s.put(value, key)).then(() => undefined);
export const kvDel = (key: string) => run("readwrite", (s) => s.delete(key)).then(() => undefined);
