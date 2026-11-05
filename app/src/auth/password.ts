import { createHash } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Config } from "../config.js";
import { COMMON_PASSWORDS } from "./common-passwords.js";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "too_common" | "contains_identity" | "breached";

/** argon2id mit den Standardparametern der Bibliothek (OWASP-konform). */
export const hashPassword = (password: string) => hash(password);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Gültiger Hash, gegen den bei unbekannter E-Mail geprüft wird, damit die Antwortzeit nicht verrät, ob ein Konto existiert.
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}

const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertzuiopasdfghjklyxcvbnm", "qwertyuiopasdfghjklzxcvbnm"];

function normalize(password: string): string {
  return password.toLowerCase().replace(/[\s._-]+/g, "");
}

function isTrivial(password: string): boolean {
  const n = normalize(password);
  if (COMMON_PASSWORDS.has(n)) return true;
  if (/^(.)\1+$/.test(n)) return true; // aaaaaaaaaaaa
  if (new Set(n).size <= 3) return true; // abababababab
  const reversed = [...n].reverse().join("");
  return SEQUENCES.some((s) => s.includes(n) || s.includes(reversed));
}

function containsIdentity(password: string, identity: { email: string; displayName?: string }): boolean {
  const p = password.toLowerCase();
  const parts = new Set<string>();
  const local = identity.email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4) parts.add(local);
  for (const w of (identity.displayName ?? "").toLowerCase().split(/\s+/)) if (w.length >= 4) parts.add(w);
  return [...parts].some((x) => p.includes(x));
}

/** Prüft das Passwort gegen HIBP (k-Anonymität: nur die ersten 5 Zeichen des SHA-1 verlassen den Server). */
export async function isBreachedHibp(password: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`HIBP antwortete mit ${res.status}`);
  const body = await res.text();
  return body.split("\n").some((line) => {
    const [s, count] = line.trim().split(":");
    return s === suffix && Number(count) > 0;
  });
}

export interface PolicyContext {
  email: string;
  displayName?: string;
}

/**
 * Passwort-Richtlinie nach NIST SP 800-63B / OWASP (F-03): Länge statt Zusammensetzungsregeln,
 * Ablehnung trivialer, häufiger und (optional) bekannt kompromittierter Passwörter.
 */
export async function checkPasswordPolicy(
  password: string,
  ctx: PolicyContext,
  mode: Config["PASSWORD_BREACH_CHECK"],
  hibp: (pw: string) => Promise<boolean> = isBreachedHibp,
): Promise<PasswordProblem[]> {
  const len = [...password].length; // Unicode-Zeichen statt UTF-16-Einheiten
  if (len < PASSWORD_MIN_LENGTH) return ["too_short"];
  if (len > PASSWORD_MAX_LENGTH) return ["too_long"];
  const problems: PasswordProblem[] = [];
  if (isTrivial(password)) problems.push("too_common");
  if (containsIdentity(password, ctx)) problems.push("contains_identity");
  if (mode === "hibp" && problems.length === 0) {
    try {
      if (await hibp(password)) problems.push("breached");
    } catch {
      // Dienst nicht erreichbar: lokale Prüfung gilt (kein Login-Blocker bei Offline-Betrieb).
    }
  }
  return problems;
}
