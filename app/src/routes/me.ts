import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, destroyUserSessions } from "../auth/session.js";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import { findUserByEmail, normalizeEmail, toUserDto } from "../users.js";
import { parse } from "./auth.js";

const TRASH_CHOICES = [7, 30, 90, 365] as const; // null = nie (F-32)

export const updateBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    email: z.string().trim().max(254).email(),
    currentPassword: z.string().max(1024), // nur bei E-Mail-Änderung nötig
    language: z.enum(["de", "en"]),
    theme: z.enum(["light", "dark", "system"]),
    trashRetentionDays: z.union([z.null(), z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");

export const passwordBody = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

export const deleteBody = z.object({ password: z.string().max(1024) });

export async function meRoutes(app: FastifyInstance, { config, db }: AppDeps) {
  const auth = { preHandler: app.requireUser };
  /** Konto-, Passwort- und Löschaktionen sind API-Tokens nie erlaubt. */
  const sessionOnly = { preHandler: app.requireSession };

  // ---------- Profil (F-05) ----------
  app.get("/api/v1/me", auth, async (req) => ({ user: toUserDto(req.user!) }));

  app.put("/api/v1/me", sessionOnly, async (req, reply) => {
    const body = parse(updateBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    const patch: Partial<typeof schema.users.$inferInsert> = {};

    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.language !== undefined) patch.language = body.language;
    if (body.theme !== undefined) patch.theme = body.theme;
    if (body.trashRetentionDays !== undefined) patch.trashRetentionDays = body.trashRetentionDays;

    if (body.email !== undefined && normalizeEmail(body.email) !== user.email) {
      if (!user.passwordHash || !body.currentPassword || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
        return reply.code(403).send({ error: "current_password_required" });
      }
      const email = normalizeEmail(body.email);
      const existing = findUserByEmail(db, email);
      if (existing && existing.id !== user.id) return reply.code(409).send({ error: "email_taken" });
      patch.email = email;
    }

    const [updated] = db.update(schema.users).set(patch).where(eq(schema.users.id, user.id)).returning().all();
    req.log.info({ event: "profile_updated", userId: user.id, fields: Object.keys(patch) }, "Profil geändert");
    return { user: toUserDto(updated!) };
  });

  // ---------- Passwort ändern (F-06) ----------
  app.post("/api/v1/me/password", { ...sessionOnly, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(passwordBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
      req.log.warn({ event: "password_change_failed", userId: user.id }, "Passwortänderung abgelehnt");
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    const problems = await checkPasswordPolicy(body.newPassword, { email: user.email, displayName: user.displayName }, config.PASSWORD_BREACH_CHECK);
    if (problems.length) return reply.code(422).send({ error: "password_policy", problems });
    db.update(schema.users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(schema.users.id, user.id)).run();
    destroyUserSessions(db, user.id, req.sessionId!); // alle anderen Sitzungen beenden
    req.log.info({ event: "password_changed", userId: user.id }, "Passwort geändert");
    return reply.code(204).send();
  });

  // ---------- Konto löschen (F-52) ----------
  app.delete("/api/v1/me", sessionOnly, async (req, reply) => {
    const body = parse(deleteBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.password))) {
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    db.delete(schema.users).where(eq(schema.users.id, user.id)).run(); // Cascade entfernt alle Daten
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    req.log.info({ event: "account_deleted", userId: user.id }, "Konto gelöscht");
    return reply.code(204).send();
  });
}

export { TRASH_CHOICES };
