import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { checkPasswordPolicy, hashPassword, verifyAgainstDummy, verifyPassword } from "../auth/password.js";
import {
  SESSION_COOKIE, createSession, destroySession, destroyUserSessions, randomToken, sha256,
} from "../auth/session.js";
import { LoginThrottle } from "../auth/throttle.js";
import { checkSecondFactor, isTwoFactorEnabled, remainingRecoveryCodes } from "../auth/two-factor.js";
import type { AppDeps } from "../server.js";
import { schema } from "../db/index.js";
import { resetPasswordMail, type Mailer } from "../mail.js";
import { cookieOptions } from "../plugins/auth.js";
import { EmailTakenError, PasswordPolicyError, createUser, findUserByEmail, normalizeEmail, toUserDto } from "../users.js";

const RESET_TTL_MS = 60 * 60 * 1000;

export const email = z.string().trim().max(254).email();
export const password = z.string().max(1024); // Längenprüfung der Richtlinie erfolgt separat (F-03)

export const registerBody = z.object({
  email,
  displayName: z.string().trim().min(1).max(100),
  password,
});
/** `code`: Authenticator-Code (6 Ziffern) oder Wiederherstellungscode – nur nötig, wenn 2FA aktiv ist (sonst `401 two_factor_required`). */
export const loginBody = z.object({ email, password, code: z.string().trim().max(32).optional() });
export const forgotBody = z.object({ email });
export const resetBody = z.object({ token: z.string().min(10).max(200), password });

export function parse<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  reply.code(400).send({
    error: "validation_error",
    details: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return null;
}

export async function authRoutes(app: FastifyInstance, { config, db, mailer }: AppDeps & { mailer: Mailer | null }) {
  const throttle = new LoginThrottle();
  const ipLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  const startSession = (req: { headers: Record<string, unknown> }, reply: FastifyReply, userId: string) => {
    const token = createSession(db, userId, String(req.headers["user-agent"] ?? ""));
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(config));
  };

  // ---------- Registrierung (F-01, abschaltbar) ----------
  app.post("/api/v1/auth/register", ipLimit(10), async (req, reply) => {
    if (!config.REGISTRATION_ENABLED) {
      return reply.code(403).send({ error: "registration_disabled" });
    }
    const body = parse(registerBody, req.body, reply);
    if (!body) return;
    try {
      const user = await createUser(db, config, body);
      startSession(req, reply, user.id);
      req.log.info({ event: "user_registered", userId: user.id }, "Nutzer registriert");
      return reply.code(201).send({ user: toUserDto(user) });
    } catch (err) {
      if (err instanceof PasswordPolicyError) return reply.code(422).send({ error: "password_policy", problems: err.problems });
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: "email_taken" });
      throw err;
    }
  });

  // ---------- Login / Logout (F-02) ----------
  app.post("/api/v1/auth/login", ipLimit(20), async (req, reply) => {
    const body = parse(loginBody, req.body, reply);
    if (!body) return;
    const key = normalizeEmail(body.email);
    const wait = throttle.retryAfterSeconds(key);
    if (wait > 0) {
      req.log.warn({ event: "login_blocked", email: key }, "Login vorübergehend gesperrt");
      return reply.code(429).header("Retry-After", String(wait)).send({ error: "too_many_attempts", retryAfterSeconds: wait });
    }
    const user = findUserByEmail(db, key);
    const ok = user?.passwordHash ? await verifyPassword(user.passwordHash, body.password) : (await verifyAgainstDummy(body.password), false);
    if (!ok || !user) {
      throttle.fail(key);
      req.log.warn({ event: "login_failed", email: key }, "Login fehlgeschlagen");
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    // ---- Zweiter Faktor (F-08) ----
    let usedRecovery = false;
    if (isTwoFactorEnabled(user)) {
      if (!body.code) {
        // Passwort stimmte: Client soll den Code abfragen und die Anfrage mit `code` wiederholen (kein Fehlversuch).
        return reply.code(401).send({ error: "two_factor_required" });
      }
      const second = checkSecondFactor(db, config, user, body.code);
      if (!second.ok) {
        throttle.fail(key);
        req.log.warn({ event: "two_factor_failed", userId: user.id }, "Zweiter Faktor falsch");
        return reply.code(401).send({ error: "invalid_code" });
      }
      usedRecovery = second.method === "recovery";
      if (usedRecovery) req.log.warn({ event: "recovery_code_used", userId: user.id }, "Wiederherstellungscode verwendet");
    }
    throttle.reset(key);
    startSession(req, reply, user.id);
    req.log.info({ event: "login", userId: user.id, twoFactor: isTwoFactorEnabled(user) }, "Login erfolgreich");
    return { user: toUserDto(user), ...(usedRecovery && { recoveryCodesRemaining: remainingRecoveryCodes(db, user.id) }) };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.sessionId) destroySession(db, req.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  // ---------- Passwort vergessen / zurücksetzen (F-07) ----------
  app.post("/api/v1/auth/forgot", ipLimit(5), async (req, reply) => {
    if (!mailer) return reply.code(404).send({ error: "smtp_not_configured" });
    const body = parse(forgotBody, req.body, reply);
    if (!body) return;
    const user = findUserByEmail(db, body.email);
    if (user) {
      const token = randomToken();
      db.insert(schema.passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: Date.now() + RESET_TTL_MS }).run();
      const link = `${config.APP_BASE_URL.replace(/\/$/, "")}/reset-password?token=${token}`;
      const mail = resetPasswordMail(user.language, link);
      try {
        await mailer.send({ to: user.email, ...mail });
        req.log.info({ event: "password_reset_requested", userId: user.id }, "Reset-Link versendet");
      } catch (err) {
        req.log.error({ err, event: "password_reset_mail_failed", userId: user.id }, "E-Mail-Versand fehlgeschlagen");
      }
    }
    // Immer dieselbe Antwort: verrät nicht, ob die E-Mail existiert.
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/api/v1/auth/reset", ipLimit(10), async (req, reply) => {
    const body = parse(resetBody, req.body, reply);
    if (!body) return;
    const row = db
      .select()
      .from(schema.passwordResets)
      .where(and(eq(schema.passwordResets.tokenHash, sha256(body.token)), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, Date.now())))
      .get();
    const user = row && db.select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
    if (!row || !user) return reply.code(400).send({ error: "invalid_or_expired_token" });
    const problems = await checkPasswordPolicy(body.password, { email: user.email, displayName: user.displayName }, config.PASSWORD_BREACH_CHECK);
    if (problems.length) return reply.code(422).send({ error: "password_policy", problems });
    const passwordHash = await hashPassword(body.password);
    db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id)).run();
    db.update(schema.passwordResets).set({ usedAt: Date.now() }).where(eq(schema.passwordResets.userId, user.id)).run();
    destroyUserSessions(db, user.id);
    throttle.reset(user.email);
    req.log.info({ event: "password_reset", userId: user.id }, "Passwort zurückgesetzt");
    return { status: "ok" };
  });
}
