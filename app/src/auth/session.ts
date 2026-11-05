import { createHash, randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage, gleitend
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Legt eine Sitzung an. Im Cookie liegt der zufällige Token, in der DB nur dessen Hash. */
export function createSession(db: Db, userId: string, userAgent?: string): string {
  const token = randomToken();
  db.insert(schema.sessions).values({ id: sha256(token), userId, userAgent: userAgent?.slice(0, 255) }).run();
  return token;
}

export function findSessionUser(db: Db, token: string) {
  const id = sha256(token);
  const row = db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, id))
    .get();
  if (!row) return null;
  const now = Date.now();
  if (now - row.session.lastSeenAt > SESSION_MAX_AGE_MS) {
    db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
    return null;
  }
  if (now - row.session.lastSeenAt > TOUCH_INTERVAL_MS) {
    db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id)).run();
  }
  return { sessionId: id, user: row.user };
}

export function destroySession(db: Db, sessionId: string) {
  db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
}

/** Beendet alle Sitzungen des Nutzers, optional außer einer (z. B. nach Passwortänderung). */
export function destroyUserSessions(db: Db, userId: string, exceptSessionId?: string) {
  db.delete(schema.sessions)
    .where(
      exceptSessionId
        ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, exceptSessionId))
        : eq(schema.sessions.userId, userId),
    )
    .run();
}
