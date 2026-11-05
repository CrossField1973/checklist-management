import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { schema } from "../db/index.js";
import { TokenRateLimiter, lookupApiToken } from "../auth/api-tokens.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, findSessionUser, randomToken } from "../auth/session.js";
import { timingSafeEqual } from "node:crypto";

export type User = typeof schema.users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
    /** Wie die Anfrage angemeldet ist: Browser-Sitzung (Cookie) oder API-Token (Bearer). */
    authMethod: "session" | "token" | null;
    tokenId: string | null;
    tokenPermission: "read" | "write" | null;
  }
  interface FastifyInstance {
    /** Angemeldet per Sitzung oder API-Token. */
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Nur Browser-Sitzung: für Konto-, Passwort- und Token-Verwaltung (API-Tokens dürfen das nie). */
    requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Geheimnis, mit dem der MCP-Server interne Aufrufe kennzeichnet (nur im Prozess bekannt). */
    internalCallSecret: string;
  }
}

export function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.APP_BASE_URL.startsWith("https://"),
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  };
}

export const INTERNAL_CALL_HEADER = "x-internal-call";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Der MCP-Endpunkt nutzt POST auch zum Lesen; die Rechte prüft er je Werkzeug. */
const isMcp = (url: string) => url === "/mcp" || url.startsWith("/mcp?");
/** Pfade, auf denen ein Authorization-Header ignoriert wird (öffentlich bzw. Anmeldung selbst). */
const NO_TOKEN_AUTH = ["/api/v1/public/", "/api/v1/auth/"];

/**
 * Cookie-Sitzungen, API-Token (Bearer), CSRF-Schutz sowie `requireUser`/`requireSession`.
 * - CSRF: SameSite=Lax plus Prüfung des Origin-Headers bei schreibenden Anfragen mit Cookie.
 * - API-Token: `Authorization: Bearer ck_…`; Recht „lesen“ erlaubt nur GET/HEAD; Rate-Limit je Token.
 *   Ein ungültiger Bearer-Header führt immer zu 401 – es gibt keinen stillen Rückfall auf das Cookie.
 */
export async function authPlugin(app: FastifyInstance, opts: { config: Config; db: Db }) {
  const { config, db } = opts;
  const allowedOrigin = new URL(config.APP_BASE_URL).origin;
  const limiter = new TokenRateLimiter(config.API_RATE_LIMIT_PER_MINUTE);
  const internalSecret = randomToken(32);
  app.decorate("internalCallSecret", internalSecret);
  const isInternal = (value: unknown) => {
    if (typeof value !== "string") return false;
    const a = Buffer.from(value);
    const b = Buffer.from(internalSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  await app.register(cookie);
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
  app.decorateRequest("authMethod", null);
  app.decorateRequest("tokenId", null);
  app.decorateRequest("tokenPermission", null);

  app.addHook("onRequest", async (req, reply) => {
    const safe = SAFE_METHODS.has(req.method);
    const header = req.headers.authorization;

    // ---- API-Token ----
    if (header && !NO_TOKEN_AUTH.some((p) => req.url.startsWith(p))) {
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      const found = match ? lookupApiToken(db, match[1]!) : ({ ok: false, reason: "invalid" } as const);
      if (!found.ok) {
        req.log.warn({ event: "api_token_rejected", reason: found.reason }, "API-Token abgelehnt");
        return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: found.reason === "expired" ? "token_expired" : "invalid_token" });
      }
      // Interne Aufrufe des MCP-Servers zählen nicht doppelt: der äußere /mcp-Aufruf wurde bereits gezählt.
      const internal = isInternal(req.headers[INTERNAL_CALL_HEADER]);
      const wait = internal ? 0 : limiter.hit(found.token.id);
      if (wait > 0) {
        return reply.code(429).header("Retry-After", String(wait)).send({ error: "rate_limited", retryAfterSeconds: wait });
      }
      if (found.touched && !internal) req.log.info({ event: "api_token_used", userId: found.user.id, tokenId: found.token.id }, "API-Token verwendet");
      if (found.token.permission === "read" && !safe && !isMcp(req.url)) {
        return reply.code(403).send({ error: "token_read_only" });
      }
      req.user = found.user;
      req.authMethod = "token";
      req.tokenId = found.token.id;
      req.tokenPermission = found.token.permission;
      return;
    }

    // ---- Browser-Sitzung ----
    const origin = req.headers.origin;
    if (!safe && origin && origin !== allowedOrigin) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const found = findSessionUser(db, token);
      if (found) {
        req.user = found.user;
        req.sessionId = found.sessionId;
        req.authMethod = "session";
      } else {
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
      }
    }
  });

  app.decorate("requireUser", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
  });

  app.decorate("requireSession", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthorized" });
    if (req.authMethod !== "session") return reply.code(403).send({ error: "session_required" });
  });
}
