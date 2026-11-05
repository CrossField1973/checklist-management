import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HEX_COLOR, pickDistinctColor, readableTextColor } from "../colors.js";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import { parse } from "./auth.js";

export const name = z.string().trim().min(1).max(50);
export const color = z.string().regex(HEX_COLOR, "Farbe muss das Format #RRGGBB haben");
export const createBody = z.object({ name, color: color.optional() });
export const updateBody = z.object({ name: name.optional(), color: color.optional() }).refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");
export const idParams = z.object({ id: z.string().uuid() });

export const tagDto = (t: { id: string; name: string; color: string }) => ({
  id: t.id,
  name: t.name,
  color: t.color.toLowerCase(),
  textColor: readableTextColor(t.color),
});

export async function tagRoutes(app: FastifyInstance, { db }: AppDeps) {
  const auth = { preHandler: app.requireUser };

  const ownTag = (userId: string, id: string) =>
    db.select().from(schema.tags).where(and(eq(schema.tags.id, id), eq(schema.tags.userId, userId))).get();
  const nameTaken = (userId: string, tagName: string, exceptId?: string) =>
    db.select().from(schema.tags).where(eq(schema.tags.userId, userId)).all()
      .some((t) => t.id !== exceptId && t.name.toLowerCase() === tagName.toLowerCase());

  // F-17: Liste inkl. Anzahl verwendeter Vorlagen
  app.get("/api/v1/tags", auth, async (req) => {
    const rows = db.select().from(schema.tags).where(eq(schema.tags.userId, req.user!.id)).orderBy(schema.tags.name).all();
    const counts = new Map(
      db.select({ tagId: schema.templateTags.tagId, n: count() })
        .from(schema.templateTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.templateTags.tagId))
        .where(eq(schema.tags.userId, req.user!.id))
        .groupBy(schema.templateTags.tagId)
        .all()
        .map((r) => [r.tagId, r.n]),
    );
    return { tags: rows.map((t) => ({ ...tagDto(t), templateCount: counts.get(t.id) ?? 0 })) };
  });

  // F-18: Ohne Farbangabe wird automatisch die am stärksten abweichende Farbe gewählt.
  app.post("/api/v1/tags", auth, async (req, reply) => {
    const body = parse(createBody, req.body, reply);
    if (!body) return;
    const userId = req.user!.id;
    if (nameTaken(userId, body.name)) return reply.code(409).send({ error: "tag_name_taken" });
    const existing = db.select({ color: schema.tags.color }).from(schema.tags).where(eq(schema.tags.userId, userId)).all().map((t) => t.color);
    const [tag] = db.insert(schema.tags).values({ userId, name: body.name, color: (body.color ?? pickDistinctColor(existing)).toLowerCase() }).returning().all();
    req.log.info({ event: "tag_created", userId, tagId: tag!.id }, "Tag angelegt");
    return reply.code(201).send({ tag: tagDto(tag!) });
  });

  app.put("/api/v1/tags/:id", auth, async (req, reply) => {
    const params = parse(idParams, req.params, reply);
    const body = parse(updateBody, req.body, reply);
    if (!params || !body) return;
    const tag = ownTag(req.user!.id, params.id);
    if (!tag) return reply.code(404).send({ error: "not_found" });
    if (body.name && nameTaken(req.user!.id, body.name, tag.id)) return reply.code(409).send({ error: "tag_name_taken" });
    const [updated] = db.update(schema.tags)
      .set({ ...(body.name && { name: body.name }), ...(body.color && { color: body.color.toLowerCase() }) })
      .where(eq(schema.tags.id, tag.id)).returning().all();
    return { tag: tagDto(updated!) };
  });

  // Löschen entfernt nur die Zuordnungen zu Vorlagen (Cascade), nicht die Vorlagen selbst.
  app.delete("/api/v1/tags/:id", auth, async (req, reply) => {
    const params = parse(idParams, req.params, reply);
    if (!params) return;
    const tag = ownTag(req.user!.id, params.id);
    if (!tag) return reply.code(404).send({ error: "not_found" });
    db.delete(schema.tags).where(eq(schema.tags.id, tag.id)).run();
    req.log.info({ event: "tag_deleted", userId: req.user!.id, tagId: tag.id }, "Tag gelöscht");
    return reply.code(204).send();
  });
}
