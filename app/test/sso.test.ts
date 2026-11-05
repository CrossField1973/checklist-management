import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { openDatabase, schema } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { buildServer } from "../src/server.js";
import { startFakeIdp, type FakeIdp } from "./fake-idp.js";
import { GOOD_PASSWORD, newUser } from "./helpers.js";

let idp: FakeIdp;
let app: ReturnType<typeof buildServer>;
let db: ReturnType<typeof openDatabase>;
let logLines: string[];

beforeAll(async () => { idp = await startFakeIdp(); });
afterAll(() => idp.close());

function start(env: Record<string, string> = {}) {
  logLines = [];
  const config = loadConfig({
    APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "info",
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_NAME: "Authentik",
    ...env,
  });
  db = openDatabase(":memory:");
  app = buildServer({ config, db, logger: createLogger(config, { write: (s: string) => void logLines.push(s) }), mailer: null });
}

beforeEach(() => {
  idp.setUser({ sub: "sub-1", email: "anna@example.org", email_verified: true, name: "Anna Muster" });
  idp.setBehaviour({});
  start();
});
afterEach(() => { vi.useRealTimers(); });

const BASE = "http://localhost:3000";
const location = (res: { headers: Record<string, unknown> }) => String(res.headers.location ?? "");
const errorOf = (res: { headers: Record<string, unknown> }) => new URL(location(res)).searchParams.get("error");
const cookieValue = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;

/** Durchläuft den kompletten Ablauf: App → Anbieter → App-Rückkehr. Gibt Zwischen- und Endergebnisse zurück. */
async function ssoFlow(opts: { cookies?: Record<string, string>; link?: boolean; tamperState?: boolean; dropCookie?: boolean; reuse?: boolean } = {}) {
  const start = await app.inject({ method: "GET", url: `/api/v1/auth/oidc/login${opts.link ? "?link=1" : ""}`, cookies: opts.cookies });
  if (start.statusCode !== 302 || !location(start).startsWith(idp.issuer)) return { start, callback: start, flowCookie: undefined as string | undefined, callbackUrl: "" };
  const flowCookie = cookieValue(start, "oidc_flow");
  const authorized = await fetch(location(start), { redirect: "manual" });
  const back = new URL(authorized.headers.get("location")!);
  if (opts.tamperState) back.searchParams.set("state", "falscher-state");
  const callbackUrl = back.pathname + back.search;
  const callback = await app.inject({ method: "GET", url: callbackUrl, cookies: opts.dropCookie || !flowCookie ? opts.cookies : { ...opts.cookies, oidc_flow: flowCookie } });
  return { start, callback, flowCookie, callbackUrl };
}

describe("Konfiguration und Start (F-09)", () => {
  it("ohne OIDC-Konfiguration: 404 und in der öffentlichen Konfiguration ausgeschaltet", async () => {
    const plain = buildServer({ config: loadConfig({ APP_BASE_URL: BASE, SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "error" }), db: openDatabase(":memory:"), logger: createLogger({ LOG_LEVEL: "error" }), mailer: null });
    expect((await plain.inject({ method: "GET", url: "/api/v1/auth/oidc/login" })).statusCode).toBe(404);
    expect((await plain.inject({ method: "GET", url: "/api/v1/auth/oidc/callback" })).statusCode).toBe(404);
    expect((await plain.inject({ method: "GET", url: "/api/v1/config" })).json()).toMatchObject({ oidcEnabled: false, oidcName: null, oidcLoginUrl: null });
  });

  it("meldet SSO samt Anzeigename in der öffentlichen Konfiguration", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/config" })).json()).toMatchObject({ oidcEnabled: true, oidcName: "Authentik", oidcLoginUrl: "/api/v1/auth/oidc/login" });
  });

  it("leitet mit PKCE (S256), state, nonce, Scope und fester Redirect-URI zum Anbieter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(idp.clientId);
    expect(q.get("redirect_uri")).toBe(`${BASE}/api/v1/auth/oidc/callback`);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(q.get("state")).toHaveLength(43);
    expect(q.get("nonce")).toHaveLength(43);
  });

  it("verwendet pro Anmeldung neue Zufallswerte und legt den Zustand verschlüsselt in ein kurzlebiges Cookie", async () => {
    const a = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
    const b = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
    expect(new URL(location(a)).searchParams.get("state")).not.toBe(new URL(location(b)).searchParams.get("state"));
    const cookie = a.cookies.find((c) => c.name === "oidc_flow")!;
    expect(cookie).toMatchObject({ httpOnly: true, path: "/api/v1/auth/oidc", maxAge: 600 });
    expect(String(cookie.sameSite).toLowerCase()).toBe("lax");
    expect(cookie.value).not.toContain(new URL(location(a)).searchParams.get("state")!);
  });

  it("erreichbarer Anbieter ist nicht nötig, solange niemand SSO nutzt; ist er nicht erreichbar, endet der Start mit sso_unavailable", async () => {
    start({ OIDC_ISSUER: "http://127.0.0.1:1" });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
    expect([res.statusCode, errorOf(res)]).toEqual([302, "sso_unavailable"]);
    expect(location(res).startsWith(`${BASE}/login?error=`)).toBe(true);
  });
});

describe("Anmeldung und Konto-Zuordnung", () => {
  it("legt beim ersten Login ein Konto ohne Passwort an und meldet an", async () => {
    const { callback } = await ssoFlow();
    expect(callback.statusCode).toBe(302);
    expect(location(callback)).toBe(`${BASE}/`);
    const session = cookieValue(callback, "session")!;
    expect(session).toBeTruthy();
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", cookies: { session } })).json().user;
    expect(me).toMatchObject({ email: "anna@example.org", displayName: "Anna Muster", hasPassword: false, language: "de", trashRetentionDays: 30, twoFactorEnabled: false });
    expect(db.select().from(schema.userIdentities).all()).toEqual([expect.objectContaining({ provider: idp.issuer, subject: "sub-1" })]);
    expect(logLines.join("\n")).toContain('"event":"sso_user_created"');
    expect(cookieValue(callback, "session")).toBeDefined();
    expect(callback.cookies.find((c) => c.name === "session")).toMatchObject({ httpOnly: true });
    expect(callback.cookies.find((c) => c.name === "oidc_flow")?.value ?? "").toBe(""); // Ablauf-Cookie wird gelöscht
  });

  it("meldet bei späteren Logins dasselbe Konto an (keine Duplikate), auch wenn sich die E-Mail beim Anbieter ändert", async () => {
    await ssoFlow();
    idp.setUser({ sub: "sub-1", email: "neu@example.org", email_verified: false, name: "Anna M." });
    const { callback } = await ssoFlow();
    expect(location(callback)).toBe(`${BASE}/`);
    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { session: cookieValue(callback, "session")! } })).json().user.email).toBe("anna@example.org");
  });

  it("verknüpft ein vorhandenes Konto bei vom Anbieter bestätigter E-Mail; Passwort-Login bleibt möglich", async () => {
    const anna = await newUser(app, "anna@example.org", "Anna");
    const { callback } = await ssoFlow();
    expect(location(callback)).toBe(`${BASE}/`);
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", cookies: { session: cookieValue(callback, "session")! } })).json().user;
    expect(me.hasPassword).toBe(true);
    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect(db.select().from(schema.userIdentities).all()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "anna@example.org", password: GOOD_PASSWORD } })).statusCode).toBe(200);
    expect(anna.session).toBeTruthy();
  });

  it("übernimmt kein Konto über eine unbestätigte E-Mail (Schutz vor Konto-Übernahme)", async () => {
    await newUser(app, "anna@example.org", "Anna");
    for (const verified of [false, undefined, "false"] as const) {
      idp.setUser({ sub: `fremd-${String(verified)}`, email: "anna@example.org", email_verified: verified });
      const { callback } = await ssoFlow();
      expect(errorOf(callback), String(verified)).toBe("sso_email_not_verified");
      expect(cookieValue(callback, "session")).toBeUndefined();
    }
    expect(db.select().from(schema.userIdentities).all()).toHaveLength(0);
  });

  it("verlangt eine E-Mail-Adresse vom Anbieter", async () => {
    idp.setUser({ sub: "ohne-mail" });
    const { callback } = await ssoFlow();
    expect(errorOf(callback)).toBe("sso_email_missing");
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  it("legt bei REGISTRATION_ENABLED=false keine neuen Konten an, meldet aber vorhandene weiter an", async () => {
    start({ REGISTRATION_ENABLED: "false" });
    const denied = await ssoFlow();
    expect(errorOf(denied.callback)).toBe("registration_disabled");
    expect(db.select().from(schema.users).all()).toHaveLength(0);
    expect(cookieValue(denied.callback, "session")).toBeUndefined();

    db.insert(schema.users).values({ email: "anna@example.org", displayName: "Anna" }).run();
    const ok = await ssoFlow();
    expect(location(ok.callback)).toBe(`${BASE}/`);
    expect(cookieValue(ok.callback, "session")).toBeDefined();
  });

  it("nimmt den Anzeigenamen aus name, dann preferred_username, dann aus der E-Mail", async () => {
    const names: [Partial<{ name: string; preferred_username: string }>, string][] = [
      [{ name: "Anna Muster" }, "Anna Muster"], [{ preferred_username: "amuster" }, "amuster"], [{}, "kai"],
    ];
    for (const [i, [claims, expected]] of names.entries()) {
      idp.setUser({ sub: `n-${i}`, email: i === 2 ? "kai@example.org" : `n${i}@example.org`, email_verified: true, ...claims });
      await ssoFlow();
      expect(db.select().from(schema.users).where(eq(schema.users.email, i === 2 ? "kai@example.org" : `n${i}@example.org`)).get()!.displayName).toBe(expected);
    }
  });

  it("2FA der App gilt nur für die Passwort-Anmeldung; bei SSO entscheidet der Anbieter", async () => {
    const anna = await newUser(app, "anna@example.org", "Anna");
    db.update(schema.users).set({ totpSecret: "x", totpEnabledAt: Date.now() }).where(eq(schema.users.email, "anna@example.org")).run();
    const { callback } = await ssoFlow();
    expect(location(callback)).toBe(`${BASE}/`);
    expect(cookieValue(callback, "session")).toBeDefined();
    expect(anna.session).toBeTruthy();
  });

  it("SSO-Konten ohne Passwort können sich nicht per Passwort anmelden", async () => {
    await ssoFlow();
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "anna@example.org", password: GOOD_PASSWORD } });
    expect(res.statusCode).toBe(401);
  });
});

describe("Fehler- und Angriffsfälle", () => {
  it("bricht ab, wenn der Anbieter die Anmeldung ablehnt (access_denied)", async () => {
    idp.setBehaviour({ deny: true });
    const { callback } = await ssoFlow();
    expect(errorOf(callback)).toBe("sso_denied");
    expect(cookieValue(callback, "session")).toBeUndefined();
  });

  it("weist einen veränderten state zurück", async () => {
    const { callback } = await ssoFlow({ tamperState: true });
    expect(errorOf(callback)).toBe("sso_failed");
    expect(cookieValue(callback, "session")).toBeUndefined();
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  it("verlangt das Ablauf-Cookie: ohne, manipuliert oder fremd → sso_flow_expired", async () => {
    expect(errorOf((await ssoFlow({ dropCookie: true })).callback)).toBe("sso_flow_expired");
    const { callbackUrl, flowCookie } = await ssoFlow();
    const tampered = flowCookie!.slice(0, -3) + "AAA";
    expect(errorOf(await app.inject({ method: "GET", url: callbackUrl, cookies: { oidc_flow: tampered } }))).toBe("sso_flow_expired");
    expect(errorOf(await app.inject({ method: "GET", url: "/api/v1/auth/oidc/callback?code=x&state=y" }))).toBe("sso_flow_expired");
    expect(db.select().from(schema.users).all()).toHaveLength(1); // nur der eine erfolgreiche Durchlauf oben
  });

  it("lässt den Ablauf nach 10 Minuten verfallen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
    const authorized = await fetch(location(start), { redirect: "manual" });
    const back = new URL(authorized.headers.get("location")!);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const res = await app.inject({ method: "GET", url: back.pathname + back.search, cookies: { oidc_flow: cookieValue(start, "oidc_flow")! } });
    expect(errorOf(res)).toBe("sso_flow_expired");
  });

  it("weist ID-Token mit falscher nonce, falscher Zielgruppe, falschem Aussteller und abgelaufene Token ab", async () => {
    const cases: [string, Parameters<FakeIdp["setBehaviour"]>[0]][] = [
      ["nonce", { nonce: "fremde-nonce" }], ["audience", { audience: "anderer-client" }],
      ["issuer", { issuer: "http://evil.example" }], ["abgelaufen", { expiresInSeconds: -120 }],
    ];
    for (const [label, behaviour] of cases) {
      idp.setBehaviour(behaviour);
      const { callback } = await ssoFlow();
      expect(errorOf(callback), label).toBe("sso_failed");
      expect(cookieValue(callback, "session"), label).toBeUndefined();
    }
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  it("verwendet Autorisierungscodes nicht zweimal (Replay) und meldet Fehler des Token-Endpunkts", async () => {
    const first = await ssoFlow();
    expect(cookieValue(first.callback, "session")).toBeDefined();
    const replay = await app.inject({ method: "GET", url: first.callbackUrl, cookies: { oidc_flow: first.flowCookie! } });
    expect(errorOf(replay)).toBe("sso_failed");
    idp.setBehaviour({ tokenError: true });
    expect(errorOf((await ssoFlow()).callback)).toBe("sso_failed");
  });

  it("gibt weder Codes, state, Token noch Cookies ins Log", async () => {
    const { callbackUrl, flowCookie, callback } = await ssoFlow();
    const params = new URL(`${BASE}${callbackUrl}`).searchParams;
    const log = logLines.join("\n");
    for (const secret of [params.get("code")!, params.get("state")!, flowCookie!, cookieValue(callback, "session")!, "id_token", idp.clientSecret]) {
      expect(log, secret.slice(0, 12)).not.toContain(secret);
    }
    expect(log).toContain('"event":"sso_user_created"');
  });
});

describe("Verknüpfen und Lösen im Profil", () => {
  it("verknüpft bewusst mit dem angemeldeten Konto – unabhängig von der E-Mail beim Anbieter", async () => {
    const bob = await newUser(app, "bob@example.org", "Bob");
    idp.setUser({ sub: "bobs-sso", email: "ganz-andere@example.org", email_verified: true });
    const { callback } = await ssoFlow({ link: true, cookies: { session: bob.session } });
    expect(location(callback)).toBe(`${BASE}/?sso=linked`);
    expect(cookieValue(callback, "session")).toBeUndefined(); // keine neue Sitzung nötig
    expect((await bob.get("/api/v1/me/sso")).json()).toEqual({ enabled: true, name: "Authentik", linked: true });
    expect(db.select().from(schema.users).all()).toHaveLength(1); // kein zweites Konto
    // künftig meldet SSO an Bobs Konto an
    const login = await ssoFlow();
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", cookies: { session: cookieValue(login.callback, "session")! } })).json().user;
    expect(me.email).toBe("bob@example.org");
  });

  it("ignoriert link=1 ohne Anmeldung (normaler Login)", async () => {
    const { callback } = await ssoFlow({ link: true });
    expect(location(callback)).toBe(`${BASE}/`);
    expect(cookieValue(callback, "session")).toBeDefined();
  });

  it("verweigert das Verknüpfen einer Identität, die schon einem anderen Konto gehört", async () => {
    await ssoFlow(); // sub-1 gehört jetzt zu Anna (per SSO angelegt)
    const bob = await newUser(app, "bob@example.org", "Bob");
    const { callback } = await ssoFlow({ link: true, cookies: { session: bob.session } });
    expect(errorOf(callback)).toBe("sso_already_linked");
    expect(db.select().from(schema.userIdentities).all()).toHaveLength(1);
  });

  it("lösen verlangt ein Passwort im Konto und das richtige Passwort; reine SSO-Konten dürfen nicht lösen", async () => {
    const bob = await newUser(app, "bob@example.org", "Bob");
    idp.setUser({ sub: "bobs-sso", email: "bob@example.org", email_verified: true });
    await ssoFlow({ link: true, cookies: { session: bob.session } });
    expect((await bob.post("/api/v1/me/sso/unlink", { password: "falsch-falsch-falsch" })).statusCode).toBe(403);
    expect((await bob.post("/api/v1/me/sso/unlink", { password: GOOD_PASSWORD })).statusCode).toBe(204);
    expect((await bob.get("/api/v1/me/sso")).json().linked).toBe(false);
    expect((await bob.post("/api/v1/me/sso/unlink", { password: GOOD_PASSWORD })).statusCode).toBe(404);

    idp.setUser({ sub: "nur-sso", email: "kai@example.org", email_verified: true });
    const { callback } = await ssoFlow();
    const kai = cookieValue(callback, "session")!;
    const res = await app.inject({ method: "POST", url: "/api/v1/me/sso/unlink", payload: { password: "egal" }, cookies: { session: kai } });
    expect([res.statusCode, res.json().error]).toEqual([409, "password_required"]);
  });

  it("Verwaltung ist Sache der Browser-Sitzung: API-Token und Anonyme werden abgewiesen", async () => {
    const bob = await newUser(app, "bob@example.org", "Bob");
    const token = (await bob.post("/api/v1/me/tokens", { name: "t", permission: "write" })).json().token as string;
    for (const [method, url] of [["GET", "/api/v1/me/sso"], ["POST", "/api/v1/me/sso/unlink"]] as const) {
      const asToken = await app.inject({ method, url, payload: { password: GOOD_PASSWORD }, headers: { authorization: `Bearer ${token}` } });
      expect([url, asToken.statusCode]).toEqual([url, 403]);
      expect((await app.inject({ method, url, payload: { password: GOOD_PASSWORD } })).statusCode).toBe(401);
    }
  });
});
