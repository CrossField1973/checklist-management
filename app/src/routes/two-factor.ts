import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPassword } from "../auth/password.js";
import { destroyUserSessions } from "../auth/session.js";
import { LoginThrottle } from "../auth/throttle.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../auth/totp.js";
import {
  checkSecondFactor, isTwoFactorEnabled, openSecret, remainingRecoveryCodes, replaceRecoveryCodes, sealSecret,
} from "../auth/two-factor.js";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import { toUserDto } from "../users.js";
import { parse } from "./auth.js";

const password = z.string().max(1024);
export const setupBody = z.object({ password: password.optional() });
export const enableBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, "6-stelliger Code aus der Authenticator-App") });
/** Zum Deaktivieren und Erneuern der Codes: Passwort (falls vorhanden) und Authenticator- oder Wiederherstellungscode. */
export const confirmBody = z.object({ password: password.optional(), code: z.string().trim().min(1).max(32) });

const ISSUER = "Checklisten";

/**
 * Zwei-Faktor-Authentifizierung per TOTP (F-08): einrichten, aktivieren, deaktivieren, Wiederherstellungscodes erneuern.
 * Nur mit Browser-Sitzung – API-Token dürfen die Kontosicherheit nicht ändern.
 */
export async function twoFactorRoutes(app: FastifyInstance, { config, db }: AppDeps) {
  const sessionOnly = { preHandler: app.requireSession };
  const throttle = new LoginThrottle();

  /** Fehlversuche sperren zeitweise (je Nutzer), damit Codes nicht durchprobiert werden können. */
  const blocked = (req: FastifyRequest, reply: FastifyReply) => {
    const wait = throttle.retryAfterSeconds(req.user!.id);
    if (wait > 0) {
      reply.code(429).header("Retry-After", String(wait)).send({ error: "too_many_attempts", retryAfterSeconds: wait });
      return true;
    }
    return false;
  };

  /** Prüft das Passwort, falls das Konto eines hat (reine SSO-Konten haben keins). */
  const passwordOk = async (user: typeof schema.users.$inferSelect, given: string | undefined) =>
    !user.passwordHash || (given !== undefined && (await verifyPassword(user.passwordHash, given)));

  const fresh = (id: string) => db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;

  app.get("/api/v1/me/2fa", sessionOnly, async (req) => {
    const user = req.user!;
    return {
      enabled: isTwoFactorEnabled(user),
      enabledAt: user.totpEnabledAt,
      pendingSetup: !isTwoFactorEnabled(user) && user.totpSecret !== null,
      recoveryCodesRemaining: isTwoFactorEnabled(user) ? remainingRecoveryCodes(db, user.id) : 0,
    };
  });

  /** Schritt 1: neues Geheimnis erzeugen (noch nicht aktiv). Das Passwort schützt vor Übernahme einer offenen Sitzung. */
  app.post("/api/v1/me/2fa/setup", sessionOnly, async (req, reply) => {
    const body = parse(setupBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (isTwoFactorEnabled(user)) return reply.code(409).send({ error: "already_enabled" });
    if (blocked(req, reply)) return;
    if (!(await passwordOk(user, body.password))) {
      throttle.fail(user.id);
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    const secret = generateTotpSecret();
    db.update(schema.users).set({ totpSecret: sealSecret(secret, config), totpEnabledAt: null, totpLastStep: null }).where(eq(schema.users.id, user.id)).run();
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, ISSUER) };
  });

  /** Schritt 2: Code aus der App bestätigen → aktiv. Liefert die Wiederherstellungscodes (nur jetzt sichtbar). */
  app.post("/api/v1/me/2fa/enable", sessionOnly, async (req, reply) => {
    const body = parse(enableBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (isTwoFactorEnabled(user)) return reply.code(409).send({ error: "already_enabled" });
    const secret = openSecret(user, config);
    if (!secret) return reply.code(409).send({ error: "setup_required" });
    if (blocked(req, reply)) return;
    const step = verifyTotp(secret, body.code);
    if (step === null) {
      throttle.fail(user.id);
      return reply.code(422).send({ error: "invalid_code" });
    }
    throttle.reset(user.id);
    db.update(schema.users).set({ totpEnabledAt: Date.now(), totpLastStep: step }).where(eq(schema.users.id, user.id)).run();
    const recoveryCodes = replaceRecoveryCodes(db, config, user.id);
    destroyUserSessions(db, user.id, req.sessionId!); // andere Sitzungen müssen sich künftig mit 2FA anmelden
    req.log.info({ event: "two_factor_enabled", userId: user.id }, "2FA aktiviert");
    return { enabled: true, recoveryCodes, user: toUserDto(fresh(user.id)) };
  });

  /** Deaktivieren: Passwort und ein gültiger Code (Authenticator oder Wiederherstellungscode). */
  app.post("/api/v1/me/2fa/disable", sessionOnly, async (req, reply) => {
    const body = parse(confirmBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (!isTwoFactorEnabled(user)) return reply.code(409).send({ error: "not_enabled" });
    if (blocked(req, reply)) return;
    if (!(await passwordOk(user, body.password))) {
      throttle.fail(user.id);
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    if (!checkSecondFactor(db, config, user, body.code).ok) {
      throttle.fail(user.id);
      return reply.code(403).send({ error: "invalid_code" });
    }
    throttle.reset(user.id);
    db.transaction((tx) => {
      tx.update(schema.users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(schema.users.id, user.id)).run();
      tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, user.id)).run();
    });
    req.log.warn({ event: "two_factor_disabled", userId: user.id }, "2FA deaktiviert");
    return reply.code(204).send();
  });

  /** Neue Wiederherstellungscodes erzeugen (die alten werden ungültig). */
  app.post("/api/v1/me/2fa/recovery-codes", sessionOnly, async (req, reply) => {
    const body = parse(confirmBody, req.body, reply);
    if (!body) return;
    const user = req.user!;
    if (!isTwoFactorEnabled(user)) return reply.code(409).send({ error: "not_enabled" });
    if (blocked(req, reply)) return;
    if (!(await passwordOk(user, body.password))) {
      throttle.fail(user.id);
      return reply.code(403).send({ error: "invalid_current_password" });
    }
    if (!checkSecondFactor(db, config, user, body.code).ok) {
      throttle.fail(user.id);
      return reply.code(403).send({ error: "invalid_code" });
    }
    throttle.reset(user.id);
    req.log.info({ event: "recovery_codes_regenerated", userId: user.id }, "Wiederherstellungscodes erneuert");
    return { recoveryCodes: replaceRecoveryCodes(db, config, user.id) };
  });

}
