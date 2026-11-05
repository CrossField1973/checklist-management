import * as client from "openid-client";
import type { Config } from "../config.js";

export interface OidcService {
  /** Muss beim Identitätsanbieter als Redirect-URI eingetragen sein. */
  redirectUri: string;
  scope: string;
  /** Anzeigename für die Anmelde-Schaltfläche */
  name: string;
  /** Kennung des Anbieters in der Datenbank (user_identities.provider) */
  provider: string;
  /** Liefert die (zwischengespeicherte) Konfiguration des Anbieters per OpenID-Discovery. */
  configuration(): Promise<client.Configuration>;
}

const CACHE_MS = 60 * 60 * 1000;

/**
 * Erzeugt den OIDC-Dienst, wenn OIDC_ISSUER, OIDC_CLIENT_ID und OIDC_CLIENT_SECRET gesetzt sind (sonst null).
 * Die Discovery erfolgt beim ersten Gebrauch und wird eine Stunde zwischengespeichert; schlägt sie fehl, wird beim
 * nächsten Versuch erneut abgefragt (der Anbieter darf beim Start der App noch nicht erreichbar sein).
 * Reines HTTP ist nur für `http://`-Aussteller erlaubt (lokale Entwicklung, interne Netze).
 */
export function createOidc(config: Config): OidcService | null {
  if (!config.oidcEnabled) return null;
  const issuer = new URL(config.OIDC_ISSUER!);
  let cached: { cfg: client.Configuration; at: number } | null = null;
  return {
    redirectUri: `${config.APP_BASE_URL.replace(/\/$/, "")}/api/v1/auth/oidc/callback`,
    scope: config.OIDC_SCOPES,
    name: config.OIDC_NAME,
    provider: config.OIDC_ISSUER!,
    async configuration() {
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.cfg;
      const cfg = await client.discovery(
        issuer, config.OIDC_CLIENT_ID!, config.OIDC_CLIENT_SECRET!, undefined,
        issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined,
      );
      cached = { cfg, at: Date.now() };
      return cfg;
    },
  };
}
