import { createHmac, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Config } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { verifyTotp } from "./totp.js";

export type User = typeof schema.users.$inferSelect;
export const RECOVERY_CODE_COUNT = 10;
const TOTP_PURPOSE = "totp-secret";
// ohne leicht verwechselbare Zeichen (0/O, 1/I/L)
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const isTwoFactorEnabled = (u: Pick<User, "totpEnabledAt">) => u.totpEnabledAt !== null;
export const sealSecret = (secret: string, config: Pick<Config, "SESSION_SECRET">) => encrypt(secret, config.SESSION_SECRET, TOTP_PURPOSE);
export const openSecret = (user: Pick<User, "totpSecret">, config: Pick<Config, "SESSION_SECRET">) =>
  user.totpSecret ? decrypt(user.totpSecret, config.SESSION_SECRET, TOTP_PURPOSE) : null;

// ---------- Wiederherstellungscodes ----------
/** Normalisiert Eingaben wie „abcde-fghjk“ oder „abcde fghjk“ zu „ABCDEFGHJK“. */
export const normalizeRecoveryCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, "");
/** Mit serverseitigem Geheimnis gehasht (HMAC): ohne SESSION_SECRET ist selbst bei Datenbank-Diebstahl kein Durchprobieren möglich. */
const hashCode = (code: string, config: Pick<Config, "SESSION_SECRET">) =>
  createHmac("sha256", config.SESSION_SECRET).update("recovery:" + normalizeRecoveryCode(code)).digest("hex");

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const part = () => Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return Array.from({ length: count }, () => `${part()}-${part()}`);
}

/** Ersetzt alle Wiederherstellungscodes des Nutzers durch neue; gibt die Klartext-Codes (einmalig) zurück. */
export function replaceRecoveryCodes(db: Db, config: Pick<Config, "SESSION_SECRET">, userId: string): string[] {
  const codes = generateRecoveryCodes();
  db.transaction((tx) => {
    tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId)).run();
    for (const c of codes) tx.insert(schema.recoveryCodes).values({ userId, codeHash: hashCode(c, config) }).run();
  });
  return codes;
}

export const remainingRecoveryCodes = (db: Db, userId: string) =>
  db.select().from(schema.recoveryCodes).where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt))).all().length;

/** Verbraucht einen Wiederherstellungscode (einmalig verwendbar). */
function consumeRecoveryCode(db: Db, config: Pick<Config, "SESSION_SECRET">, userId: string, input: string): boolean {
  if (!/^[A-Z0-9]{10}$/.test(normalizeRecoveryCode(input))) return false;
  return db.update(schema.recoveryCodes).set({ usedAt: Date.now() })
    .where(and(eq(schema.recoveryCodes.userId, userId), eq(schema.recoveryCodes.codeHash, hashCode(input, config)), isNull(schema.recoveryCodes.usedAt)))
    .run().changes === 1;
}

export type SecondFactorResult = { ok: true; method: "totp" | "recovery" } | { ok: false };

/**
 * Prüft den zweiten Faktor: 6-stelliger Authenticator-Code oder Wiederherstellungscode.
 * Ein TOTP-Code ist nur einmal verwendbar (Replay-Schutz, atomar über den zuletzt akzeptierten Zeitschritt).
 */
export function checkSecondFactor(db: Db, config: Pick<Config, "SESSION_SECRET">, user: User, input: string, now = Date.now()): SecondFactorResult {
  const code = input.trim();
  if (/^\d{6}$/.test(code)) {
    const secret = openSecret(user, config);
    if (!secret) return { ok: false };
    const step = verifyTotp(secret, code, now, user.totpLastStep);
    if (step === null) return { ok: false };
    // atomare Übernahme: nur wenn noch kein gleicher oder neuerer Schritt akzeptiert wurde
    const changed = db.sqlite.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)").run(step, user.id, step).changes;
    return changed === 1 ? { ok: true, method: "totp" } : { ok: false };
  }
  return consumeRecoveryCode(db, config, user.id, code) ? { ok: true, method: "recovery" } : { ok: false };
}

