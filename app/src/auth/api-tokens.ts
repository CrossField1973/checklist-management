import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { randomToken, sha256 } from "./session.js";

export const TOKEN_PREFIX = "ck_";
export const MAX_ACTIVE_TOKENS = 50;
const LAST_USED_INTERVAL_MS = 60_000;

export type ApiToken = typeof schema.apiTokens.$inferSelect;

export interface CreatedToken {
  /** Klartext – wird nur einmal angezeigt, in der DB liegt nur der Hash. */
  plain: string;
  row: ApiToken;
}

export function createApiToken(
  db: Db,
  userId: string,
  input: { name: string; permission: "read" | "write"; expiresAt: number | null },
): CreatedToken {
  const plain = TOKEN_PREFIX + randomToken(32); // 256 Bit
  const [row] = db.insert(schema.apiTokens).values({
    userId, name: input.name, permission: input.permission, expiresAt: input.expiresAt,
    tokenPrefix: plain.slice(0, TOKEN_PREFIX.length + 5), // nur zur Wiedererkennung in der Liste
    tokenHash: sha256(plain),
  }).returning().all();
  return { plain, row: row! };
}

export type TokenLookup =
  | { ok: true; token: ApiToken; user: typeof schema.users.$inferSelect; touched: boolean }
  | { ok: false; reason: "invalid" | "expired" };

/** Prüft einen Bearer-Token (Hash-Vergleich, nicht widerrufen, nicht abgelaufen) und aktualisiert „zuletzt benutzt“ höchstens einmal pro Minute. */
export function lookupApiToken(db: Db, plain: string, now = Date.now()): TokenLookup {
  if (!plain.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "invalid" };
  const row = db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(and(eq(schema.apiTokens.tokenHash, sha256(plain)), isNull(schema.apiTokens.revokedAt)))
    .get();
  if (!row) return { ok: false, reason: "invalid" };
  if (row.token.expiresAt !== null && row.token.expiresAt <= now) return { ok: false, reason: "expired" };
  const touched = row.token.lastUsedAt === null || now - row.token.lastUsedAt >= LAST_USED_INTERVAL_MS;
  if (touched) db.update(schema.apiTokens).set({ lastUsedAt: now }).where(eq(schema.apiTokens.id, row.token.id)).run();
  return { ok: true, token: row.token, user: row.user, touched };
}

export const activeTokens = (db: Db, userId: string) =>
  db.select().from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt))).all();

export const revokeApiToken = (db: Db, userId: string, tokenId: string) =>
  db.update(schema.apiTokens).set({ revokedAt: Date.now() })
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt))).run().changes;

/** Einfacher Festfenster-Zähler je Token (F-62), im Arbeitsspeicher. */
export class TokenRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private limitPerMinute: number) {}
  /** Gibt 0 zurück, wenn die Anfrage erlaubt ist, sonst die Wartezeit in Sekunden. */
  hit(tokenId: string, now = Date.now()): number {
    let w = this.windows.get(tokenId);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + 60_000 };
      this.windows.set(tokenId, w);
    }
    w.count += 1;
    return w.count > this.limitPerMinute ? Math.ceil((w.resetAt - now) / 1000) : 0;
  }
}
