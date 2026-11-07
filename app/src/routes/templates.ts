import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import {
  ItemError, type ItemInput, addItem, copyItems, deleteItem, loadItems, moveItem, replaceItems, treeOf, usedInCount,
} from "../services/template-items.js";
import { parse } from "./auth.js";
import { tagDto } from "./tags.js";

export const id = z.string().uuid();
export const title = z.string().trim().min(1).max(200);
export const idParams = z.object({ id });

/** Punkt mit beliebig vielen Unterpunkten (nur für Anlegen/Speichern einer ganzen Vorlage; IDs vergibt der Server). */
export const itemInput = z.object({
  title: title.optional(),
  /** Verweis auf eine andere eigene Vorlage: deren Punkte erscheinen als Unterpunkte; dann sind `title` und `children` unnötig. */
  refTemplateId: id.optional(),
  get children() { return z.array(itemInput).optional(); },
});

export const templateBody = z.object({
  title,
  tagIds: z.array(id).max(50).optional(),
  /** Vollständiger Punktebaum; ersetzt beim Ändern alle bisherigen Punkte. Ohne Angabe bleiben Punkte unverändert. */
  items: z.array(itemInput).optional(),
});
/** Nicht rekursive Fassung nur für die OpenAPI-Beschreibung (`children` hat dieselbe Form wie ein Punkt). */
const itemInputDoc = z.object({ title: title.optional(), refTemplateId: id.optional(), children: z.array(z.record(z.string(), z.unknown())).optional() });
export const templateBodyDoc = templateBody.extend({ items: z.array(itemInputDoc).optional() });
export const templateUpdateDoc = templateBodyDoc.partial();
export const templateUpdate = templateBody.partial().refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");

export const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  tagId: id.optional(),
  sort: z.enum(["updated", "title"]).default("updated"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const itemCreate = z.object({
  title,
  parentItemId: id.nullable().optional(),
  position: z.number().int().min(0).optional(),
});
export const itemUpdate = z.object({ title: title.optional() })
  .refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");
export const itemMove = z.object({ parentItemId: id.nullable(), position: z.number().int().min(0) });

const itemErrors: Record<ItemError["code"], [number, string]> = {
  parent_not_found: [404, "parent_not_found"],
  cycle: [422, "cycle"],
  too_deep: [422, "too_deep"],
  not_found: [404, "not_found"],
  too_many_items: [422, "too_many_items"],
  ref_cycle: [422, "ref_cycle"],
  unknown_template: [422, "unknown_template"],
  title_required: [422, "validation_error"],
};

export async function templateRoutes(app: FastifyInstance, { db }: AppDeps) {
  const auth = { preHandler: app.requireUser };

  /** Eigene, nicht gelöschte Vorlage – fremde IDs verhalten sich wie nicht vorhanden (N-04). */
  const ownTemplate = (userId: string, templateId: string) =>
    db.select().from(schema.templates)
      .where(and(eq(schema.templates.id, templateId), eq(schema.templates.ownerId, userId), isNull(schema.templates.deletedAt)))
      .get();

  const tagsOf = (templateIds: string[]) => {
    const map = new Map<string, ReturnType<typeof tagDto>[]>();
    if (!templateIds.length) return map;
    const rows = db.select({ templateId: schema.templateTags.templateId, tag: schema.tags })
      .from(schema.templateTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.templateTags.tagId))
      .where(inArray(schema.templateTags.templateId, templateIds)).all();
    for (const r of rows) map.set(r.templateId, [...(map.get(r.templateId) ?? []), tagDto(r.tag)]);
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    return map;
  };

  const summary = (t: typeof schema.templates.$inferSelect, tags: ReturnType<typeof tagDto>[], itemCount: number) => ({
    id: t.id, title: t.title, tags, itemCount, createdAt: t.createdAt, updatedAt: t.updatedAt,
  });


  const touch = (templateId: string) =>
    db.update(schema.templates).set({ updatedAt: Date.now() }).where(eq(schema.templates.id, templateId)).run();

  /** Prüft, dass alle Tags dem Nutzer gehören. */
  const ownsAllTags = (userId: string, tagIds: string[]) => {
    if (!tagIds.length) return true;
    const found = db.select({ id: schema.tags.id }).from(schema.tags)
      .where(and(eq(schema.tags.userId, userId), inArray(schema.tags.id, tagIds))).all();
    return found.length === new Set(tagIds).size;
  };

  const setTags = (templateId: string, tagIds: string[]) => {
    db.delete(schema.templateTags).where(eq(schema.templateTags.templateId, templateId)).run();
    for (const tagId of new Set(tagIds)) db.insert(schema.templateTags).values({ templateId, tagId }).run();
  };

  const detail = (t: typeof schema.templates.$inferSelect) => {
    const items = loadItems(db, t.id);
    return { template: { ...summary(t, tagsOf([t.id]).get(t.id) ?? [], items.length), usedInCount: usedInCount(db, t.id), items: treeOf(db, t.id) } };
  };

  const itemFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ItemError) {
      const [status, error] = itemErrors[err.code];
      return reply.code(status).send({ error });
    }
    throw err;
  };

  // ---------- Liste (F-11) ----------
  app.get("/api/v1/templates", auth, async (req, reply) => {
    const q = parse(listQuery, req.query, reply);
    if (!q) return;
    const userId = req.user!.id;
    let rows = db.select().from(schema.templates)
      .where(and(eq(schema.templates.ownerId, userId), isNull(schema.templates.deletedAt))).all();

    const tags = tagsOf(rows.map((r) => r.id));
    const needle = q.search?.toLocaleLowerCase("de");
    if (needle) rows = rows.filter((r) => r.title.toLocaleLowerCase("de").includes(needle));
    if (q.tagId) rows = rows.filter((r) => (tags.get(r.id) ?? []).some((t) => t.id === q.tagId));
    rows.sort(q.sort === "title" ? (a, b) => a.title.localeCompare(b.title, "de") : (a, b) => b.updatedAt - a.updatedAt);

    const total = rows.length;
    const page = rows.slice(q.offset, q.offset + q.limit);
    const counts = new Map<string, number>();
    if (page.length) {
      for (const i of db.select({ templateId: schema.templateItems.templateId }).from(schema.templateItems)
        .where(inArray(schema.templateItems.templateId, page.map((p) => p.id))).all()) {
        counts.set(i.templateId, (counts.get(i.templateId) ?? 0) + 1);
      }
    }
    return { total, templates: page.map((t) => ({ ...summary(t, tags.get(t.id) ?? [], counts.get(t.id) ?? 0), usedInCount: usedInCount(db, t.id) })) };
  });

  // ---------- Anlegen / Lesen / Ändern / Löschen (F-12, F-16) ----------
  app.post("/api/v1/templates", auth, async (req, reply) => {
    const body = parse(templateBody, req.body, reply);
    if (!body) return;
    const userId = req.user!.id;
    if (!ownsAllTags(userId, body.tagIds ?? [])) return reply.code(422).send({ error: "unknown_tag" });
    let t: typeof schema.templates.$inferSelect;
    try {
      t = db.transaction((tx) => {
        const [created] = tx.insert(schema.templates).values({ ownerId: userId, title: body.title }).returning().all();
        if (body.items) replaceItems(tx, created!.id, body.items as ItemInput[], userId);
        return created!;
      });
    } catch (err) {
      return itemFail(reply, err);
    }
    setTags(t.id, body.tagIds ?? []);
    req.log.info({ event: "template_created", userId, templateId: t.id }, "Vorlage angelegt");
    return reply.code(201).send(detail(t));
  });

  app.get("/api/v1/templates/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const t = ownTemplate(req.user!.id, p.id);
    return t ? detail(t) : reply.code(404).send({ error: "not_found" });
  });

  app.put("/api/v1/templates/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(templateUpdate, req.body, reply);
    if (!p || !body) return;
    const userId = req.user!.id;
    const t = ownTemplate(userId, p.id);
    if (!t) return reply.code(404).send({ error: "not_found" });
    if (body.tagIds && !ownsAllTags(userId, body.tagIds)) return reply.code(422).send({ error: "unknown_tag" });
    let updated: typeof schema.templates.$inferSelect;
    try {
      updated = db.transaction((tx) => {
        const [row] = tx.update(schema.templates)
          .set({ ...(body.title !== undefined && { title: body.title }), updatedAt: Date.now() })
          .where(eq(schema.templates.id, t.id)).returning().all();
        if (body.items) replaceItems(tx, t.id, body.items as ItemInput[], userId);
        return row!;
      });
    } catch (err) {
      return itemFail(reply, err);
    }
    if (body.tagIds) setTags(t.id, body.tagIds);
    return detail(updated);
  });

  // F-16: Löschen = Papierkorb (Soft-Delete); bestehende Durchführungen bleiben unverändert.
  app.delete("/api/v1/templates/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const t = ownTemplate(req.user!.id, p.id);
    if (!t) return reply.code(404).send({ error: "not_found" });
    db.update(schema.templates).set({ deletedAt: Date.now() }).where(eq(schema.templates.id, t.id)).run();
    req.log.info({ event: "template_deleted", userId: req.user!.id, templateId: t.id }, "Vorlage in den Papierkorb verschoben");
    return reply.code(204).send();
  });

  // F-15
  app.post("/api/v1/templates/:id/duplicate", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const t = ownTemplate(req.user!.id, p.id);
    if (!t) return reply.code(404).send({ error: "not_found" });
    const copy = db.transaction((tx) => {
      const [c] = tx.insert(schema.templates)
        .values({ ownerId: t.ownerId, title: `${t.title} (Kopie)`.slice(0, 200) }).returning().all();
      copyItems(tx, t.id, c!.id);
      for (const link of tx.select().from(schema.templateTags).where(eq(schema.templateTags.templateId, t.id)).all()) {
        tx.insert(schema.templateTags).values({ templateId: c!.id, tagId: link.tagId }).run();
      }
      return c!;
    });
    req.log.info({ event: "template_duplicated", userId: req.user!.id, templateId: t.id, copyId: copy.id }, "Vorlage dupliziert");
    return reply.code(201).send(detail(copy));
  });

  // ---------- Punkte (F-13, F-14) ----------
  /** Punkt samt Vorlage laden; nur wenn die Vorlage dem Nutzer gehört und nicht gelöscht ist. */
  const ownItem = (userId: string, itemId: string) => {
    const item = db.select().from(schema.templateItems).where(eq(schema.templateItems.id, itemId)).get();
    return item && ownTemplate(userId, item.templateId) ? item : undefined;
  };

  app.post("/api/v1/templates/:id/items", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(itemCreate, req.body, reply);
    if (!p || !body) return;
    const t = ownTemplate(req.user!.id, p.id);
    if (!t) return reply.code(404).send({ error: "not_found" });
    try {
      const item = addItem(db, t.id, body);
      touch(t.id);
      return reply.code(201).send({ itemId: item.id, items: treeOf(db, t.id) });
    } catch (err) {
      return itemFail(reply, err);
    }
  });

  app.put("/api/v1/template-items/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(itemUpdate, req.body, reply);
    if (!p || !body) return;
    const item = ownItem(req.user!.id, p.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    db.update(schema.templateItems)
      .set({ ...(body.title !== undefined && { title: body.title }), })
      .where(eq(schema.templateItems.id, item.id)).run();
    touch(item.templateId);
    return { items: treeOf(db, item.templateId) };
  });

  app.delete("/api/v1/template-items/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const item = ownItem(req.user!.id, p.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    deleteItem(db, item);
    touch(item.templateId);
    return { items: treeOf(db, item.templateId) };
  });

  // Drag-and-Drop: neuer Elternpunkt (oder null = oberste Ebene) und Index unter den Geschwistern.
  app.post("/api/v1/template-items/:id/move", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(itemMove, req.body, reply);
    if (!p || !body) return;
    const item = ownItem(req.user!.id, p.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    try {
      moveItem(db, item, body.parentItemId, body.position);
      touch(item.templateId);
      return { items: treeOf(db, item.templateId) };
    } catch (err) {
      return itemFail(reply, err);
    }
  });
}
