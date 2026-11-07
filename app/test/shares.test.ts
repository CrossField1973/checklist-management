import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/crypto.js";
import { schema } from "../src/db/index.js";
import { newUser, setupApp } from "./helpers.js";

type Client = Awaited<ReturnType<typeof newUser>>;
interface Item { id: string; title: string; isChecked: boolean; children: Item[] }

let ctx: ReturnType<typeof setupApp>;
let anna: Client;
beforeEach(async () => {
  ctx = setupApp();
  anna = await newUser(ctx.app, "anna@example.org", "Anna");
});

async function makeRun(client: Client = anna, title = "Ausflug Füssen") {
  const created = (await client.post("/api/v1/runs", { title })).json().run as { id: string };
  const res = await client.post(`/api/v1/runs/${created.id}/items`, { items: [{ title: "Schuhe" }, { title: "Karte" }] });
  return res.json().run as { id: string; sections: { id: string; items: Item[] }[] };
}
const share = (run: { id: string }, body: object = { access: "anyone", permission: "view" }) =>
  anna.put(`/api/v1/runs/${run.id}/share`, body);
const tokenOf = (url: string) => url.split("/s/")[1]!;
const pub = (token: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: "GET", url: `/api/v1/public/runs/${token}`, headers });
const pubWrite = (method: "PUT" | "POST" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method, url: `/api/v1/public/runs/${url}`, payload, headers });

describe("Verschlüsselung (Freigabe-Token)", () => {
  it("ver- und entschlüsselt, ist zufällig und erkennt Manipulation/falschen Schlüssel", () => {
    const a = encrypt("geheim", "s".repeat(32), "p");
    expect(a).not.toContain("geheim");
    expect(encrypt("geheim", "s".repeat(32), "p")).not.toBe(a);
    expect(decrypt(a, "s".repeat(32), "p")).toBe("geheim");
    expect(decrypt(a, "x".repeat(32), "p")).toBeNull();
    expect(decrypt(a, "s".repeat(32), "andere")).toBeNull();
    expect(decrypt(a.slice(0, -2) + "AA", "s".repeat(32), "p")).toBeNull();
    expect(decrypt("müll", "s".repeat(32), "p")).toBeNull();
  });
});

describe("Link anlegen und verwalten (F-40 bis F-43)", () => {
  it("erzeugt einen unerratbaren Link; gespeichert werden nur Hash und verschlüsselter Token", async () => {
    const run = await makeRun();
    const res = await share(run);
    expect(res.statusCode).toBe(201);
    const { url, access, permission } = res.json().share;
    expect([access, permission]).toEqual(["anyone", "view"]);
    expect(url).toMatch(/^http:\/\/localhost:3000\/s\/[\w-]{32,}$/);
    const row = ctx.db.select().from(schema.runShares).get()!;
    expect(row.tokenHash).not.toContain(tokenOf(url));
    expect(row.tokenEnc).not.toContain(tokenOf(url));
  });

  it("vergibt je Link einen eigenen Token", async () => {
    const urls = new Set<string>();
    for (const title of ["A", "B", "C"]) urls.add((await share(await makeRun(anna, title))).json().share.url);
    expect(urls.size).toBe(3);
  });

  it("zeigt den Link später wieder an (Link kopieren) und liefert null ohne Freigabe", async () => {
    const run = await makeRun();
    expect((await anna.get(`/api/v1/runs/${run.id}/share`)).json()).toEqual({ share: null });
    const url = (await share(run)).json().share.url;
    expect((await anna.get(`/api/v1/runs/${run.id}/share`)).json().share.url).toBe(url);
  });

  it("ändert Einstellungen, ohne den Link zu ändern; Passwort-Wechsel funktioniert in beide Richtungen", async () => {
    const run = await makeRun();
    const url = (await share(run)).json().share.url;
    const upd = await share(run, { access: "password", permission: "edit", password: "geheimes-passwort" });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().share).toMatchObject({ url, access: "password", permission: "edit" });
    // ohne neues Passwort bleibt das alte erhalten
    const keep = await share(run, { access: "password", permission: "view" });
    expect(keep.statusCode).toBe(200);
    expect((await pub(tokenOf(url), { "x-share-password": "geheimes-passwort" })).statusCode).toBe(200);
    // zurück auf „jeder mit dem Link“ löscht den Passwort-Hash
    await share(run, { access: "anyone", permission: "view" });
    expect(ctx.db.select().from(schema.runShares).get()!.passwordHash).toBeNull();
    expect((await pub(tokenOf(url))).statusCode).toBe(200);
  });

  it("verlangt für „Link + Passwort“ ein Passwort (min. 8 Zeichen) und speichert nur dessen Hash", async () => {
    const run = await makeRun();
    expect((await share(run, { access: "password", permission: "view" })).json().error).toBe("password_required");
    expect((await share(run, { access: "password", permission: "view", password: "kurz" })).statusCode).toBe(400);
    await share(run, { access: "password", permission: "view", password: "geheimes-passwort" });
    expect(ctx.db.select().from(schema.runShares).get()!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(ctx.db.select().from(schema.runShares).all()).toHaveLength(1);
  });

  it("lehnt ungültige Einstellungen ab", async () => {
    const run = await makeRun();
    expect((await share(run, { access: "alle", permission: "view" })).statusCode).toBe(400);
    expect((await share(run, { access: "anyone", permission: "owner" })).statusCode).toBe(400);
  });

  it("erzeugt auf Wunsch einen neuen Link mit gleichen Einstellungen; der alte ist sofort ungültig", async () => {
    const run = await makeRun();
    const oldUrl = (await share(run, { access: "password", permission: "edit", password: "geheimes-passwort" })).json().share.url;
    const res = await anna.post(`/api/v1/runs/${run.id}/share/regenerate`);
    const newUrl = res.json().share.url;
    expect(newUrl).not.toBe(oldUrl);
    expect(res.json().share).toMatchObject({ access: "password", permission: "edit" });
    expect((await pub(tokenOf(oldUrl), { "x-share-password": "geheimes-passwort" })).statusCode).toBe(404);
    expect((await pub(tokenOf(newUrl), { "x-share-password": "geheimes-passwort" })).statusCode).toBe(200);
    expect((await anna.post(`/api/v1/runs/${(await makeRun(anna, "Ohne")).id}/share/regenerate`)).statusCode).toBe(404);
  });

  it("widerruft den Link", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run)).json().share.url);
    expect((await anna.del(`/api/v1/runs/${run.id}/share`)).statusCode).toBe(204);
    expect((await pub(token)).statusCode).toBe(404);
    expect((await anna.get(`/api/v1/runs/${run.id}/share`)).json().share).toBeNull();
    expect((await anna.del(`/api/v1/runs/${run.id}/share`)).statusCode).toBe(404);
  });

  it("macht archivierte Durchführungen nicht teilbar (F-44) und widerruft beim Archivieren", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run)).json().share.url);
    await anna.post(`/api/v1/runs/${run.id}/archive`);
    expect((await pub(token)).statusCode).toBe(404);
    const res = await share(run);
    expect([res.statusCode, res.json().error]).toEqual([409, "run_not_active"]);
    await anna.post(`/api/v1/runs/${run.id}/reopen`);
    expect((await pub(token)).statusCode).toBe(404); // alter Link bleibt widerrufen
    expect((await share(run)).statusCode).toBe(201); // neuer Link möglich
  });

  it("deaktiviert den Link im Papierkorb und aktiviert ihn bei Wiederherstellung wieder (F-44)", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run)).json().share.url);
    await anna.post(`/api/v1/runs/${run.id}/complete`);
    expect((await pub(token)).statusCode).toBe(404);
    await anna.post(`/api/v1/trash/run/${run.id}/restore`);
    expect((await pub(token)).statusCode).toBe(200);
  });

  it("kennzeichnet geteilte Durchführungen in Liste und Detail (F-20)", async () => {
    const shared = await makeRun(anna, "Geteilt");
    const priv = await makeRun(anna, "Privat");
    await share(shared, { access: "password", permission: "edit", password: "geheimes-passwort" });
    const list = (await anna.get("/api/v1/runs")).json().runs as { title: string; share: unknown }[];
    expect(list.find((r) => r.title === "Geteilt")!.share).toEqual({ access: "password", permission: "edit" });
    expect(list.find((r) => r.title === "Privat")!.share).toBeNull();
    expect((await anna.get(`/api/v1/runs/${shared.id}`)).json().run.share).toEqual({ access: "password", permission: "edit" });
    expect((await anna.get(`/api/v1/runs/${priv.id}`)).json().run.share).toBeNull();
    expect(JSON.stringify(list)).not.toMatch(/token|url/i);
  });
});

describe("Verwaltung im Profil (F-45)", () => {
  it("listet aktive Freigaben, kennzeichnet Papierkorb und erlaubt Zurückziehen einzeln und gesamt", async () => {
    const a = await makeRun(anna, "A");
    const b = await makeRun(anna, "B");
    const c = await makeRun(anna, "C");
    for (const r of [a, b, c]) await share(r);
    await anna.post(`/api/v1/runs/${c.id}/complete`);
    const list = (await anna.get("/api/v1/me/shares")).json().shares as { id: string; runTitle: string; runDeleted: boolean; url: string }[];
    expect(list.map((s) => [s.runTitle, s.runDeleted]).sort()).toEqual([["A", false], ["B", false], ["C", true]]);
    expect(list.every((s) => s.url.includes("/s/"))).toBe(true);

    const first = list.find((s) => s.runTitle === "A")!;
    expect((await anna.del(`/api/v1/me/shares/${first.id}`)).statusCode).toBe(204);
    expect((await anna.del(`/api/v1/me/shares/${first.id}`)).statusCode).toBe(404);
    expect((await anna.get("/api/v1/me/shares")).json().shares).toHaveLength(2);
    expect((await anna.del("/api/v1/me/shares")).json()).toEqual({ revoked: 2 });
    expect((await anna.get("/api/v1/me/shares")).json().shares).toEqual([]);
  });

  it("zeigt und ändert nur eigene Freigaben", async () => {
    const run = await makeRun();
    await share(run);
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const id = ctx.db.select().from(schema.runShares).get()!.id;
    expect((await bob.get("/api/v1/me/shares")).json().shares).toEqual([]);
    expect((await bob.del(`/api/v1/me/shares/${id}`)).statusCode).toBe(404);
    expect((await bob.del("/api/v1/me/shares")).json()).toEqual({ revoked: 0 });
    expect((await anna.get("/api/v1/me/shares")).json().shares).toHaveLength(1);
  });

  it("fremde Durchführungen lassen sich nicht teilen oder verwalten", async () => {
    const run = await makeRun();
    const bob = await newUser(ctx.app, "bob@example.org", "Bob");
    const body = { access: "anyone", permission: "edit" };
    const results = await Promise.all([
      bob.get(`/api/v1/runs/${run.id}/share`), bob.put(`/api/v1/runs/${run.id}/share`, body),
      bob.post(`/api/v1/runs/${run.id}/share/regenerate`), bob.del(`/api/v1/runs/${run.id}/share`),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([404, 404, 404, 404]);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/me/shares" })).statusCode).toBe(401);
  });
});

describe("Öffentlicher Zugriff ohne Konto (F-40, F-43, F-44)", () => {
  it("liefert die Ansicht ohne Anmeldung, ohne Besitzerdaten und mit noindex/no-store", async () => {
    const run = await makeRun();
    const url = (await share(run)).json().share.url;
    const res = await pub(tokenOf(url));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.permission).toBe("view");
    expect(body.run).toMatchObject({ title: "Ausflug Füssen", progress: { done: 0, total: 2 } });
    expect(body.run.sections[0].items.map((i: Item) => i.title)).toEqual(["Schuhe", "Karte"]);
    expect(JSON.stringify(body)).not.toMatch(/anna|ownerId|token|email/i);
  });

  it("antwortet auf unbekannte Token mit 404 und auf ungültige Formate mit 400", async () => {
    expect((await pub("a".repeat(32))).statusCode).toBe(404);
    expect((await pub("kurz")).statusCode).toBe(400);
  });

  it("gilt nur für die geteilte Durchführung: andere Daten desselben Nutzers bleiben unerreichbar", async () => {
    const run = await makeRun();
    const other = await makeRun(anna, "Geheim");
    const token = tokenOf((await share(run, { access: "anyone", permission: "edit" })).json().share.url);
    expect(JSON.stringify((await pub(token)).json())).not.toContain("Geheim");
    const foreignItem = other.sections[0]!.items[0]!;
    expect((await pubWrite("PUT", `${token}/items/${foreignItem.id}`, { isChecked: true })).statusCode).toBe(404);
    expect((await pubWrite("POST", `${token}/sections/${other.sections[0]!.id}/items`, { title: "X" })).statusCode).toBe(404);
    expect((await pubWrite("DELETE", `${token}/items/${foreignItem.id}`)).statusCode).toBe(404);
    expect((await pubWrite("POST", `${token}/items/${foreignItem.id}/move`, { parentItemId: null, position: 0 })).statusCode).toBe(404);
    expect((await anna.get(`/api/v1/runs/${other.id}`)).json().run.progress).toEqual({ done: 0, total: 2 });
  });

  it("verbietet bei „nur ansehen“ jede Änderung (403)", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run)).json().share.url);
    const item = run.sections[0]!.items[0]!;
    const results = await Promise.all([
      pubWrite("PUT", `${token}/items/${item.id}`, { isChecked: true }),
      pubWrite("POST", `${token}/sections/${run.sections[0]!.id}/items`, { title: "X" }),
      pubWrite("DELETE", `${token}/items/${item.id}`),
      pubWrite("POST", `${token}/items/${item.id}/move`, { parentItemId: null, position: 1 }),
    ]);
    expect(results.map((r) => [r.statusCode, r.json().error])).toEqual(Array(4).fill([403, "read_only_link"]));
    expect((await anna.get(`/api/v1/runs/${run.id}`)).json().run.progress).toEqual({ done: 0, total: 2 });
  });

  it("erlaubt bei „ansehen und bearbeiten“ Abhaken, Hinzufügen, Ändern, Verschieben und Löschen", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run, { access: "anyone", permission: "edit" })).json().share.url);
    const [schuhe, karte] = run.sections[0]!.items as [Item, Item];
    const sectionId = run.sections[0]!.id;

    let res = await pubWrite("PUT", `${token}/items/${schuhe.id}`, { isChecked: true });
    expect(res.json().run.progress).toEqual({ done: 1, total: 2 });
    res = await pubWrite("PUT", `${token}/items/${karte.id}`, { title: "Wanderkarte" });
    expect(res.json().run.sections[0].items[1]).toMatchObject({ title: "Wanderkarte" });
    res = await pubWrite("POST", `${token}/sections/${sectionId}/items`, { title: "Proviant", position: 0 });
    expect(res.statusCode).toBe(201);
    const proviantId = res.json().itemId as string;
    expect(res.json().run.sections[0].items.map((i: Item) => i.title)).toEqual(["Proviant", "Schuhe", "Wanderkarte"]);
    res = await pubWrite("POST", `${token}/items/${proviantId}/move`, { parentItemId: karte.id, position: 0 });
    expect(res.json().run.sections[0].items.map((i: Item) => i.title)).toEqual(["Schuhe", "Wanderkarte"]);
    expect(res.json().run.sections[0].items[1].children.map((i: Item) => i.title)).toEqual(["Proviant"]);
    res = await pubWrite("DELETE", `${token}/items/${karte.id}`);
    expect(res.json().run.progress).toEqual({ done: 1, total: 1 });

    expect((await anna.get(`/api/v1/runs/${run.id}`)).json().run.progress).toEqual({ done: 1, total: 1 }); // Besitzer sieht dieselben Änderungen
  });

  it("gibt Empfängern keine Strukturrechte: Token funktioniert nicht als Anmeldung an der Besitzer-API", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run, { access: "anyone", permission: "edit" })).json().share.url);
    const routes: [string, string][] = [
      ["PUT", `/api/v1/runs/${run.id}`], ["DELETE", `/api/v1/runs/${run.id}`], ["POST", `/api/v1/runs/${run.id}/archive`],
      ["POST", `/api/v1/runs/${run.id}/templates`], ["PUT", `/api/v1/runs/${run.id}/share`], ["DELETE", `/api/v1/runs/${run.id}/share`],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({
        method: method as "PUT", url, payload: { title: "X", access: "anyone", permission: "edit" },
        headers: { authorization: `Bearer ${token}`, "x-share-password": token }, cookies: { session: token },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await pubWrite("PUT", token, { title: "X" })).statusCode).toBe(404); // keine Umbenennen-Route öffentlich
    expect((await anna.get(`/api/v1/runs/${run.id}`)).json().run.title).toBe("Ausflug Füssen");
  });

  it("aktualisiert updatedAt, damit geteilte Ansichten Änderungen per Polling erkennen (F-43)", async () => {
    const run = await makeRun();
    const token = tokenOf((await share(run, { access: "anyone", permission: "edit" })).json().share.url);
    const before = (await pub(token)).json().run.updatedAt as number;
    await new Promise((r) => setTimeout(r, 5));
    await pubWrite("PUT", `${token}/items/${run.sections[0]!.items[0]!.id}`, { isChecked: true });
    expect((await pub(token)).json().run.updatedAt).toBeGreaterThan(before);
  });
});

describe("Passwortgeschützte Links (F-41)", () => {
  async function protectedLink(permission: "view" | "edit" = "view") {
    const run = await makeRun();
    const token = tokenOf((await share(run, { access: "password", permission, password: "geheimes-passwort" })).json().share.url);
    return { run, token };
  }

  it("verlangt das Passwort im Header; ohne oder falsch gibt es keinen Inhalt", async () => {
    const { token } = await protectedLink();
    const none = await pub(token);
    expect([none.statusCode, none.json().error]).toEqual([401, "password_required"]);
    expect(JSON.stringify(none.json())).not.toContain("Ausflug");
    const wrong = await pub(token, { "x-share-password": "falsches-passwort" });
    expect([wrong.statusCode, wrong.json().error]).toEqual([401, "invalid_password"]);
    expect((await pub(token, { "x-share-password": "geheimes-passwort" })).statusCode).toBe(200);
  });

  it("verlangt das Passwort auch für Änderungen", async () => {
    const { run, token } = await protectedLink("edit");
    const item = run.sections[0]!.items[0]!;
    expect((await pubWrite("PUT", `${token}/items/${item.id}`, { isChecked: true })).statusCode).toBe(401);
    const ok = await pubWrite("PUT", `${token}/items/${item.id}`, { isChecked: true }, { "x-share-password": "geheimes-passwort" });
    expect(ok.statusCode).toBe(200);
  });

  it("sperrt nach 5 Fehlversuchen vorübergehend – auch mit richtigem Passwort", async () => {
    const { token } = await protectedLink();
    for (let i = 0; i < 5; i++) await pub(token, { "x-share-password": "falsches-passwort" });
    const blocked = await pub(token, { "x-share-password": "geheimes-passwort" });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("sperrt je Absender: ein anderer Absender wird nicht ausgesperrt", async () => {
    const { token } = await protectedLink();
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({ method: "GET", url: `/api/v1/public/runs/${token}`, headers: { "x-share-password": "falsch-falsch" }, remoteAddress: "10.0.0.1" });
    }
    const other = await ctx.app.inject({ method: "GET", url: `/api/v1/public/runs/${token}`, headers: { "x-share-password": "geheimes-passwort" }, remoteAddress: "10.0.0.2" });
    expect(other.statusCode).toBe(200);
  });
});
