import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { createLogger, maskUrl } from "../src/logger.js";
import { buildServer } from "../src/server.js";

describe("maskUrl", () => {
  it("maskiert Freigabe-Token im Pfad und token/password in Query-Strings", () => {
    expect(maskUrl("/api/v1/public/runs/AbC123xyz/items/42")).toBe("/api/v1/public/runs/[REDACTED]/items/42");
    expect(maskUrl("/api/v1/public/runs/AbC123xyz?x=1")).toBe("/api/v1/public/runs/[REDACTED]?x=1");
    expect(maskUrl("/s/AbC123xyz")).toBe("/s/[REDACTED]");
    expect(maskUrl("/s/AbC123xyz?x=1")).toBe("/s/[REDACTED]?x=1");
    expect(maskUrl("/settings/s/keep")).toBe("/settings/s/keep");
    expect(maskUrl("/reset-password?token=abc&lang=de")).toBe("/reset-password?token=[REDACTED]&lang=de");
    // SSO-Rückkehr: Autorisierungscode und state sind Geheimnisse
    expect(maskUrl("/api/v1/auth/oidc/callback?state=abc&code=xyz&session_state=s1")).toBe("/api/v1/auth/oidc/callback?state=[REDACTED]&code=[REDACTED]&session_state=[REDACTED]");
    expect(maskUrl("/cb?id_token=e30.e30.e30&access_token=t")).toBe("/cb?id_token=[REDACTED]&access_token=[REDACTED]");
    expect(maskUrl("/api/v1/runs?search=wandern")).toBe("/api/v1/runs?search=wandern");
  });
});

describe("Logging enthält keine Geheimnisse (F-37)", () => {
  it("schreibt weder Freigabe-Token noch Passwörter in die Logzeilen", async () => {
    const lines: string[] = [];
    const stream = { write: (s: string) => void lines.push(s) };
    const config = loadConfig({ APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "info" });
    const app = buildServer({ config, db: openDatabase(":memory:"), logger: createLogger(config, stream), mailer: null });

    const reg = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { email: "anna@example.org", displayName: "Anna", password: "Kaffeetasse-Wolke-42" },
    });
    const session = { session: reg.cookies.find((c) => c.name === "session")!.value };
    const runId = (await app.inject({ method: "POST", url: "/api/v1/runs", payload: { title: "R" }, cookies: session })).json().run.id;
    const url = (await app.inject({
      method: "PUT", url: `/api/v1/runs/${runId}/share`, cookies: session,
      payload: { access: "password", permission: "edit", password: "geheimes-passwort" },
    })).json().share.url as string;
    const token = url.split("/s/")[1]!;
    await app.inject({ method: "GET", url: `/api/v1/public/runs/${token}`, headers: { "x-share-password": "geheimes-passwort" } });
    await app.inject({ method: "GET", url: `/api/v1/public/runs/${token}`, headers: { "x-share-password": "falsches-passwort" } });
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "anna@example.org", password: "falsch-falsch-falsch" } });
    const apiToken = (await app.inject({ method: "POST", url: "/api/v1/me/tokens", cookies: session, payload: { name: "t", permission: "read" } })).json().token as string;
    await app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: `Bearer ${apiToken}` } });
    await app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: "Bearer ck_falscher_token_123" } });

    const log = lines.join("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const secret of [apiToken, "ck_falscher_token_123", token, "geheimes-passwort", "falsches-passwort", "Kaffeetasse-Wolke-42", "falsch-falsch-falsch", session.session]) {
      expect(log).not.toContain(secret);
    }
    expect(log).toContain("[REDACTED]"); // die maskierte URL ist sichtbar
    expect(log).toContain('"event":"share_accessed"');
    expect(log).toContain('"event":"api_token_created"');
    expect(log).toContain('"event":"api_token_used"');
    expect(log).toContain('"event":"api_token_rejected"');
  });
});
