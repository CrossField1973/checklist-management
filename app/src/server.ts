import Fastify from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Logger } from "./logger.js";
import { mcpRoutes } from "./mcp.js";
import { webPlugin } from "./web.js";
import { createOidc } from "./auth/oidc.js";
import { ssoRoutes } from "./routes/sso.js";
import { importExportRoutes } from "./routes/import-export.js";
import { createMailer, type Mailer } from "./mail.js";
import { buildOpenApi } from "./openapi.js";
import { authPlugin } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { runRoutes } from "./routes/runs.js";
import { shareRoutes } from "./routes/shares.js";
import { tagRoutes } from "./routes/tags.js";
import { twoFactorRoutes } from "./routes/two-factor.js";
import { tokenRoutes } from "./routes/tokens.js";
import { trashRoutes } from "./routes/trash.js";
import { templateRoutes } from "./routes/templates.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Alle registrierten Routen – für den Abgleich mit der OpenAPI-Beschreibung (Tests). */
    routeTable: { method: string; url: string }[];
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** Nur für Tests überschreibbar; sonst aus der SMTP-Konfiguration erzeugt. */
  mailer?: Mailer | null;
}

/** Baut die Fastify-Instanz. Weitere Routen (Vorlagen, Durchführungen …) kommen in späteren Schritten. */
export function buildServer(deps: AppDeps) {
  const { config, db, logger } = deps;
  const mailer = deps.mailer !== undefined ? deps.mailer : createMailer(config);
  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  // ---------- Sicherheits-Header (N-03) ----------
  const https = config.APP_BASE_URL.startsWith("https://");
  const CSP = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()").header("Cross-Origin-Opener-Policy", "same-origin");
    if (https) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // Die Swagger-Oberfläche unter /api/docs bringt eigene Skripte mit; für alles andere gilt die strenge Richtlinie.
    if (!req.url.startsWith("/api/docs")) reply.header("Content-Security-Policy", CSP);
    return payload;
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  app.register(fp(rateLimit), { global: false });
  app.register(fp(authPlugin), { config, db });

  app.get("/healthz", async (_req, reply) => {
    try {
      db.sqlite.prepare("select 1").get();
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "healthcheck fehlgeschlagen");
      return reply.code(503).send({ status: "error" });
    }
  });

  // Öffentliche, nicht sensible Laufzeit-Informationen für das Frontend (Login-/Registrierseite).
  app.get("/api/v1/config", async () => ({
    registrationEnabled: config.REGISTRATION_ENABLED,
    smtpEnabled: mailer !== null,
    oidcEnabled: config.oidcEnabled,
    oidcName: config.oidcEnabled ? config.OIDC_NAME : null,
    oidcLoginUrl: config.oidcEnabled ? "/api/v1/auth/oidc/login" : null,
    defaultLanguage: config.DEFAULT_LANGUAGE,
    mcpUrl: `${config.APP_BASE_URL.replace(/\/$/, "")}/mcp`,
  }));

  // ---------- API-Dokumentation (F-60): /api/openapi.json und Swagger-Oberfläche unter /api/docs ----------
  const openApi = buildOpenApi(config);
  app.get("/api/openapi.json", async () => openApi);
  app.register(swagger, { mode: "static", specification: { document: openApi as never } });
  app.register(swaggerUi, { routePrefix: "/api/docs", uiConfig: { docExpansion: "list", deepLinking: false } });

  app.register(authRoutes, { ...deps, mailer });
  app.register(meRoutes, deps);
  app.register(tagRoutes, deps);
  app.register(templateRoutes, deps);
  app.register(runRoutes, deps);
  app.register(trashRoutes, deps);
  app.register(shareRoutes, deps);
  app.register(tokenRoutes, deps);
  app.register(importExportRoutes, deps);
  app.register(twoFactorRoutes, deps);
  const oidc = createOidc(config);
  app.register(ssoRoutes, { ...deps, oidc });
  app.register(mcpRoutes, { config });

  // Oberfläche zuletzt: ihr Not-Found-Handler liefert für unbekannte Seiten index.html
  app.register(fp(webPlugin), { config });

  return app;
}
