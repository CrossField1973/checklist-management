import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_ACTIVE_TOKENS, activeTokens, createApiToken, revokeApiToken, type ApiToken } from "../auth/api-tokens.js";
import type { AppDeps } from "../server.js";
import { parse } from "./auth.js";

const MAX_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  permission: z.enum(["read", "write"]),
  /** Optionales Ablaufdatum (ISO-8601, in der Zukunft). Ohne Angabe läuft der Token nicht ab. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export const idParams = z.object({ id: z.string().uuid() });

export const tokenDto = (t: ApiToken, now = Date.now()) => ({
  id: t.id,
  name: t.name,
  /** Nur die ersten Zeichen, zur Wiedererkennung – der vollständige Token wird nie wieder angezeigt. */
  prefix: t.tokenPrefix,
  permission: t.permission,
  expiresAt: t.expiresAt,
  expired: t.expiresAt !== null && t.expiresAt <= now,
  lastUsedAt: t.lastUsedAt,
  createdAt: t.createdAt,
});

/** API-Token-Verwaltung (F-61). Nur mit Browser-Sitzung: Ein API-Token kann keine Token verwalten. */
export async function tokenRoutes(app: FastifyInstance, { db }: AppDeps) {
  const sessionOnly = { preHandler: app.requireSession };

  app.get("/api/v1/me/tokens", sessionOnly, async (req) => ({
    tokens: activeTokens(db, req.user!.id).sort((a, b) => b.createdAt - a.createdAt).map((t) => tokenDto(t)),
  }));

  app.post("/api/v1/me/tokens", sessionOnly, async (req, reply) => {
    const body = parse(createBody, req.body, reply);
    if (!body) return;
    const userId = req.user!.id;
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : null;
    if (expiresAt !== null && (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_LIFETIME_MS)) {
      return reply.code(422).send({ error: "invalid_expiry" });
    }
    if (activeTokens(db, userId).length >= MAX_ACTIVE_TOKENS) {
      return reply.code(422).send({ error: "too_many_tokens" });
    }
    const { plain, row } = createApiToken(db, userId, { name: body.name, permission: body.permission, expiresAt });
    req.log.info({ event: "api_token_created", userId, tokenId: row.id, permission: row.permission }, "API-Token angelegt");
    // Der Klartext wird ausschließlich in dieser Antwort ausgegeben.
    return reply.code(201).send({ token: plain, apiToken: tokenDto(row) });
  });

  app.delete("/api/v1/me/tokens/:id", sessionOnly, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    if (!revokeApiToken(db, req.user!.id, p.id)) return reply.code(404).send({ error: "not_found" });
    req.log.info({ event: "api_token_revoked", userId: req.user!.id, tokenId: p.id }, "API-Token widerrufen");
    return reply.code(204).send();
  });
}
