import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase, schema } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { checkPasswordPolicy } from "../src/auth/password.js";
import { buildServer } from "../src/server.js";
import type { Mailer } from "../src/mail.js";

const GOOD = "Kaffeetasse-Wolke-42";
const baseEnv = { APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "error" };

function setup(env: Record<string, string> = {}, withMail = true) {
  const config = loadConfig({ ...baseEnv, ...env });
  const db = openDatabase(":memory:");
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer | null = withMail ? { send: async (m) => void sent.push(m) } : null;
  const app = buildServer({ config, db, logger: createLogger(config), mailer });
  return { app, db, sent, config };
}

type App = ReturnType<typeof setup>["app"];

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === "session")?.value;

async function register(app: App, email = "anna@example.org", password = GOOD, displayName = "Anna Muster") {
  return app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, displayName, password } });
}
async function login(app: App, email = "anna@example.org", password = GOOD) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
}
const withSession = (token: string | undefined) => ({ cookies: { session: token ?? "" } });

describe("Passwort-Richtlinie (F-03)", () => {
  const ctx = { email: "anna@example.org", displayName: "Anna Muster" };
  const check = (pw: string, mode: "local" | "hibp" | "off" = "local", hibp?: (p: string) => Promise<boolean>) =>
    checkPasswordPolicy(pw, ctx, mode, hibp);

  it("verlangt mindestens 12 Zeichen, erlaubt aber Leerzeichen und kennt keine Zusammensetzungsregeln", async () => {
    expect(await check("kurz")).toEqual(["too_short"]);
    expect(await check("a".repeat(129))).toEqual(["too_long"]);
    expect(await check("nur kleine buchstaben hier")).toEqual([]);
  });

  it("zählt Unicode-Zeichen statt Bytes", async () => {
    expect(await check("äöüäöüäöüäöü")).not.toContain("too_short"); // 12 Zeichen
    expect(await check("äöüäöüäöüäö")).toEqual(["too_short"]); // 11 Zeichen
  });

  it("lehnt triviale und häufige Passwörter ab", async () => {
    expect(await check("aaaaaaaaaaaa")).toContain("too_common");
    expect(await check("123456789012")).toContain("too_common");
    expect(await check("abcdefghijkl")).toContain("too_common");
    expect(await check("Password 12345")).toContain("too_common");
  });

  it("lehnt Passwörter mit E-Mail-Teil oder Namen ab", async () => {
    expect(await check("xxBeispielxx99-ab")).toEqual([]); // fremde Namen sind erlaubt
    expect(await check("meinMuster-geheim-77")).toContain("contains_identity");
    expect(await check("annas-anna-passwort")).toContain("contains_identity");
  });

  it("nutzt bei hibp den Dienst und fällt bei Ausfall auf die lokale Prüfung zurück", async () => {
    expect(await check(GOOD, "hibp", async () => true)).toEqual(["breached"]);
    expect(await check(GOOD, "hibp", async () => false)).toEqual([]);
    expect(await check(GOOD, "hibp", async () => { throw new Error("offline"); })).toEqual([]);
  });
});

describe("Registrierung (F-01)", () => {
  it("legt Nutzer an, setzt sicheres Cookie und liefert kein Passwort-Hash", async () => {
    const { app } = setup();
    const res = await register(app);
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === "session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(String(cookie.sameSite).toLowerCase()).toBe("lax");
    expect(JSON.stringify(res.json())).not.toMatch(/hash|\$argon2/i);
    expect(res.json().user).toMatchObject({ email: "anna@example.org", language: "de", trashRetentionDays: 30 });
  });

  it("markiert das Cookie bei https-URL als Secure", async () => {
    const { app } = setup({ APP_BASE_URL: "https://checklisten.example.org" });
    const res = await register(app);
    expect(res.cookies.find((c) => c.name === "session")!.secure).toBe(true);
  });

  it("speichert das Passwort nur als argon2id-Hash und das Sitzungstoken nur als Hash", async () => {
    const { app, db } = setup();
    const res = await register(app);
    const [u] = db.select().from(schema.users).all();
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(db.select().from(schema.sessions).all().map((s) => s.id)).not.toContain(cookieOf(res));
  });

  it("normalisiert E-Mail (Groß-/Kleinschreibung) und verhindert Duplikate", async () => {
    const { app } = setup();
    await register(app, "Anna@Example.org");
    expect((await register(app, "anna@example.org")).statusCode).toBe(409);
  });

  it("lehnt schwache Passwörter ab (422) und ungültige Eingaben (400)", async () => {
    const { app } = setup();
    const weak = await register(app, "b@example.org", "kurz");
    expect(weak.statusCode).toBe(422);
    expect(weak.json()).toEqual({ error: "password_policy", problems: ["too_short"] });
    expect((await register(app, "kein-email", GOOD)).statusCode).toBe(400);
  });

  it("ist bei REGISTRATION_ENABLED=false gesperrt", async () => {
    const { app, db } = setup({ REGISTRATION_ENABLED: "false" });
    const res = await register(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("registration_disabled");
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  it("übernimmt Standardwerte aus der Konfiguration (Sprache, Papierkorb)", async () => {
    const { app } = setup({ DEFAULT_LANGUAGE: "en", TRASH_RETENTION_DAYS: "0" });
    const res = await register(app);
    expect(res.json().user).toMatchObject({ language: "en", trashRetentionDays: null });
  });
});

describe("Login, Logout, Sitzung (F-02, F-04)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await register(ctx.app);
  });

  it("meldet mit richtigen Daten an und gibt Zugriff auf /me", async () => {
    const res = await login(ctx.app, "ANNA@example.org");
    expect(res.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: "GET", url: "/api/v1/me", ...withSession(cookieOf(res)) });
    expect(me.json().user.email).toBe("anna@example.org");
  });

  it("verweigert falsche Passwörter und unbekannte Nutzer gleich (401)", async () => {
    const a = await login(ctx.app, "anna@example.org", "falsch-falsch-falsch");
    const b = await login(ctx.app, "niemand@example.org", "falsch-falsch-falsch");
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
  });

  it("verlangt Anmeldung für geschützte Routen", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me", ...withSession("gefälscht") })).statusCode).toBe(401);
  });

  it("beendet die Sitzung beim Logout", async () => {
    const token = cookieOf(await login(ctx.app));
    expect((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/logout", ...withSession(token) })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me", ...withSession(token) })).statusCode).toBe(401);
  });

  it("sperrt nach 5 Fehlversuchen vorübergehend – auch bei richtigem Passwort", async () => {
    for (let i = 0; i < 5; i++) await login(ctx.app, "anna@example.org", "falsch-falsch-falsch");
    const blocked = await login(ctx.app);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("lässt Nutzer nach erfolgreichem Login wieder frei (Zähler zurückgesetzt)", async () => {
    for (let i = 0; i < 4; i++) await login(ctx.app, "anna@example.org", "falsch-falsch-falsch");
    expect((await login(ctx.app)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await login(ctx.app, "anna@example.org", "falsch-falsch-falsch");
    expect((await login(ctx.app)).statusCode).toBe(200);
  });

  it("lehnt schreibende Anfragen von fremdem Origin ab (CSRF)", async () => {
    const token = cookieOf(await login(ctx.app));
    const res = await ctx.app.inject({
      method: "PUT", url: "/api/v1/me", payload: { displayName: "Hacker" },
      headers: { origin: "https://evil.example" }, ...withSession(token),
    });
    expect(res.statusCode).toBe(403);
    const ok = await ctx.app.inject({
      method: "PUT", url: "/api/v1/me", payload: { displayName: "Anna 2" },
      headers: { origin: "http://localhost:3000" }, ...withSession(token),
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("Profil (F-05)", () => {
  it("ändert Anzeigename, Sprache, Design und Papierkorb-Aufbewahrung", async () => {
    const { app } = setup();
    const token = cookieOf(await register(app));
    const res = await app.inject({
      method: "PUT", url: "/api/v1/me", ...withSession(token),
      payload: { displayName: "Anna M.", language: "en", theme: "dark", trashRetentionDays: null },
    });
    expect(res.json().user).toMatchObject({ displayName: "Anna M.", language: "en", theme: "dark", trashRetentionDays: null });
  });

  it("lehnt ungültige Werte ab", async () => {
    const { app } = setup();
    const token = cookieOf(await register(app));
    for (const payload of [{ language: "fr" }, { trashRetentionDays: 5 }, { theme: "neon" }, {}]) {
      expect((await app.inject({ method: "PUT", url: "/api/v1/me", ...withSession(token), payload })).statusCode).toBe(400);
    }
  });

  it("verlangt für E-Mail-Änderung das aktuelle Passwort und verhindert Duplikate", async () => {
    const { app } = setup();
    await register(app, "bob@example.org", GOOD, "Bob");
    const token = cookieOf(await register(app));
    const put = (payload: object) => app.inject({ method: "PUT", url: "/api/v1/me", ...withSession(token), payload });
    expect((await put({ email: "neu@example.org" })).statusCode).toBe(403);
    expect((await put({ email: "bob@example.org", currentPassword: GOOD })).statusCode).toBe(409);
    const ok = await put({ email: "Neu@Example.org", currentPassword: GOOD });
    expect(ok.json().user.email).toBe("neu@example.org");
  });
});

describe("Passwort ändern (F-06)", () => {
  it("prüft altes Passwort und Richtlinie, beendet andere Sitzungen, behält die aktuelle", async () => {
    const { app } = setup();
    const current = cookieOf(await register(app));
    const other = cookieOf(await login(app));
    const change = (currentPassword: string, newPassword: string) =>
      app.inject({ method: "POST", url: "/api/v1/me/password", ...withSession(current), payload: { currentPassword, newPassword } });

    expect((await change("falsch-falsch-falsch", "Neues-Passwort-4711")).statusCode).toBe(403);
    expect((await change(GOOD, "zukurz")).statusCode).toBe(422);
    expect((await change(GOOD, "Neues-Passwort-4711")).statusCode).toBe(204);

    expect((await app.inject({ method: "GET", url: "/api/v1/me", ...withSession(current) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", ...withSession(other) })).statusCode).toBe(401);
    expect((await login(app, "anna@example.org", GOOD)).statusCode).toBe(401);
    expect((await login(app, "anna@example.org", "Neues-Passwort-4711")).statusCode).toBe(200);
  });
});

describe("Passwort vergessen (F-07)", () => {
  const tokenFromMail = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

  it("ist ohne SMTP nicht verfügbar", async () => {
    const { app } = setup({}, false);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "a@example.org" } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/config" })).json().smtpEnabled).toBe(false);
  });

  it("antwortet immer gleich und versendet nur für existierende Konten", async () => {
    const { app, sent } = setup();
    await register(app);
    const known = await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "anna@example.org" } });
    const unknown = await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "x@example.org" } });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.json()).toEqual(unknown.json());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("anna@example.org");
    expect(sent[0]!.text).toContain("http://localhost:3000/reset-password?token=");
  });

  it("setzt Passwort mit einmaligem Token zurück, beendet Sitzungen und verwirft Wiederverwendung", async () => {
    const { app, sent } = setup();
    const session = cookieOf(await register(app));
    await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "anna@example.org" } });
    const token = tokenFromMail(sent[0]!.text);
    const reset = (password: string) => app.inject({ method: "POST", url: "/api/v1/auth/reset", payload: { token, password } });

    expect((await reset("zukurz")).statusCode).toBe(422);
    expect((await reset("Frisches-Passwort-99")).statusCode).toBe(200);
    expect((await reset("Noch-ein-Passwort-123")).statusCode).toBe(400); // Token verbraucht
    expect((await app.inject({ method: "GET", url: "/api/v1/me", ...withSession(session) })).statusCode).toBe(401);
    expect((await login(app, "anna@example.org", "Frisches-Passwort-99")).statusCode).toBe(200);
  });

  it("lehnt abgelaufene und erfundene Token ab; speichert nur den Hash", async () => {
    const { app, db, sent } = setup();
    await register(app);
    await app.inject({ method: "POST", url: "/api/v1/auth/forgot", payload: { email: "anna@example.org" } });
    const token = tokenFromMail(sent[0]!.text);
    const [row] = db.select().from(schema.passwordResets).all();
    expect(row!.tokenHash).not.toBe(token);
    db.update(schema.passwordResets).set({ expiresAt: Date.now() - 1000 }).run();
    const expired = await app.inject({ method: "POST", url: "/api/v1/auth/reset", payload: { token, password: "Frisches-Passwort-99" } });
    expect(expired.statusCode).toBe(400);
    const fake = await app.inject({ method: "POST", url: "/api/v1/auth/reset", payload: { token: "x".repeat(43), password: "Frisches-Passwort-99" } });
    expect(fake.statusCode).toBe(400);
  });
});

describe("Konto löschen (F-52)", () => {
  it("entfernt Konto samt Daten nach Passwortbestätigung", async () => {
    const { app, db } = setup();
    const token = cookieOf(await register(app));
    const user = db.select().from(schema.users).get()!;
    db.insert(schema.templates).values({ ownerId: user.id, title: "T" }).run();
    const del = (password: string) => app.inject({ method: "DELETE", url: "/api/v1/me", ...withSession(token), payload: { password } });
    expect((await del("falsch-falsch-falsch")).statusCode).toBe(403);
    expect((await del(GOOD)).statusCode).toBe(204);
    expect(db.select().from(schema.users).all()).toHaveLength(0);
    expect(db.select().from(schema.templates).all()).toHaveLength(0);
    expect(db.select().from(schema.sessions).all()).toHaveLength(0);
  });
});
