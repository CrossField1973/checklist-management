import type { DestinationStream } from "pino";
import { pino } from "pino";
import type { Config } from "./config.js";

/** Ersetzt geheime Teile in URLs: Freigabe-Token im Pfad und `token=` in Query-Strings. */
export function maskUrl(url: string): string {
  return url
    .replace(/(\/public\/runs\/)[^/?#]+/g, "$1[REDACTED]")
    .replace(/^(\/s\/)[^/?#]+/, "$1[REDACTED]") // Seitenadresse des Freigabelinks (SPA-Route /s/<token>)
    .replace(/([?&](?:token|password|code|state|session_state|id_token|access_token)=)[^&#]*/gi, "$1[REDACTED]");
}

/**
 * Strukturierte JSON-Logs auf stdout (F-37). Sensible Felder werden nie ausgegeben:
 * Passwörter/Token in Feldern, Authorization/Cookie-Header und geheime URL-Bestandteile (Freigabe-Token).
 */
export function createLogger(config: Pick<Config, "LOG_LEVEL">, stream?: DestinationStream) {
  return pino(
    {
      level: config.LOG_LEVEL,
      redact: {
        paths: ["password", "*.password", "token", "*.token", "req.headers.authorization", "req.headers.cookie"],
        censor: "[REDACTED]",
      },
      serializers: {
        req(req: { method?: string; url?: string; host?: string; hostname?: string; ip?: string; remoteAddress?: string; remotePort?: number }) {
          return {
            method: req.method,
            url: req.url ? maskUrl(req.url) : req.url,
            host: req.host ?? req.hostname,
            remoteAddress: req.remoteAddress ?? req.ip,
            remotePort: req.remotePort,
          };
        },
      },
    },
    stream,
  );
}

export type Logger = ReturnType<typeof createLogger>;
