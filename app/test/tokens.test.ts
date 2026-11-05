import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TokenRateLimiter } from "../src/auth/api-tokens.js";
import { schema } from "../src/db/index.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
const DAY = 24 * 60 * 60 * 1000;

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

const createToken = async (client: Client, body: object = { name: "Test", permission: "write" }) => {
  const res = await client.post("/api/v1/me/tokens", body);
  return { res, token: res.json().token as string, dto: res.json().apiToken as { id: string; prefix: string; permission: string; expiresAt: number | null; expired: boolean; lastUsedAt: number | null } };
};
const bearer = (token: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", url = "/api/v1/templates", payload?: object) =>
  ctx.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

describe("Token anlegen und verwalten (F-61)", () => {
  it("liefert den Klartext genau einmal; gespeichert werden nur Hash und Präfix", async () => {
    const { res, token, dto } = await createToken(anna);
    expect(res.statusCode).toBe(201);
    expect(token).toMatch(/^ck_[\w-]{40,}$/);
    expect(dto.prefix).toBe(token.slice(0, 8));
    const row = ctx.db.select().from(schema.apiTokens).get()!;
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await anna.get("/api/v1/me/tokens");
    expect(JSON.stringify(list.json())).not.toContain(token);
    expect(list.json().tokens[0]).toMatchObject({ name: "Test", permission: "write", expired: false, lastUsedAt: null });
  });

  it("erzeugt für jeden Token einen eigenen Wert", async () => {
    const a = await createToken(anna, { name: "A", permission: "read" });
    const b = await createToken(anna, { name: "B", permission: "read" });
    expect(a.token).not.toBe(b.token);
  });

  it("validiert Name, Rechte und Ablaufdatum", async () => {
    for (const body of [{ name: " ", permission: "read" }, { name: "x", permission: "admin" }, { permission: "read" }, { name: "x", permission: "read", expiresAt: "morgen" }]) {
      expect((await anna.post("/api/v1/me/tokens", body)).statusCode).toBe(400);
    }
    const past = new Date(Date.now() - DAY).toISOString();
    const far = new Date(Date.now() + 11 * 365 * DAY).toISOString();
    for (const expiresAt of [past, far]) {
      const res = await anna.post("/api/v1/me/tokens", { name: "x", permission: "read", expiresAt });
      expect([res.statusCode, res.json().error]).toEqual([422, "invalid_expiry"]);
    }
    const ok = await anna.post("/api/v1/me/tokens", { name: "x", permission: "read", expiresAt: new Date(Date.now() + DAY).toISOString() });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiToken.expiresAt).toBeGreaterThan(Date.now());
  });

  it("begrenzt die Anzahl aktiver Token auf 50 (widerrufene zählen nicht)", async () => {
    for (let i = 0; i < 50; i++) await createToken(anna, { name: `T${i}`, permission: "read" });
    const res = await anna.post("/api/v1/me/tokens", { name: "zu viel", permission: "read" });
    expect([res.statusCode, res.json().error]).toEqual([422, "too_many_tokens"]);
    const first = (await anna.get("/api/v1/me/tokens")).json().tokens[0];
    await anna.del(`/api/v1/me/tokens/${first.id}`);
    expect((await anna.post("/api/v1/me/tokens", { name: "passt", permission: "read" })).statusCode).toBe(201);
  });

  it("widerruft Token; danach ist er ungültig und verschwindet aus der Liste", async () => {
    const { token, dto } = await createToken(anna);
    expect((await bearer(token)).statusCode).toBe(200);
    expect((await anna.del(`/api/v1/me/tokens/${dto.id}`)).statusCode).toBe(204);
    const res = await bearer(token);
    expect([res.statusCode, res.json().error]).toEqual([401, "invalid_token"]);
    expect((await anna.get("/api/v1/me/tokens")).json().tokens).toEqual([]);
    expect((await anna.del(`/api/v1/me/tokens/${dto.id}`)).statusCode).toBe(404);
  });

  it("zeigt und widerruft nur eigene Token", async () => {
    const { token, dto } = await createToken(anna);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    expect((await bob.get("/api/v1/me/tokens")).json().tokens).toEqual([]);
    expect((await bob.del(`/api/v1/me/tokens/${dto.id}`)).statusCode).toBe(404);
    expect((await bearer(token)).statusCode).toBe(200);
  });

  it("löscht Token beim Löschen des Kontos; der Token ist danach ungültig", async () => {
    const { token } = await createToken(anna);
    const del = await ctx.app.inject({ method: "DELETE", url: "/api/v1/me", payload: { password: "Kaffeetasse-Wolke-42" }, cookies: { session: anna.session } });
    expect(del.statusCode).toBe(204);
    expect(ctx.db.select().from(schema.apiTokens).all()).toHaveLength(0);
    expect((await bearer(token)).statusCode).toBe(401);
  });
});

describe("Anmeldung per Bearer-Token (F-62)", () => {
  it("handelt als der Besitzer und sieht nur dessen Daten", async () => {
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    await anna.post("/api/v1/templates", { title: "Annas Vorlage" });
    await bob.post("/api/v1/templates", { title: "Bobs Vorlage" });
    const { token } = await createToken(anna);
    const list = (await bearer(token)).json();
    expect(list.templates.map((t: { title: string }) => t.title)).toEqual(["Annas Vorlage"]);
    expect((await bearer(token, "GET", "/api/v1/me")).json().user.email).toBe("anna@example.org");
  });

  it("akzeptiert die Schreibweise „bearer“ und lehnt falsche Formate ab", async () => {
    const { token } = await createToken(anna);
    const lower = await ctx.app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: `bearer ${token}` } });
    expect(lower.statusCode).toBe(200);
    for (const authorization of [token, `Basic ${token}`, "Bearer", `Bearer ${token} extra`, "Bearer ck_falsch", "Bearer irgendwas"]) {
      const res = await ctx.app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization } });
      expect([res.statusCode, res.json().error]).toEqual([401, "invalid_token"]);
    }
  });

  it("fällt bei ungültigem Token nicht auf ein gültiges Cookie zurück", async () => {
    const session = ctx.db.select().from(schema.sessions).get();
    expect(session).toBeTruthy();
    const login = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "anna@example.org", password: "Kaffeetasse-Wolke-42" } });
    const cookie = login.cookies.find((c) => c.name === "session")!.value;
    const res = await ctx.app.inject({ method: "GET", url: "/api/v1/templates", cookies: { session: cookie }, headers: { authorization: "Bearer ck_ungueltig" } });
    expect(res.statusCode).toBe(401);
  });

  it("verweigert abgelaufene Token (401 token_expired)", async () => {
    const { token, dto } = await createToken(anna, { name: "kurz", permission: "read", expiresAt: new Date(Date.now() + DAY).toISOString() });
    expect((await bearer(token)).statusCode).toBe(200);
    ctx.db.update(schema.apiTokens).set({ expiresAt: Date.now() - 1000 }).where(eq(schema.apiTokens.id, dto.id)).run();
    const res = await bearer(token);
    expect([res.statusCode, res.json().error]).toEqual([401, "token_expired"]);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect((await anna.get("/api/v1/me/tokens")).json().tokens[0].expired).toBe(true);
  });

  it("merkt sich die letzte Nutzung (höchstens einmal pro Minute aktualisiert)", async () => {
    const { token, dto } = await createToken(anna);
    expect(dto.lastUsedAt).toBeNull();
    await bearer(token);
    const first = ctx.db.select().from(schema.apiTokens).get()!.lastUsedAt!;
    expect(first).toBeGreaterThan(0);
    await bearer(token);
    expect(ctx.db.select().from(schema.apiTokens).get()!.lastUsedAt).toBe(first);
    ctx.db.update(schema.apiTokens).set({ lastUsedAt: first - 2 * 60_000 }).run();
    await bearer(token);
    expect(ctx.db.select().from(schema.apiTokens).get()!.lastUsedAt).toBeGreaterThan(first - 60_000);
  });

  it("ignoriert Authorization-Header auf öffentlichen und Anmelde-Routen", async () => {
    const run = (await anna.post("/api/v1/runs", { title: "R" })).json().run.id;
    const url = (await anna.put(`/api/v1/runs/${run}/share`, { access: "anyone", permission: "view" })).json().share.url as string;
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1/public/runs/${url.split("/s/")[1]}`, headers: { authorization: "Bearer müll" } });
    expect(res.statusCode).toBe(200);
    const login = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "anna@example.org", password: "Kaffeetasse-Wolke-42" }, headers: { authorization: "Bearer müll" } });
    expect(login.statusCode).toBe(200);
  });
});

describe("Rechte: lesen und lesen+schreiben (F-61, F-62)", () => {
  it("Lese-Token dürfen nur lesen (GET), nie ändern", async () => {
    const { token } = await createToken(anna, { name: "ro", permission: "read" });
    const t = (await anna.post("/api/v1/templates", { title: "V" })).json().template.id;
    expect((await bearer(token, "GET", `/api/v1/templates/${t}`)).statusCode).toBe(200);
    const writes: ["POST" | "PUT" | "DELETE", string, object?][] = [
      ["POST", "/api/v1/templates", { title: "X" }], ["PUT", `/api/v1/templates/${t}`, { title: "X" }], ["DELETE", `/api/v1/templates/${t}`],
      ["POST", "/api/v1/runs", { title: "X" }], ["POST", "/api/v1/tags", { name: "X" }], ["DELETE", "/api/v1/trash"],
    ];
    for (const [method, url, payload] of writes) {
      const res = await bearer(token, method, url, payload);
      expect([res.statusCode, res.json().error]).toEqual([403, "token_read_only"]);
    }
    expect((await anna.get(`/api/v1/templates/${t}`)).json().template.title).toBe("V");
  });

  it("Schreib-Token dürfen lesen und ändern", async () => {
    const { token } = await createToken(anna, { name: "rw", permission: "write" });
    const created = await bearer(token, "POST", "/api/v1/templates", { title: "Per API" });
    expect(created.statusCode).toBe(201);
    const id = created.json().template.id;
    expect((await bearer(token, "PUT", `/api/v1/templates/${id}`, { title: "Geändert" })).json().template.title).toBe("Geändert");
    expect((await bearer(token, "POST", "/api/v1/runs", { title: "Lauf", templateIds: [id] })).statusCode).toBe(201);
  });

  it("Token dürfen keine Konto-, Passwort- oder Token-Verwaltung (nur Browser-Sitzung)", async () => {
    const { token } = await createToken(anna, { name: "rw", permission: "write" });
    const attempts: ["GET" | "POST" | "PUT" | "DELETE", string, object?][] = [
      ["PUT", "/api/v1/me", { displayName: "Hacker" }],
      ["POST", "/api/v1/me/password", { currentPassword: "Kaffeetasse-Wolke-42", newPassword: "Neues-Passwort-4711" }],
      ["DELETE", "/api/v1/me", { password: "Kaffeetasse-Wolke-42" }],
      ["GET", "/api/v1/me/tokens"],
      ["POST", "/api/v1/me/tokens", { name: "mehr", permission: "write" }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await bearer(token, method, url, payload);
      expect([method, url, res.statusCode, res.json().error]).toEqual([method, url, 403, "session_required"]);
    }
    expect((await anna.get("/api/v1/me")).json().user.displayName).toBe("Anna");
    expect(ctx.db.select().from(schema.apiTokens).all()).toHaveLength(1);
  });

  it("Lese-Token sehen eigenes Profil, nicht aber andere Nutzer", async () => {
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const bobTemplate = (await bob.post("/api/v1/templates", { title: "Bobs" })).json().template.id;
    const { token } = await createToken(anna, { name: "ro", permission: "read" });
    expect((await bearer(token, "GET", `/api/v1/templates/${bobTemplate}`)).statusCode).toBe(404);
  });
});

describe("Rate-Limit je Token (F-62)", () => {
  it("TokenRateLimiter zählt je Token im Minutenfenster", () => {
    const l = new TokenRateLimiter(3);
    const t0 = 1_000_000;
    expect([l.hit("a", t0), l.hit("a", t0), l.hit("a", t0)]).toEqual([0, 0, 0]);
    expect(l.hit("a", t0 + 1000)).toBe(59);
    expect(l.hit("b", t0)).toBe(0); // anderer Token unberührt
    expect(l.hit("a", t0 + 60_001)).toBe(0); // neues Fenster
  });

  it("antwortet nach Überschreiten mit 429 und Retry-After; andere Token und Cookie-Sitzungen bleiben frei", async () => {
    const small = setupApp({ API_RATE_LIMIT_PER_MINUTE: "3" });
    const user = await newUser(small.app, "limit@example.org", "L");
    const mk = async (name: string) => (await user.post("/api/v1/me/tokens", { name, permission: "read" })).json().token as string;
    const [a, b] = [await mk("a"), await mk("b")];
    const get = (t: string) => small.app.inject({ method: "GET", url: "/api/v1/templates", headers: { authorization: `Bearer ${t}` } });
    expect([(await get(a)).statusCode, (await get(a)).statusCode, (await get(a)).statusCode]).toEqual([200, 200, 200]);
    const blocked = await get(a);
    expect([blocked.statusCode, blocked.json().error]).toEqual([429, "rate_limited"]);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get(b)).statusCode).toBe(200);
    expect((await user.get("/api/v1/templates")).statusCode).toBe(200);
  });
});
