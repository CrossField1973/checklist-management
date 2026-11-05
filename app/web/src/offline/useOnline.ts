import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
};
/** Verbindungsstatus des Geräts (navigator.onLine); „online“ heißt nicht zwingend, dass der Server erreichbar ist. */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
