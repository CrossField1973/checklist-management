import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  APP_BASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET muss mindestens 32 Zeichen lang sein"),
  REGISTRATION_ENABLED: bool.default(true),
  DEFAULT_LANGUAGE: z.enum(["de", "en"]).default("de"),
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  PASSWORD_BREACH_CHECK: z.enum(["local", "hibp", "off"]).default("local"),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Ordner der gebauten Oberfläche (nur für Entwicklung/Tests; im Docker-Image automatisch gefunden) */
  WEB_DIST: z.string().optional(),
  DATABASE_PATH: z.string().default("/data/app.db"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: bool.optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid email profile"),
  OIDC_NAME: z.string().trim().min(1).max(40).default("SSO"),
});

export type Config = z.infer<typeof schema> & {
  smtpEnabled: boolean;
  oidcEnabled: boolean;
};

/** Liest und validiert die Konfiguration aus Umgebungsvariablen (Pflichtenheft Abschnitt 6). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Leere Strings wie nicht gesetzt behandeln (typisch bei docker compose).
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Ungültige Konfiguration:\n${msg}`);
  }
  const c = parsed.data;
  return {
    ...c,
    smtpEnabled: Boolean(c.SMTP_HOST && c.SMTP_FROM),
    oidcEnabled: Boolean(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
  };
}
