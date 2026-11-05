import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import { loadRunItems, progressOf } from "../services/run-items.js";
import { parse } from "./auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const params = z.object({ type: z.enum(["template", "run"]), id: z.string().uuid() });

export async function trashRoutes(app: FastifyInstance, { db }: AppDeps) {
  const auth = { preHandler: app.requireUser };

  const trashedTemplate = (userId: string, id: string) =>
    db.select().from(schema.templates)
      .where(and(eq(schema.templates.id, id), eq(schema.templates.ownerId, userId), isNotNull(schema.templates.deletedAt))).get();
  const trashedRun = (userId: string, id: string) =>
    db.select().from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.ownerId, userId), isNotNull(schema.runs.deletedAt))).get();

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  // F-31: Vorlagen und Durchführungen im Papierkorb mit Datum der endgültigen Löschung
  app.get("/api/v1/trash", auth, async (req) => {
    const user = req.user!;
    const purgeAt = (deletedAt: number) =>
      user.trashRetentionDays ? deletedAt + user.trashRetentionDays * DAY_MS : null;

    const templates = db.select().from(schema.templates)
      .where(and(eq(schema.templates.ownerId, user.id), isNotNull(schema.templates.deletedAt))).all()
      .map((t) => ({ type: "template" as const, id: t.id, title: t.title, deletedAt: t.deletedAt!, purgeAt: purgeAt(t.deletedAt!) }));
    const runs = db.select().from(schema.runs)
      .where(and(eq(schema.runs.ownerId, user.id), isNotNull(schema.runs.deletedAt))).all()
      .map((r) => ({
        type: "run" as const, id: r.id, title: r.title, deletedAt: r.deletedAt!, purgeAt: purgeAt(r.deletedAt!),
        statusBeforeDelete: r.statusBeforeDelete ?? "active", progress: progressOf(loadRunItems(db, r.id)),
      }));
    const items = [...templates, ...runs].sort((a, b) => b.deletedAt - a.deletedAt);
    return { retentionDays: user.trashRetentionDays, items };
  });

  // Wiederherstellen: Durchführungen kehren in ihren früheren Status (aktiv/archiviert) zurück.
  app.post("/api/v1/trash/:type/:id/restore", auth, async (req, reply) => {
    const p = parse(params, req.params, reply);
    if (!p) return;
    const userId = req.user!.id;
    if (p.type === "template") {
      const t = trashedTemplate(userId, p.id);
      if (!t) return notFound(reply);
      db.update(schema.templates).set({ deletedAt: null, updatedAt: Date.now() }).where(eq(schema.templates.id, t.id)).run();
    } else {
      const r = trashedRun(userId, p.id);
      if (!r) return notFound(reply);
      db.update(schema.runs)
        .set({ deletedAt: null, status: r.statusBeforeDelete ?? "active", statusBeforeDelete: null, updatedAt: Date.now() })
        .where(eq(schema.runs.id, r.id)).run();
    }
    req.log.info({ event: "trash_restored", userId, type: p.type, id: p.id }, "Aus dem Papierkorb wiederhergestellt");
    return reply.code(204).send();
  });

  // Endgültig löschen: Cascade entfernt Punkte, Abschnitte, Freigaben und Tag-Zuordnungen.
  app.delete("/api/v1/trash/:type/:id", auth, async (req, reply) => {
    const p = parse(params, req.params, reply);
    if (!p) return;
    const userId = req.user!.id;
    if (p.type === "template") {
      const t = trashedTemplate(userId, p.id);
      if (!t) return notFound(reply);
      db.delete(schema.templates).where(eq(schema.templates.id, t.id)).run();
    } else {
      const r = trashedRun(userId, p.id);
      if (!r) return notFound(reply);
      db.delete(schema.runs).where(eq(schema.runs.id, r.id)).run();
    }
    req.log.info({ event: "trash_item_deleted", userId, type: p.type, id: p.id }, "Endgültig gelöscht");
    return reply.code(204).send();
  });

  app.delete("/api/v1/trash", auth, async (req, reply) => {
    const userId = req.user!.id;
    const counts = db.transaction((tx) => ({
      templates: tx.delete(schema.templates).where(and(eq(schema.templates.ownerId, userId), isNotNull(schema.templates.deletedAt))).run().changes,
      runs: tx.delete(schema.runs).where(and(eq(schema.runs.ownerId, userId), isNotNull(schema.runs.deletedAt))).run().changes,
    }));
    req.log.info({ event: "trash_emptied", userId, ...counts }, "Papierkorb geleert");
    return reply.code(200).send(counts);
  });
}
