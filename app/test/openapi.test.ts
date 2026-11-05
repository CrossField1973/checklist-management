import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { documentedOperations } from "../src/openapi.js";
import { newUser, setupApp } from "./helpers.js";

const { app } = setupApp();
const spec = async () => (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();

/** Fastify „/runs/:id“ → OpenAPI „/runs/{id}“ */
const toOpenApiPath = (url: string) => url.replace(/:(\w+)/g, "{$1}");

describe("OpenAPI-Beschreibung (F-60)", () => {
  it("ist eine gültige OpenAPI-3.0-Spezifikation", async () => {
    const doc = await spec();
    expect(doc.openapi).toBe("3.0.3");
    await expect(SwaggerParser.validate(structuredClone(doc))).resolves.toBeDefined();
  });

  it("beschreibt jede registrierte Route – und nur existierende Routen", async () => {
    await app.ready();
    const registered = new Set(
      app.routeTable
        .filter((r) => !["HEAD", "OPTIONS"].includes(r.method))
        // Nur die API-Oberfläche muss beschrieben sein; Dateien der Weboberfläche (index.html, /assets/…) und Swagger gehören nicht dazu
        .filter((r) => /^\/(api\/|mcp|healthz)/.test(r.url))
        .filter((r) => !r.url.startsWith("/api/docs") && r.url !== "/api/openapi.json")
        .map((r) => `${r.method} ${toOpenApiPath(r.url)}`),
    );
    const documented = new Set(documentedOperations());
    const missingInDocs = [...registered].filter((r) => !documented.has(r));
    const unknownInDocs = [...documented].filter((d) => !registered.has(d));
    expect(missingInDocs).toEqual([]);
    expect(unknownInDocs).toEqual([]);
    expect(registered.size).toBeGreaterThan(50); // Schutz davor, dass der Abgleich leer läuft
  });

  it("jede Operation hat Titel, Tag, Sicherheitsangabe und eine Erfolgsantwort", async () => {
    const doc = await spec();
    for (const [path, methods] of Object.entries<Record<string, any>>(doc.paths)) {
      for (const [method, o] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(o.summary, where).toBeTruthy();
        expect(o.tags?.length, where).toBe(1);
        expect(Array.isArray(o.security), where).toBe(true);
        expect(Object.keys(o.responses).some((c) => c.startsWith("2") || c === "302" || c === "405"), where).toBe(true); // 405 nur bei „nicht unterstützt“
        expect(o.operationId, where).toBeTruthy();
      }
    }
    const ids = Object.values<Record<string, any>>(doc.paths).flatMap((m) => Object.values(m).map((o: any) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("kennzeichnet Authentifizierung korrekt: öffentlich, Sitzung+Token, nur Sitzung", async () => {
    const doc = await spec();
    const sec = (method: string, path: string) => doc.paths[path][method].security.map((s: object) => Object.keys(s)[0]);
    expect(sec("get", "/api/v1/public/runs/{token}")).toEqual([]);
    expect(sec("post", "/api/v1/auth/login")).toEqual([]);
    expect(sec("get", "/api/v1/templates")).toEqual(["cookieAuth", "bearerAuth"]);
    expect(sec("put", "/api/v1/me")).toEqual(["cookieAuth"]);
    expect(sec("post", "/api/v1/me/tokens")).toEqual(["cookieAuth"]);
    expect(doc.paths["/api/v1/templates"].post.description).toContain("lesen+schreiben");
    expect(doc.paths["/api/v1/me/tokens"].post.description).toContain("nur in dieser Antwort");
  });

  it("übernimmt Eingabe-Schemas aus der Validierung (Body, Query, Pfadparameter)", async () => {
    const doc = await spec();
    const share = doc.paths["/api/v1/runs/{id}/share"].put.requestBody.content["application/json"].schema;
    expect(share.required).toEqual(["access", "permission"]);
    expect(share.properties.access.enum).toEqual(["anyone", "password"]);
    expect(share.properties.password.minLength).toBe(8);
    const token = doc.paths["/api/v1/me/tokens"].post.requestBody.content["application/json"].schema;
    expect(token.properties.permission.enum).toEqual(["read", "write"]);
    const list = doc.paths["/api/v1/templates"].get.parameters.map((p: { name: string }) => p.name);
    expect(list).toEqual(expect.arrayContaining(["search", "tagId", "sort", "limit", "offset"]));
    const trashParams = doc.paths["/api/v1/trash/{type}/{id}"].delete.parameters;
    expect(trashParams.find((p: { name: string }) => p.name === "type").schema.enum).toEqual(["template", "run"]);
    expect(trashParams.every((p: { in: string; required: boolean }) => p.in === "path" && p.required)).toBe(true);
  });

  it("enthält keine Beispielgeheimnisse oder interne Details", async () => {
    const text = JSON.stringify(await spec());
    expect(text).not.toMatch(/SESSION_SECRET|argon2|tokenHash|password_hash/i);
  });

  it("zeigt die erwartete Serveradresse", async () => {
    expect((await spec()).servers).toEqual([{ url: "http://localhost:3000" }]);
  });
});

describe("Swagger-Oberfläche unter /api/docs", () => {
  it("ist ohne Anmeldung erreichbar und liefert HTML sowie die Spezifikation", async () => {
    const page = await app.inject({ method: "GET", url: "/api/docs" });
    expect([200, 302]).toContain(page.statusCode);
    const html = await app.inject({ method: "GET", url: "/api/docs/" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    const json = await app.inject({ method: "GET", url: "/api/docs/json" });
    expect(json.statusCode).toBe(200);
    expect(json.json().info.title).toBe("Checklisten-Management API");
  });

  it("liefert Oberflächen-Dateien selbst aus (keine externen Abhängigkeiten nötig)", async () => {
    const html = (await app.inject({ method: "GET", url: "/api/docs/" })).body;
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
    const asset = await app.inject({ method: "GET", url: "/api/docs/static/swagger-ui-bundle.js" });
    expect(asset.statusCode).toBe(200);
  });

  it("Dokumentation ist öffentlich, die API dahinter aber nicht", async () => {
    await newUser(app, "doc@example.org", "Doc");
    expect((await app.inject({ method: "GET", url: "/api/v1/templates" })).statusCode).toBe(401);
  });
});
