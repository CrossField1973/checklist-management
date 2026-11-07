import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import { checkSecondFactor } from "../src/auth/two-factor.js";
import { schema } from "../src/db/index.js";
import { GOOD_PASSWORD, newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;

let ctx: ReturnType<typeof setupApp>;
let anna: Client;

// Nur Date wird gefälscht: so lässt sich die Zeit um volle TOTP-Schritte vorstellen, ohne Timer anzuhalten.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});
afterEach(() => vi.useRealTimers());

/** Schaltet die Uhr um einen vollen TOTP-Schritt (+ Puffer) weiter, damit ein neuer Code gilt. */
const nextStep = () => vi.setSystemTime(Date.now() + 31_000);

async function enable2fa(client: Client = anna) {
  const setup = (await client.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD })).json();
  const res = await client.post("/api/v1/me/2fa/enable", { code: totpCode(setup.secret) });
  return { secret: setup.secret as string, recoveryCodes: res.json().recoveryCodes as string[], res };
}
const login = (payload: object) => ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
const loginWith = (code?: string, password = GOOD_PASSWORD) => login({ email: "anna@example.org", password, ...(code !== undefined && { code }) });

describe("Einrichten und Aktivieren (F-08)", () => {
  it("setup liefert Geheimnis und otpauth-URL, verlangt das Passwort und ist noch nicht aktiv", async () => {
    expect((await anna.post("/api/v1/me/2fa/setup", {})).statusCode).toBe(403);
    expect((await anna.post("/api/v1/me/2fa/setup", { password: "falsch-falsch-falsch" })).statusCode).toBe(403);
    const res = await anna.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.json().otpauthUrl).toContain(`secret=${res.json().secret}`);
    expect(res.json().otpauthUrl).toContain("anna%40example.org");
    expect((await anna.get("/api/v1/me/2fa")).json()).toMatchObject({ enabled: false, pendingSetup: true, recoveryCodesRemaining: 0 });
    // solange nicht bestätigt, verlangt die Anmeldung keinen Code
    expect((await loginWith()).statusCode).toBe(200);
  });

  it("speichert das Geheimnis nur verschlüsselt", async () => {
    const setup = (await anna.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD })).json();
    const stored = ctx.db.select().from(schema.users).get()!.totpSecret!;
    expect(stored).not.toContain(setup.secret);
    expect(stored.split(".")).toHaveLength(3);
  });

  it("aktivieren braucht einen gültigen Code; falsche Codes werden abgelehnt und gesperrt", async () => {
    await anna.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD });
    expect((await anna.post("/api/v1/me/2fa/enable", { code: "123456" })).json().error).toBe("invalid_code");
    expect((await anna.post("/api/v1/me/2fa/enable", { code: "abc" })).statusCode).toBe(400);
    expect((await anna.get("/api/v1/me/2fa")).json().enabled).toBe(false);
    for (let i = 0; i < 4; i++) await anna.post("/api/v1/me/2fa/enable", { code: "000000" });
    const blocked = await anna.post("/api/v1/me/2fa/enable", { code: "000000" });
    expect(blocked.statusCode).toBe(429);
  });

  it("enable ohne vorheriges setup ist nicht möglich (409)", async () => {
    const res = await anna.post("/api/v1/me/2fa/enable", { code: "123456" });
    expect([res.statusCode, res.json().error]).toEqual([409, "setup_required"]);
  });

  it("aktiviert 2FA, liefert 10 Wiederherstellungscodes (nur gehasht gespeichert) und beendet andere Sitzungen", async () => {
    const other = (await login({ email: "anna@example.org", password: GOOD_PASSWORD })).cookies.find((c) => c.name === "session")!.value;
    const { recoveryCodes, res } = await enable2fa();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.twoFactorEnabled).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect((await anna.get("/api/v1/me")).statusCode).toBe(200); // aktuelle Sitzung bleibt
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me", cookies: { session: other } })).statusCode).toBe(401);
    const rows = ctx.db.select().from(schema.recoveryCodes).all();
    expect(rows).toHaveLength(10);
    for (const code of recoveryCodes) expect(JSON.stringify(rows)).not.toContain(code.replace("-", ""));
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash))).toBe(true);
    expect((await anna.get("/api/v1/me/2fa")).json()).toMatchObject({ enabled: true, pendingSetup: false, recoveryCodesRemaining: 10 });
    expect((await anna.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD })).statusCode).toBe(409);
  });
});

describe("Anmeldung mit zweitem Faktor", () => {
  it("verlangt nach dem Passwort den Code: ohne Code 401 two_factor_required (ohne Sitzung), mit falschem 401 invalid_code", async () => {
    await enable2fa();
    nextStep();
    const none = await loginWith();
    expect([none.statusCode, none.json().error]).toEqual([401, "two_factor_required"]);
    expect(none.cookies.find((c) => c.name === "session")).toBeUndefined();
    const wrong = await loginWith("000000");
    expect([wrong.statusCode, wrong.json().error]).toEqual([401, "invalid_code"]);
    expect(wrong.cookies.find((c) => c.name === "session")).toBeUndefined();
  });

  it("verrät nicht, ob 2FA aktiv ist, solange das Passwort falsch ist", async () => {
    await enable2fa();
    const res = await loginWith(undefined, "falsch-falsch-falsch");
    expect([res.statusCode, res.json().error]).toEqual([401, "invalid_credentials"]);
  });

  it("meldet mit richtigem Code an; derselbe Code funktioniert kein zweites Mal (Replay-Schutz)", async () => {
    const { secret } = await enable2fa();
    nextStep();
    const code = totpCode(secret);
    const ok = await loginWith(code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.twoFactorEnabled).toBe(true);
    expect(ok.cookies.find((c) => c.name === "session")).toBeDefined();
    expect((await loginWith(code)).json().error).toBe("invalid_code");
    // der unmittelbar vorige Code (noch im Zeitfenster) ist ebenfalls verbraucht bzw. älter
    nextStep();
    expect((await loginWith(totpCode(secret))).statusCode).toBe(200);
  });

  it("der bei der Aktivierung benutzte Code kann nicht für die Anmeldung wiederverwendet werden", async () => {
    const setup = (await anna.post("/api/v1/me/2fa/setup", { password: GOOD_PASSWORD })).json();
    const code = totpCode(setup.secret);
    await anna.post("/api/v1/me/2fa/enable", { code });
    expect((await loginWith(code)).json().error).toBe("invalid_code");
  });

  it("Wiederherstellungscode: funktioniert einmal (auch in anderer Schreibweise), meldet verbleibende Anzahl", async () => {
    const { recoveryCodes } = await enable2fa();
    const first = recoveryCodes[0]!;
    const ok = await loginWith(first.toLowerCase().replace("-", " "));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodesRemaining).toBe(9);
    expect((await loginWith(first)).json().error).toBe("invalid_code");
    expect((await loginWith(recoveryCodes[1]!)).statusCode).toBe(200);
    expect((await anna.get("/api/v1/me/2fa")).json().recoveryCodesRemaining).toBe(8);
  });

  it("sperrt nach 5 Fehlversuchen auch für richtige Codes (Brute-Force-Schutz)", async () => {
    const { secret } = await enable2fa();
    nextStep();
    for (let i = 0; i < 5; i++) await loginWith("000000");
    const blocked = await loginWith(totpCode(secret));
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("Konten ohne 2FA melden sich weiter nur mit Passwort an und ignorieren einen mitgesendeten Code", async () => {
    expect((await loginWith()).statusCode).toBe(200);
    expect((await loginWith("123456")).statusCode).toBe(200);
  });

  it("2FA bleibt nach einer Passwortänderung aktiv", async () => {
    const { secret } = await enable2fa();
    await anna.post("/api/v1/me/password", { currentPassword: GOOD_PASSWORD, newPassword: "Ganz-neues-Passwort-77" });
    nextStep();
    expect((await loginWith(undefined, "Ganz-neues-Passwort-77")).json().error).toBe("two_factor_required");
    expect((await loginWith(totpCode(secret), "Ganz-neues-Passwort-77")).statusCode).toBe(200);
  });

  it("gilt nicht für API-Token (Automatisierung bleibt möglich) – die Token-Verwaltung selbst ist Sitzungssache", async () => {
    const token = (await anna.post("/api/v1/me/tokens", { name: "Skript", permission: "write" })).json().token as string;
    await enable2fa();
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe("Gleichzeitige Anfragen (Wettlauf)", () => {
  it("lässt einen TOTP-Code auch dann nur einmal gelten, wenn zwei Anfragen denselben Nutzerstand gelesen haben", async () => {
    const { secret } = await enable2fa();
    nextStep();
    const stale = ctx.db.select().from(schema.users).get()!; // beide „Anfragen“ sehen noch den alten Zeitschritt
    const code = totpCode(secret);
    const results = [checkSecondFactor(ctx.db, ctx.config, stale, code), checkSecondFactor(ctx.db, ctx.config, stale, code)];
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });

  it("verbraucht einen Wiederherstellungscode atomar: bei zwei gleichzeitigen Versuchen gewinnt nur einer", async () => {
    const { recoveryCodes } = await enable2fa();
    const stale = ctx.db.select().from(schema.users).get()!;
    const results = [checkSecondFactor(ctx.db, ctx.config, stale, recoveryCodes[0]!), checkSecondFactor(ctx.db, ctx.config, stale, recoveryCodes[0]!)];
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe("Deaktivieren und Wiederherstellungscodes erneuern", () => {
  it("deaktivieren verlangt Passwort und gültigen Code; danach gilt wieder nur das Passwort", async () => {
    const { secret, recoveryCodes } = await enable2fa();
    nextStep();
    expect((await anna.post("/api/v1/me/2fa/disable", { code: totpCode(secret) })).statusCode).toBe(403); // ohne Passwort
    expect((await anna.post("/api/v1/me/2fa/disable", { password: GOOD_PASSWORD, code: "000000" })).json().error).toBe("invalid_code");
    expect((await anna.post("/api/v1/me/2fa/disable", { password: GOOD_PASSWORD, code: totpCode(secret) })).statusCode).toBe(204);
    const user = ctx.db.select().from(schema.users).get()!;
    expect([user.totpSecret, user.totpEnabledAt, user.totpLastStep]).toEqual([null, null, null]);
    expect(ctx.db.select().from(schema.recoveryCodes).all()).toHaveLength(0);
    expect((await loginWith()).statusCode).toBe(200);
    expect((await loginWith(recoveryCodes[0])).statusCode).toBe(200); // Code wird ignoriert
    expect((await anna.post("/api/v1/me/2fa/disable", { password: GOOD_PASSWORD, code: "123456" })).json().error).toBe("not_enabled");
  });

  it("deaktivieren ist auch mit einem Wiederherstellungscode möglich (Gerät verloren)", async () => {
    const { recoveryCodes } = await enable2fa();
    const res = await anna.post("/api/v1/me/2fa/disable", { password: GOOD_PASSWORD, code: recoveryCodes[3] });
    expect(res.statusCode).toBe(204);
  });

  it("erneuert Wiederherstellungscodes: alte werden ungültig, neue funktionieren", async () => {
    const { secret, recoveryCodes } = await enable2fa();
    nextStep();
    expect((await anna.post("/api/v1/me/2fa/recovery-codes", { password: GOOD_PASSWORD, code: "000000" })).statusCode).toBe(403);
    const res = await anna.post("/api/v1/me/2fa/recovery-codes", { password: GOOD_PASSWORD, code: totpCode(secret) });
    const fresh = res.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    expect((await loginWith(recoveryCodes[0])).json().error).toBe("invalid_code");
    expect((await loginWith(fresh[0])).statusCode).toBe(200);
  });

  it("alle Verwaltungsaktionen gehören der Browser-Sitzung: API-Token und Anonyme werden abgewiesen", async () => {
    const token = (await anna.post("/api/v1/me/tokens", { name: "t", permission: "write" })).json().token as string;
    const calls: [string, string, object?][] = [
      ["GET", "/api/v1/me/2fa"], ["POST", "/api/v1/me/2fa/setup", { password: GOOD_PASSWORD }], ["POST", "/api/v1/me/2fa/enable", { code: "123456" }],
      ["POST", "/api/v1/me/2fa/disable", { code: "123456" }], ["POST", "/api/v1/me/2fa/recovery-codes", { code: "123456" }],
    ];
    for (const [method, url, payload] of calls) {
      const asToken = await ctx.app.inject({ method: method as "GET", url, payload, headers: { authorization: `Bearer ${token}` } });
      expect([url, asToken.statusCode, asToken.json().error]).toEqual([url, 403, "session_required"]);
      expect((await ctx.app.inject({ method: method as "GET", url, payload })).statusCode).toBe(401);
    }
  });

  it("trennt Nutzer: 2FA von Anna beeinflusst Bob nicht", async () => {
    await enable2fa();
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    expect((await bob.get("/api/v1/me/2fa")).json().enabled).toBe(false);
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "bob@example.org", password: GOOD_PASSWORD } });
    expect(res.statusCode).toBe(200);
  });
});
