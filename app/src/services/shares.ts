import { and, eq, isNull } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { randomToken, sha256 } from "../auth/session.js";
import type { Config } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

export type Share = typeof schema.runShares.$inferSelect;
export interface ShareSettings { access: "anyone" | "password"; permission: "view" | "edit"; password?: string }

const PURPOSE = "share-token";

export const shareUrl = (config: Config, token: string) => `${config.APP_BASE_URL.replace(/\/$/, "")}/s/${token}`;

/** Gibt den Link zurück, sofern der verschlüsselte Token lesbar ist (sonst null). */
export function linkOf(config: Config, share: Share): string | null {
  const token = share.tokenEnc ? decrypt(share.tokenEnc, config.SESSION_SECRET, PURPOSE) : null;
  return token ? shareUrl(config, token) : null;
}

export function shareDto(config: Config, share: Share) {
  return {
    id: share.id, access: share.access, permission: share.permission,
    url: linkOf(config, share), createdAt: share.createdAt,
  };
}

/** Kurzinfo für Listen und Kennzeichnung („Geteilt · bearbeiten · Passwort“, F-20). */
export const shareBadge = (share: Share | undefined | null) =>
  share ? { access: share.access, permission: share.permission } : null;

export const activeShareOfRun = (db: Db, runId: string): Share | undefined =>
  db.select().from(schema.runShares)
    .where(and(eq(schema.runShares.runId, runId), isNull(schema.runShares.revokedAt))).get();

export function activeSharesOfRuns(db: Db, runIds: string[]): Map<string, Share> {
  const map = new Map<string, Share>();
  for (const id of runIds) {
    const s = activeShareOfRun(db, id);
    if (s) map.set(id, s);
  }
  return map;
}

export class SharePasswordRequired extends Error {
  constructor() {
    super("password_required");
  }
}

/**
 * Legt den Freigabelink einer Durchführung an oder ändert dessen Einstellungen (der Link bleibt gleich).
 * Pro Durchführung gibt es höchstens einen aktiven Link.
 */
export async function saveShare(db: Db, config: Config, runId: string, s: ShareSettings): Promise<{ share: Share; created: boolean }> {
  const existing = activeShareOfRun(db, runId);
  let passwordHash: string | null = null;
  if (s.access === "password") {
    if (s.password) passwordHash = await hashPassword(s.password);
    else if (existing?.passwordHash) passwordHash = existing.passwordHash;
    else throw new SharePasswordRequired();
  }
  if (existing) {
    const [updated] = db.update(schema.runShares)
      .set({ access: s.access, permission: s.permission, passwordHash }).where(eq(schema.runShares.id, existing.id)).returning().all();
    return { share: updated!, created: false };
  }
  return { share: await insertShare(db, config, runId, s.access, s.permission, passwordHash), created: true };
}

async function insertShare(db: Db, config: Config, runId: string, access: Share["access"], permission: Share["permission"], passwordHash: string | null) {
  const token = randomToken(24); // 192 Bit
  const [share] = db.insert(schema.runShares).values({
    runId, tokenHash: sha256(token), tokenEnc: encrypt(token, config.SESSION_SECRET, PURPOSE), access, permission, passwordHash,
  }).returning().all();
  return share!;
}

/** Erzeugt einen neuen Link mit denselben Einstellungen; der alte wird widerrufen (F-40). */
export async function regenerateShare(db: Db, config: Config, runId: string): Promise<Share | null> {
  const old = activeShareOfRun(db, runId);
  if (!old) return null;
  const share = await insertShare(db, config, runId, old.access, old.permission, old.passwordHash);
  revokeShare(db, old.id);
  return share;
}

export const revokeShare = (db: Db, shareId: string) =>
  db.update(schema.runShares).set({ revokedAt: Date.now() })
    .where(and(eq(schema.runShares.id, shareId), isNull(schema.runShares.revokedAt))).run().changes;

/** Aktiver Link anhand des Tokens (nur Hash-Vergleich); null bei unbekannt oder widerrufen. */
export const findShareByToken = (db: Db, token: string): Share | undefined =>
  db.select().from(schema.runShares)
    .where(and(eq(schema.runShares.tokenHash, sha256(token)), isNull(schema.runShares.revokedAt))).get();

/** Alle aktiven Links eines Nutzers mit Durchführung (auch aus dem Papierkorb, dort inaktiv – F-45). */
export function sharesOfUser(db: Db, userId: string) {
  return db.select({ share: schema.runShares, run: schema.runs })
    .from(schema.runShares)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.runShares.runId))
    .where(and(eq(schema.runs.ownerId, userId), isNull(schema.runShares.revokedAt))).all();
}

