import { newId } from "../lib/id";
import { useSyncExternalStore } from "react";
import { ApiError, api } from "../api/client";
import { kvDel, kvGet, kvSet } from "./idb";

/**
 * Änderungswarteschlange (F-74): Änderungen an Durchführungen, die ohne Verbindung gemacht wurden, werden hier gesammelt
 * und in Reihenfolge an den Server gesendet, sobald er wieder erreichbar ist.
 * Unterstützt: Abhaken (setzt einen festen Wert, daher gefahrlos wiederholbar) und Hinzufügen von Punkten.
 */
type Base = { id: string; runId: string; /** Anzeigename für Meldungen */ label: string; at: number };
export type Op = Base & (
  | { kind: "check"; itemId: string; checked: boolean }
  | { kind: "add"; sectionId: string; parentItemId: string | null; title: string; tempId: string }
);
export type NewOp =
  | { kind: "check"; runId: string; label: string; itemId: string; checked: boolean }
  | { kind: "add"; runId: string; label: string; sectionId: string; parentItemId: string | null; title: string; tempId: string };

let state: { userId: string | null; ops: Op[] } = { userId: null, ops: [] };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const publish = (ops: Op[]) => {
  state = { ...state, ops };
  void kvSet("queue", state);
  notify();
};

export const getOps = () => state.ops;
export const subscribeQueue = (l: () => void) => { listeners.add(l); return () => void listeners.delete(l); };
export const useQueue = () => useSyncExternalStore(subscribeQueue, getOps, getOps);

/** Lädt die gespeicherte Warteschlange – nur, wenn sie zum angemeldeten Nutzer gehört. */
export async function loadQueue(userId: string) {
  const saved = await kvGet<typeof state>("queue");
  const mine = saved && saved.userId === userId ? saved.ops : [];
  state = { userId, ops: [...mine, ...state.ops.filter((o) => !mine.some((s) => s.id === o.id))] };
  if (saved && saved.userId !== userId) await kvDel("queue");
  notify();
}

export function resetQueue() {
  state = { userId: null, ops: [] };
  notify();
}

export function enqueue(op: NewOp) {
  const full = { ...op, id: newId(), at: Date.now() } as Op;
  // Mehrfaches Umschalten desselben Punkts: nur der letzte Wert zählt
  const kept = full.kind === "check" ? state.ops.filter((o) => !(o.kind === "check" && o.itemId === full.itemId)) : state.ops;
  publish([...kept, full]);
}

export interface FlushResult { done: Op[]; conflicts: { op: Op; error: string }[]; }

const send = (op: Op) =>
  op.kind === "check"
    ? api.put(`/run-items/${op.itemId}`, { isChecked: op.checked })
    : api.post(`/run-sections/${op.sectionId}/items`, { title: op.title, parentItemId: op.parentItemId });

let flushing = false;

/**
 * Sendet die Warteschlange der Reihe nach.
 * - Erfolg → Eintrag entfällt.
 * - Keine Verbindung oder Serverfehler (5xx) → Abbruch, der Rest bleibt für den nächsten Versuch.
 * - Ablehnung durch den Server (404 Punkt/Abschnitt/Durchführung gelöscht, 409 archiviert …) → Konflikt: wird gemeldet und verworfen.
 */
export async function flushQueue(transport: (op: Op) => Promise<unknown> = send): Promise<FlushResult> {
  const result: FlushResult = { done: [], conflicts: [] };
  if (flushing) return result;
  flushing = true;
  try {
    for (const op of [...state.ops]) {
      try {
        await transport(op);
        result.done.push(op);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) break;
        result.conflicts.push({ op, error: err.code });
      }
      publish(state.ops.filter((o) => o.id !== op.id));
    }
  } finally {
    flushing = false;
  }
  return result;
}
