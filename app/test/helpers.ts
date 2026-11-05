import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { buildServer } from "../src/server.js";

export const GOOD_PASSWORD = "Kaffeetasse-Wolke-42";

export function setupApp(env: Record<string, string> = {}) {
  const config = loadConfig({ APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "error", ...env });
  const db = openDatabase(":memory:");
  const app = buildServer({ config, db, logger: createLogger(config), mailer: null });
  return { app, db, config };
}

export type TestApp = ReturnType<typeof setupApp>["app"];

/** Registriert einen Nutzer und liefert einen kleinen Client, der dessen Sitzung mitsendet. */
export async function newUser(app: TestApp, email: string, displayName = "Test Nutzer") {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, displayName, password: GOOD_PASSWORD } });
  if (res.statusCode !== 201) throw new Error(`Registrierung fehlgeschlagen: ${res.body}`);
  const token = res.cookies.find((c) => c.name === "session")!.value;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object | undefined, cookies: { session: token } });
  return {
    /** Sitzungs-Cookie des Nutzers (für Anfragen mit eigener Nutzlast). */
    session: token,
    get: (url: string) => call("GET", url),
    post: (url: string, payload?: unknown) => call("POST", url, payload ?? {}),
    put: (url: string, payload: unknown) => call("PUT", url, payload),
    del: (url: string) => call("DELETE", url),
  };
}
