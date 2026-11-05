import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as client from "openid-client";
import { z } from "zod";
import type { OidcService } from "../auth/oidc.js";
import { verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, createSession } from "../auth/session.js";
import type { AppDeps } from "../server.js";
import { decrypt, encrypt } from "../crypto.js";
import { schema } from "../db/index.js";
import { cookieOptions } from "../plugins/auth.js";
import { findUserByEmail, normalizeEmail } from "../users.js";
import { parse } from "./auth.js";

const FLOW_COOKIE = "oidc_flow";
const FLOW_PURPOSE = "oidc-flow";
const FLOW_TTL_MS = 10 * 60 * 1000;

export const unlinkBody = z.object({ password: z.string().max(1024) });

interface Flow { state: string; nonce: string; verifier: string; link: string | null; exp: number }

/**
 * Anmeldung per OpenID Connect (F-09): Authorization-Code-Flow mit PKCE, state und nonce.
 * Der Ablauf-Zustand liegt verschlüsselt in einem kurzlebigen Cookie (keine Serverzustände).
 *
 * Konten: bekannte Identität → Anmeldung · Konto mit gleicher, vom Anbieter **bestätigter** E-Mail → verknüpfen ·
 * sonst neues Konto, sofern REGISTRATION_ENABLED. Angemeldete Nutzer können mit `?link=1` bewusst verknüpfen.
 * Eine in der App eingerichtete 2FA gilt nur für die Passwort-Anmeldung; bei SSO ist der Anbieter zuständig.
 */
export async function ssoRoutes(app: FastifyInstance, { config, db, oidc }: AppDeps & { oidc: OidcService | null }) {
  const base = config.APP_BASE_URL.replace(/\/$/, "");
  const ipLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const flowCookie = { ...cookieOptions(config), path: "/api/v1/auth/oidc", maxAge: FLOW_TTL_MS / 1000 };

  const fail = (reply: FastifyReply, code: string) => {
    reply.clearCookie(FLOW_COOKIE, { path: "/api/v1/auth/oidc" });
    return reply.redirect(`${base}/login?error=${encodeURIComponent(code)}`, 302);
  };

  // ---------- Start ----------
  app.get("/api/v1/auth/oidc/login", ipLimit(30), async (req, reply) => {
    if (!oidc) return reply.code(404).send({ error: "sso_not_configured" });
    try {
      const cfg = await oidc.configuration();
      const verifier = client.randomPKCECodeVerifier();
      const flow: Flow = {
        state: client.randomState(), nonce: client.randomNonce(), verifier, exp: Date.now() + FLOW_TTL_MS,
        // „Verknüpfen“ nur für angemeldete Browser-Sitzungen
        link: (req.query as { link?: string }).link === "1" && req.authMethod === "session" ? req.user!.id : null,
      };
      const url = client.buildAuthorizationUrl(cfg, {
        redirect_uri: oidc.redirectUri, scope: oidc.scope, state: flow.state, nonce: flow.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
      });
      reply.setCookie(FLOW_COOKIE, encrypt(JSON.stringify(flow), config.SESSION_SECRET, FLOW_PURPOSE), flowCookie);
      return reply.redirect(url.href, 302);
    } catch (err) {
      req.log.error({ err, event: "sso_unavailable" }, "SSO-Anbieter nicht erreichbar");
      return fail(reply, "sso_unavailable");
    }
  });

  // ---------- Rückkehr vom Anbieter ----------
  app.get("/api/v1/auth/oidc/callback", ipLimit(30), async (req, reply) => {
    if (!oidc) return reply.code(404).send({ error: "sso_not_configured" });
    const raw = req.cookies[FLOW_COOKIE];
    const decoded = raw ? decrypt(raw, config.SESSION_SECRET, FLOW_PURPOSE) : null;
    let flow: Flow | null = null;
    try { flow = decoded ? (JSON.parse(decoded) as Flow) : null; } catch { flow = null; }
    if (!flow || flow.exp < Date.now()) {
      req.log.warn({ event: "sso_failed", reason: "flow_missing_or_expired" }, "SSO-Rückkehr ohne gültigen Ablauf");
      return fail(reply, "sso_flow_expired");
    }
    const query = req.query as Record<string, string | undefined>;
    if (query.error) {
      req.log.warn({ event: "sso_failed", reason: "provider_error", providerError: query.error }, "SSO vom Anbieter abgebrochen");
      return fail(reply, query.error === "access_denied" ? "sso_denied" : "sso_failed");
    }

    let claims: client.IDToken | undefined;
    try {
      const cfg = await oidc.configuration();
      // Die Redirect-URI stammt aus der Konfiguration, nie aus dem Host-Header der Anfrage.
      const current = new URL(`${base}${req.url}`);
      const tokens = await client.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      claims = tokens.claims();
    } catch (err) {
      req.log.warn({ event: "sso_failed", reason: "token_exchange", error: (err as Error).name }, "SSO-Anmeldung fehlgeschlagen");
      return fail(reply, "sso_failed");
    }
    if (!claims?.sub) return fail(reply, "sso_failed");

    const sub = String(claims.sub);
    const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
    const emailVerified = claims.email_verified === true || claims.email_verified === "true";
    const name = [claims.name, claims.preferred_username].find((v): v is string => typeof v === "string" && v.trim() !== "");

    const identity = db.select().from(schema.userIdentities)
      .where(and(eq(schema.userIdentities.provider, oidc.provider), eq(schema.userIdentities.subject, sub))).get();

    const startSession = (userId: string) => {
      reply.setCookie(SESSION_COOKIE, createSession(db, userId, String(req.headers["user-agent"] ?? "")), cookieOptions(config));
      reply.clearCookie(FLOW_COOKIE, { path: "/api/v1/auth/oidc" });
    };
    const link = (userId: string) => db.insert(schema.userIdentities).values({ userId, provider: oidc.provider, subject: sub }).run();

    // 1) Bewusstes Verknüpfen aus dem Profil
    if (flow.link) {
      if (identity && identity.userId !== flow.link) return fail(reply, "sso_already_linked");
      if (!identity) {
        link(flow.link);
        req.log.info({ event: "sso_linked", userId: flow.link }, "SSO-Identität verknüpft");
      }
      reply.clearCookie(FLOW_COOKIE, { path: "/api/v1/auth/oidc" });
      return reply.redirect(`${base}/?sso=linked`, 302);
    }

    // 2) Bekannte Identität
    if (identity) {
      startSession(identity.userId);
      req.log.info({ event: "sso_login", userId: identity.userId }, "SSO-Login");
      return reply.redirect(`${base}/`, 302);
    }

    if (!email) return fail(reply, "sso_email_missing");

    // 3) Vorhandenes Konto mit gleicher E-Mail: nur verknüpfen, wenn der Anbieter die Adresse bestätigt hat
    //    (sonst könnte jemand mit einer unbestätigten Fremdadresse ein Konto übernehmen).
    const existing = findUserByEmail(db, email);
    if (existing) {
      if (!emailVerified) {
        req.log.warn({ event: "sso_failed", reason: "email_not_verified" }, "SSO: E-Mail nicht bestätigt");
        return fail(reply, "sso_email_not_verified");
      }
      link(existing.id);
      startSession(existing.id);
      req.log.info({ event: "sso_linked", userId: existing.id, via: "email" }, "SSO-Identität per bestätigter E-Mail verknüpft");
      req.log.info({ event: "sso_login", userId: existing.id }, "SSO-Login");
      return reply.redirect(`${base}/`, 302);
    }

    // 4) Neues Konto (folgt REGISTRATION_ENABLED)
    if (!config.REGISTRATION_ENABLED) {
      req.log.warn({ event: "sso_failed", reason: "registration_disabled" }, "SSO: Registrierung deaktiviert");
      return fail(reply, "registration_disabled");
    }
    const [user] = db.insert(schema.users).values({
      email, displayName: (name ?? email.split("@")[0]!).trim().slice(0, 100), passwordHash: null,
      language: config.DEFAULT_LANGUAGE, trashRetentionDays: config.TRASH_RETENTION_DAYS === 0 ? null : config.TRASH_RETENTION_DAYS,
    }).returning().all();
    link(user!.id);
    startSession(user!.id);
    req.log.info({ event: "sso_user_created", userId: user!.id }, "Konto per SSO angelegt");
    return reply.redirect(`${base}/`, 302);
  });

  // ---------- Verwaltung im Profil ----------
  const sessionOnly = { preHandler: app.requireSession };

  app.get("/api/v1/me/sso", sessionOnly, async (req) => {
    const linked = db.select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, req.user!.id)).all();
    return { enabled: oidc !== null, name: oidc?.name ?? null, linked: oidc !== null && linked.some((i) => i.provider === oidc.provider) };
  });

  /** Verknüpfung lösen – nur mit Passwort im Konto (sonst wäre man ausgesperrt). */
  app.post("/api/v1/me/sso/unlink", sessionOnly, async (req: FastifyRequest, reply) => {
    const body = parse(unlinkBody, req.body, reply);
    if (!body || !oidc) return oidc ? undefined : reply.code(404).send({ error: "sso_not_configured" });
    const user = req.user!;
    if (!user.passwordHash) return reply.code(409).send({ error: "password_required" });
    if (!(await verifyPassword(user.passwordHash, body.password))) return reply.code(403).send({ error: "invalid_current_password" });
    const removed = db.delete(schema.userIdentities)
      .where(and(eq(schema.userIdentities.userId, user.id), eq(schema.userIdentities.provider, oidc.provider))).run().changes;
    if (!removed) return reply.code(404).send({ error: "not_found" });
    req.log.info({ event: "sso_unlinked", userId: user.id }, "SSO-Verknüpfung gelöst");
    return reply.code(204).send();
  });
}
