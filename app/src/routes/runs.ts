import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import {
  RunItemError, addRunItem, addRunItemTree, appendTemplateAsItem, deleteRunItem,
  loadRunItems, moveRunItem, primarySection, progressOf, runDetail, updateRunItem,
} from "../services/run-items.js";
import { ItemError } from "../services/template-items.js";
import { activeShareOfRun, activeSharesOfRuns, shareBadge } from "../services/shares.js";
import { parse } from "./auth.js";

export const id = z.string().uuid();
export const title = z.string().trim().min(1).max(200);
export const idParams = z.object({ id });

export const createBody = z.object({ title, templateIds: z.array(id).max(100).default([]) });
export const updateBody = z.object({ title });
export const addTemplatesBody = z.object({ templateIds: z.array(id).min(1).max(100) });
export const listQuery = z.object({
  status: z.enum(["active", "archived"]).default("active"),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const itemCreate = z.object({
  title, parentItemId: id.nullable().optional(), position: z.number().int().min(0).optional(),
});
/** Mehrere Punkte (mit Unterpunkten) auf einmal ans Ende eines Abschnitts oder unter `parentItemId`. */
const plainItem = z.object({
  title,
  get children() { return z.array(plainItem).optional(); },
});
export const itemBulk = z.object({ parentItemId: id.nullable().optional(), items: z.array(plainItem).min(1) });
/** Nicht rekursive Fassung nur für die OpenAPI-Beschreibung. */
export const itemBulkDoc = z.object({
  parentItemId: id.nullable().optional(),
  items: z.array(z.object({ title, children: z.array(z.record(z.string(), z.unknown())).optional() })).min(1),
});
export const itemUpdate = z.object({ title: title.optional(), isChecked: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");
export const itemMove = z.object({ sectionId: id.optional(), parentItemId: id.nullable(), position: z.number().int().min(0) });

const itemErrors: Record<RunItemError["code"], [number, string]> = {
  parent_not_found: [404, "parent_not_found"],
  section_not_found: [404, "section_not_found"],
  cycle: [422, "cycle"],
  too_deep: [422, "too_deep"],
  too_many_items: [422, "too_many_items"],
};

export async function runRoutes(app: FastifyInstance, { db }: AppDeps) {
  const auth = { preHandler: app.requireUser };

  type Run = typeof schema.runs.$inferSelect;

  /** Eigene, nicht gelöschte Durchführung – fremde IDs verhalten sich wie nicht vorhanden (N-04). */
  const ownRun = (userId: string, runId: string) =>
    db.select().from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.ownerId, userId), isNull(schema.runs.deletedAt))).get();

  const ownSection = (userId: string, sectionId: string) => {
    const section = db.select().from(schema.runSections).where(eq(schema.runSections.id, sectionId)).get();
    const run = section && ownRun(userId, section.runId);
    return section && run ? { section, run } : undefined;
  };

  const ownItem = (userId: string, itemId: string) => {
    const item = db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    const found = item && ownSection(userId, item.sectionId);
    return item && found ? { item, ...found } : undefined;
  };

  const touch = (runId: string) => db.update(schema.runs).set({ updatedAt: Date.now() }).where(eq(schema.runs.id, runId)).run();

  const detail = (run: Run) => ({
    run: {
      id: run.id, title: run.title, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, archivedAt: run.archivedAt,
      share: shareBadge(activeShareOfRun(db, run.id)),
      ...runDetail(db, run.id),
    },
  });

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });
  /** Archivierte Durchführungen sind schreibgeschützt (F-28/F-30). */
  const notActive = (reply: FastifyReply) => reply.code(409).send({ error: "run_not_active" });

  const itemFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RunItemError) {
      const [status, error] = itemErrors[err.code];
      return reply.code(status).send({ error });
    }
    throw err;
  };

  /** Eigene, nicht gelöschte Vorlagen in der angegebenen Reihenfolge; null, wenn eine unbekannt ist. Duplikate sind erlaubt (F-22). */
  const resolveTemplates = (userId: string, templateIds: string[]) => {
    const list = templateIds.map((tid) =>
      db.select().from(schema.templates)
        .where(and(eq(schema.templates.id, tid), eq(schema.templates.ownerId, userId), isNull(schema.templates.deletedAt))).get());
    return list.every(Boolean) ? (list as (typeof schema.templates.$inferSelect)[]) : null;
  };

  // ---------- Liste (F-20) ----------
  app.get("/api/v1/runs", auth, async (req, reply) => {
    const q = parse(listQuery, req.query, reply);
    if (!q) return;
    let rows = db.select().from(schema.runs)
      .where(and(eq(schema.runs.ownerId, req.user!.id), eq(schema.runs.status, q.status), isNull(schema.runs.deletedAt))).all();
    const needle = q.search?.toLocaleLowerCase("de");
    if (needle) rows = rows.filter((r) => r.title.toLocaleLowerCase("de").includes(needle));
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const total = rows.length;
    const pageRows = rows.slice(q.offset, q.offset + q.limit);
    const shares = activeSharesOfRuns(db, pageRows.map((r) => r.id));
    const runs = pageRows.map((r) => ({
      id: r.id, title: r.title, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, archivedAt: r.archivedAt,
      itemTitles: loadRunItems(db, r.id).filter((i) => !i.parentItemId).sort((a, b) => a.position - b.position).map((i) => i.title),
      progress: progressOf(loadRunItems(db, r.id)),
      /** F-20: Kennzeichnung geteilter Durchführungen (null = nicht geteilt) */
      share: shareBadge(shares.get(r.id)),
    }));
    return { total, runs };
  });

  // ---------- Anlegen aus beliebig vielen Vorlagen (F-21) ----------
  app.post("/api/v1/runs", auth, async (req, reply) => {
    const body = parse(createBody, req.body, reply);
    if (!body) return;
    const userId = req.user!.id;
    const templates = resolveTemplates(userId, body.templateIds);
    if (!templates) return reply.code(422).send({ error: "unknown_template" });
    const run = db.transaction((tx) => {
      const [r] = tx.insert(schema.runs).values({ ownerId: userId, title: body.title }).returning().all();
      primarySection(tx, r!);
      for (const t of templates) appendTemplateAsItem(tx, r!, t);
      return r!;
    });
    req.log.info({ event: "run_created", userId, runId: run.id, templates: templates.length }, "Durchführung angelegt");
    return reply.code(201).send(detail(run));
  });

  app.get("/api/v1/runs/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    return run ? detail(run) : notFound(reply);
  });

  app.put("/api/v1/runs/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(updateBody, req.body, reply);
    if (!p || !body) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "active") return notActive(reply);
    const [updated] = db.update(schema.runs).set({ title: body.title, updatedAt: Date.now() }).where(eq(schema.runs.id, run.id)).returning().all();
    return detail(updated!);
  });

  // F-27: Löschen = Papierkorb (Soft-Delete); der Status wird für die Wiederherstellung gemerkt.
  app.delete("/api/v1/runs/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    db.update(schema.runs).set({ deletedAt: Date.now(), statusBeforeDelete: run.status }).where(eq(schema.runs.id, run.id)).run();
    req.log.info({ event: "run_deleted", userId: req.user!.id, runId: run.id }, "Durchführung in den Papierkorb verschoben");
    return reply.code(204).send();
  });

  // ---------- Abschließen, Archivieren, Wieder öffnen (F-28, F-30) ----------
  /** „Abschließen“ löscht die Durchführung in den Papierkorb (wiederherstellbar). */
  app.post("/api/v1/runs/:id/complete", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    db.update(schema.runs).set({ deletedAt: Date.now(), statusBeforeDelete: run.status }).where(eq(schema.runs.id, run.id)).run();
    req.log.info({ event: "run_completed", userId: req.user!.id, runId: run.id }, "Durchführung abgeschlossen (Papierkorb)");
    return reply.code(204).send();
  });

  /** „Archivieren“ bewahrt die Durchführung dauerhaft auf; ein Freigabelink wird widerrufen (F-44). */
  app.post("/api/v1/runs/:id/archive", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "active") return notActive(reply);
    const now = Date.now();
    const [updated] = db.transaction((tx) => {
      tx.update(schema.runShares).set({ revokedAt: now })
        .where(and(eq(schema.runShares.runId, run.id), isNull(schema.runShares.revokedAt))).run();
      return tx.update(schema.runs).set({ status: "archived", archivedAt: now, updatedAt: now }).where(eq(schema.runs.id, run.id)).returning().all();
    });
    req.log.info({ event: "run_archived", userId: req.user!.id, runId: run.id }, "Durchführung archiviert");
    return detail(updated!);
  });

  app.post("/api/v1/runs/:id/reopen", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "archived") return reply.code(409).send({ error: "run_not_archived" });
    const [updated] = db.update(schema.runs).set({ status: "active", archivedAt: null, updatedAt: Date.now() }).where(eq(schema.runs.id, run.id)).returning().all();
    req.log.info({ event: "run_reopened", userId: req.user!.id, runId: run.id }, "Durchführung wieder geöffnet");
    return detail(updated!);
  });

  // ---------- Vorlagen ergänzen (F-22) ----------
  /** Jede Vorlage wird ein Überpunkt am Ende, ihre Punkte stehen darunter (Momentaufnahme, Verweise aufgelöst). */
  app.post("/api/v1/runs/:id/templates", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(addTemplatesBody, req.body, reply);
    if (!p || !body) return;
    const userId = req.user!.id;
    const run = ownRun(userId, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "active") return notActive(reply);
    const templates = resolveTemplates(userId, body.templateIds);
    if (!templates) return reply.code(422).send({ error: "unknown_template" });
    try {
      db.transaction((tx) => templates.forEach((t) => appendTemplateAsItem(tx, run, t)));
    } catch (err) {
      if (err instanceof ItemError) return reply.code(422).send({ error: err.code });
      return itemFail(reply, err);
    }
    touch(run.id);
    req.log.info({ event: "run_templates_added", userId, runId: run.id }, "Vorlagen hinzugefügt");
    return reply.code(201).send(detail(run));
  });

  // ---------- Punkte (F-23 bis F-25) ----------
  /** Legt einen Punkt oder einen ganzen Punktebaum an (Antwort 201 mit den neuen IDs und dem Stand der Durchführung). */
  const createItems = (run: Run, section: typeof schema.runSections.$inferSelect, rawBody: unknown, reply: FastifyReply) => {
    const bulk = rawBody && typeof rawBody === "object" && "items" in rawBody;
    const body = bulk ? parse(itemBulk, rawBody, reply) : parse(itemCreate, rawBody, reply);
    if (!body) return;
    try {
      if ("items" in body) {
        const itemIds = addRunItemTree(db, section, body.items, body.parentItemId ?? null);
        touch(run.id);
        return reply.code(201).send({ itemIds, ...detail(run) });
      }
      const item = addRunItem(db, section, body);
      touch(run.id);
      return reply.code(201).send({ itemId: item.id, ...detail(run) });
    } catch (err) {
      return itemFail(reply, err);
    }
  };

  app.post("/api/v1/runs/:id/items", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "active") return notActive(reply);
    return createItems(run, primarySection(db, run), req.body, reply);
  });

  app.post("/api/v1/run-sections/:id/items", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const found = ownSection(req.user!.id, p.id);
    if (!found) return notFound(reply);
    if (found.run.status !== "active") return notActive(reply);
    return createItems(found.run, found.section, req.body, reply);
  });

  // Abhaken (F-24): speichert sofort mit Zeitstempel, unabhängig von Unterpunkten.
  app.put("/api/v1/run-items/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(itemUpdate, req.body, reply);
    if (!p || !body) return;
    const found = ownItem(req.user!.id, p.id);
    if (!found) return notFound(reply);
    if (found.run.status !== "active") return notActive(reply);
    updateRunItem(db, found.item, body);
    touch(found.run.id);
    return detail(found.run);
  });

  app.delete("/api/v1/run-items/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const found = ownItem(req.user!.id, p.id);
    if (!found) return notFound(reply);
    if (found.run.status !== "active") return notActive(reply);
    deleteRunItem(db, found.item);
    touch(found.run.id);
    return detail(found.run);
  });

  app.post("/api/v1/run-items/:id/move", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(itemMove, req.body, reply);
    if (!p || !body) return;
    const found = ownItem(req.user!.id, p.id);
    if (!found) return notFound(reply);
    if (found.run.status !== "active") return notActive(reply);
    try {
      moveRunItem(db, found.item, found.run.id, body.sectionId ?? found.item.sectionId, body.parentItemId, body.position);
      touch(found.run.id);
      return detail(found.run);
    } catch (err) {
      return itemFail(reply, err);
    }
  });
}
