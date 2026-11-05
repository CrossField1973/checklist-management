import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { openDatabase, schema } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { buildServer } from "../src/server.js";

const baseEnv = {
  APP_BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "x".repeat(32),
};

describe("Konfiguration", () => {
  it("setzt Standardwerte laut Pflichtenheft", () => {
    const c = loadConfig(baseEnv);
    expect(c.REGISTRATION_ENABLED).toBe(true);
    expect(c.TRASH_RETENTION_DAYS).toBe(30);
    expect(c.DEFAULT_LANGUAGE).toBe("de");
    expect(c.PORT).toBe(3000);
    expect(c.smtpEnabled).toBe(false);
  });

  it("deaktiviert Registrierung per REGISTRATION_ENABLED=false", () => {
    expect(loadConfig({ ...baseEnv, REGISTRATION_ENABLED: "false" }).REGISTRATION_ENABLED).toBe(false);
  });

  it("verlangt APP_BASE_URL und ein langes SESSION_SECRET", () => {
    expect(() => loadConfig({})).toThrow(/APP_BASE_URL/);
    expect(() => loadConfig({ ...baseEnv, SESSION_SECRET: "kurz" })).toThrow(/SESSION_SECRET/);
  });

  it("behandelt leere Variablen als nicht gesetzt", () => {
    const c = loadConfig({ ...baseEnv, SMTP_HOST: "", PORT: "" });
    expect(c.PORT).toBe(3000);
    expect(c.smtpEnabled).toBe(false);
  });
});

describe("Datenbank", () => {
  const setup = () => {
    const db = openDatabase(":memory:");
    const [user] = db.insert(schema.users).values({ email: "a@example.org", displayName: "A" }).returning().all();
    return { db, user: user! };
  };

  it("wendet Migrationen an und vergibt UUIDs", () => {
    const { user } = setup();
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.language).toBe("de");
  });

  it("löscht Unterpunkte per Cascade beim endgültigen Löschen der Vorlage", () => {
    const { db, user } = setup();
    const [tpl] = db.insert(schema.templates).values({ ownerId: user.id, title: "T" }).returning().all();
    const [parent] = db.insert(schema.templateItems).values({ templateId: tpl!.id, title: "P" }).returning().all();
    db.insert(schema.templateItems).values({ templateId: tpl!.id, parentItemId: parent!.id, title: "K" }).run();
    db.delete(schema.templates).where(eq(schema.templates.id, tpl!.id)).run();
    expect(db.select().from(schema.templateItems).all()).toHaveLength(0);
  });

  it("setzt source_template_id auf NULL, wenn die Vorlage endgültig gelöscht wird", () => {
    const { db, user } = setup();
    const [tpl] = db.insert(schema.templates).values({ ownerId: user.id, title: "T" }).returning().all();
    const [run] = db.insert(schema.runs).values({ ownerId: user.id, title: "R" }).returning().all();
    const [sec] = db.insert(schema.runSections).values({ runId: run!.id, sourceTemplateId: tpl!.id, title: "T" }).returning().all();
    db.delete(schema.templates).where(eq(schema.templates.id, tpl!.id)).run();
    const after = db.select().from(schema.runSections).where(eq(schema.runSections.id, sec!.id)).get();
    expect(after?.sourceTemplateId).toBeNull();
    expect(after?.title).toBe("T"); // Momentaufnahme bleibt erhalten
  });

  it("erzwingt eindeutige Tag-Namen je Nutzer", () => {
    const { db, user } = setup();
    db.insert(schema.tags).values({ userId: user.id, name: "Reisen", color: "#2563eb" }).run();
    expect(() => db.insert(schema.tags).values({ userId: user.id, name: "Reisen", color: "#dc2626" }).run()).toThrow();
  });

  it("löscht Durchführung samt Abschnitten, Punkten und Freigaben per Cascade", () => {
    const { db, user } = setup();
    const [run] = db.insert(schema.runs).values({ ownerId: user.id, title: "R" }).returning().all();
    const [sec] = db.insert(schema.runSections).values({ runId: run!.id, title: "S" }).returning().all();
    db.insert(schema.runItems).values({ sectionId: sec!.id, title: "I" }).run();
    db.insert(schema.runShares).values({ runId: run!.id, tokenHash: "h", access: "anyone", permission: "view" }).run();
    db.delete(schema.runs).where(eq(schema.runs.id, run!.id)).run();
    expect(db.select().from(schema.runSections).all()).toHaveLength(0);
    expect(db.select().from(schema.runItems).all()).toHaveLength(0);
    expect(db.select().from(schema.runShares).all()).toHaveLength(0);
  });
});

describe("Server", () => {
  const make = () => {
    const config = loadConfig({ ...baseEnv, LOG_LEVEL: "error", REGISTRATION_ENABLED: "false" });
    return buildServer({ config, db: openDatabase(":memory:"), logger: createLogger(config) });
  };

  it("meldet Gesundheit unter /healthz", async () => {
    const res = await make().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("zeigt deaktivierte Registrierung in der öffentlichen Konfiguration", async () => {
    const res = await make().inject({ method: "GET", url: "/api/v1/config" });
    expect(res.json()).toMatchObject({ registrationEnabled: false, smtpEnabled: false });
  });
});
