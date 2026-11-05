import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPassword } from "../auth/password.js";
import { LoginThrottle } from "../auth/throttle.js";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import {
  RunItemError, addRunItem, deleteRunItem, loadSections, moveRunItem, runDetail, updateRunItem,
} from "../services/run-items.js";
import {
  SharePasswordRequired, activeShareOfRun, findShareByToken, regenerateShare, revokeShare, saveShare, shareDto, sharesOfUser,
  type Share,
} from "../services/shares.js";
import { parse } from "./auth.js";

export const id = z.string().uuid();
export const idParams = z.object({ id });
export const sharePassword = z.string().min(8, "Passwort muss mindestens 8 Zeichen haben").max(128);
export const settingsBody = z.object({
  access: z.enum(["anyone", "password"]),
  permission: z.enum(["view", "edit"]),
  password: sharePassword.optional(),
});

export const tokenParams = z.object({ token: z.string().min(10).max(100) });
const itemParams = tokenParams.extend({ itemId: id });
const sectionParams = tokenParams.extend({ sectionId: id });
export const title = z.string().trim().min(1).max(200);
export const description = z.string().max(5000).nullable();
export const itemCreate = z.object({ title, description: description.optional(), parentItemId: id.nullable().optional(), position: z.number().int().min(0).optional() });
export const itemUpdate = z.object({ title: title.optional(), description: description.optional(), isChecked: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, "Keine Änderungen übergeben");
export const itemMove = z.object({ sectionId: id.optional(), parentItemId: id.nullable(), position: z.number().int().min(0) });

const itemErrors: Record<RunItemError["code"], [number, string]> = {
  parent_not_found: [404, "parent_not_found"], section_not_found: [404, "section_not_found"],
  cycle: [422, "cycle"], too_deep: [422, "too_deep"],
};

export async function shareRoutes(app: FastifyInstance, { config, db }: AppDeps) {
  const auth = { preHandler: app.requireUser };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  /** Eigene, nicht gelöschte Durchführung. */
  const ownRun = (userId: string, runId: string) =>
    db.select().from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.ownerId, userId), isNull(schema.runs.deletedAt))).get();

  // ======================= Besitzer: Link verwalten (F-40 bis F-43) =======================
  app.get("/api/v1/runs/:id/share", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    const share = activeShareOfRun(db, run.id);
    return { share: share ? shareDto(config, share) : null };
  });

  /** Anlegen oder Einstellungen ändern (Link bleibt gleich). Archivierte Durchführungen sind nicht teilbar (F-44). */
  app.put("/api/v1/runs/:id/share", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = parse(settingsBody, req.body, reply);
    if (!p || !body) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    if (run.status !== "active") return reply.code(409).send({ error: "run_not_active" });
    try {
      const { share, created } = await saveShare(db, config, run.id, body);
      req.log.info({ event: created ? "share_created" : "share_updated", userId: req.user!.id, runId: run.id, shareId: share.id, access: share.access, permission: share.permission }, created ? "Freigabelink angelegt" : "Freigabe geändert");
      return reply.code(created ? 201 : 200).send({ share: shareDto(config, share) });
    } catch (err) {
      if (err instanceof SharePasswordRequired) return reply.code(422).send({ error: "password_required" });
      throw err;
    }
  });

  app.post("/api/v1/runs/:id/share/regenerate", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    if (!run) return notFound(reply);
    const share = await regenerateShare(db, config, run.id);
    if (!share) return notFound(reply);
    req.log.info({ event: "share_regenerated", userId: req.user!.id, runId: run.id, shareId: share.id }, "Freigabelink neu erzeugt");
    return { share: shareDto(config, share) };
  });

  app.delete("/api/v1/runs/:id/share", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const run = ownRun(req.user!.id, p.id);
    const share = run && activeShareOfRun(db, run.id);
    if (!run || !share) return notFound(reply);
    revokeShare(db, share.id);
    req.log.info({ event: "share_revoked", userId: req.user!.id, runId: run.id, shareId: share.id }, "Freigabelink widerrufen");
    return reply.code(204).send();
  });

  // ======================= Besitzer: Übersicht im Profil (F-45) =======================
  app.get("/api/v1/me/shares", auth, async (req) => ({
    shares: sharesOfUser(db, req.user!.id)
      .sort((a, b) => b.share.createdAt - a.share.createdAt)
      .map(({ share, run }) => ({
        ...shareDto(config, share), runId: run.id, runTitle: run.title, runStatus: run.status,
        /** Im Papierkorb ist der Link unwirksam, wird aber bei Wiederherstellung wieder gültig (F-44). */
        runDeleted: run.deletedAt !== null,
      })),
  }));

  app.delete("/api/v1/me/shares/:id", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    const own = sharesOfUser(db, req.user!.id).find((s) => s.share.id === p.id);
    if (!own) return notFound(reply);
    revokeShare(db, own.share.id);
    req.log.info({ event: "share_revoked", userId: req.user!.id, runId: own.run.id, shareId: own.share.id }, "Freigabelink widerrufen");
    return reply.code(204).send();
  });

  app.delete("/api/v1/me/shares", auth, async (req) => {
    const own = sharesOfUser(db, req.user!.id);
    own.forEach((s) => revokeShare(db, s.share.id));
    req.log.info({ event: "shares_revoked_all", userId: req.user!.id, count: own.length }, "Alle Freigaben zurückgezogen");
    return { revoked: own.length };
  });

  // ======================= Öffentlich: Zugriff über den Link (F-40 bis F-44) =======================
  const throttle = new LoginThrottle();
  const ipLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/v1/public/")) return;
    reply.header("X-Robots-Tag", "noindex, nofollow").header("Cache-Control", "no-store");
  });

  /** Prüft Token, Durchführung (aktiv, nicht gelöscht) und ggf. Passwort. Gibt null zurück, nachdem geantwortet wurde. */
  async function resolve(req: FastifyRequest, reply: FastifyReply, token: string, needEdit: boolean) {
    const share = findShareByToken(db, token);
    const run = share && db.select().from(schema.runs).where(eq(schema.runs.id, share.runId)).get();
    // Gelöscht oder nicht aktiv (z. B. archiviert): Link ist unwirksam.
    if (!share || !run || run.deletedAt !== null || run.status !== "active") {
      reply.code(404).send({ error: "not_found" });
      return null;
    }
    if (share.access === "password") {
      const key = `${share.id}:${req.ip}`;
      const wait = throttle.retryAfterSeconds(key);
      if (wait > 0) {
        reply.code(429).header("Retry-After", String(wait)).send({ error: "too_many_attempts", retryAfterSeconds: wait });
        return null;
      }
      const given = req.headers["x-share-password"];
      const pw = Array.isArray(given) ? given[0] : given;
      if (!pw) {
        reply.code(401).send({ error: "password_required" });
        return null;
      }
      if (!share.passwordHash || !(await verifyPassword(share.passwordHash, pw))) {
        throttle.fail(key);
        req.log.warn({ event: "share_password_failed", shareId: share.id }, "Falsches Freigabe-Passwort");
        reply.code(401).send({ error: "invalid_password" });
        return null;
      }
      throttle.reset(key);
    }
    if (needEdit && share.permission !== "edit") {
      reply.code(403).send({ error: "read_only_link" });
      return null;
    }
    return { share, run };
  }

  const view = (share: Share, run: typeof schema.runs.$inferSelect) => ({
    permission: share.permission,
    run: { title: run.title, updatedAt: run.updatedAt, ...runDetail(db, run.id) },
  });
  const touch = (runId: string) => db.update(schema.runs).set({ updatedAt: Date.now() }).where(eq(schema.runs.id, runId)).run();
  const itemFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RunItemError) {
      const [status, error] = itemErrors[err.code];
      return reply.code(status).send({ error });
    }
    throw err;
  };
  /** Punkt, der zur geteilten Durchführung gehört – sonst null. */
  const itemOfRun = (runId: string, itemId: string) => {
    const item = db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    return item && loadSections(db, runId).some((s) => s.id === item.sectionId) ? item : null;
  };
  const fresh = (runId: string) => db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;

  app.get("/api/v1/public/runs/:token", ipLimit(120), async (req, reply) => {
    const p = parse(tokenParams, req.params, reply);
    if (!p) return;
    const r = await resolve(req, reply, p.token, false);
    if (!r) return;
    req.log.info({ event: "share_accessed", shareId: r.share.id }, "Freigabelink aufgerufen");
    return view(r.share, r.run);
  });

  // Bearbeiten über den Link: abhaken sowie Punkte hinzufügen, ändern, löschen, umsortieren (F-42).
  app.put("/api/v1/public/runs/:token/items/:itemId", ipLimit(120), async (req, reply) => {
    const p = parse(itemParams, req.params, reply);
    const body = parse(itemUpdate, req.body, reply);
    if (!p || !body) return;
    const r = await resolve(req, reply, p.token, true);
    if (!r) return;
    const item = itemOfRun(r.run.id, p.itemId);
    if (!item) return reply.code(404).send({ error: "not_found" });
    updateRunItem(db, item, body);
    touch(r.run.id);
    req.log.info({ event: "share_edit", shareId: r.share.id, action: "update_item" }, "Änderung über Freigabelink");
    return view(r.share, fresh(r.run.id));
  });

  app.post("/api/v1/public/runs/:token/sections/:sectionId/items", ipLimit(60), async (req, reply) => {
    const p = parse(sectionParams, req.params, reply);
    const body = parse(itemCreate, req.body, reply);
    if (!p || !body) return;
    const r = await resolve(req, reply, p.token, true);
    if (!r) return;
    const section = loadSections(db, r.run.id).find((s) => s.id === p.sectionId);
    if (!section) return reply.code(404).send({ error: "not_found" });
    try {
      const item = addRunItem(db, section, body);
      touch(r.run.id);
      req.log.info({ event: "share_edit", shareId: r.share.id, action: "add_item" }, "Änderung über Freigabelink");
      return reply.code(201).send({ itemId: item.id, ...view(r.share, fresh(r.run.id)) });
    } catch (err) {
      return itemFail(reply, err);
    }
  });

  app.delete("/api/v1/public/runs/:token/items/:itemId", ipLimit(60), async (req, reply) => {
    const p = parse(itemParams, req.params, reply);
    if (!p) return;
    const r = await resolve(req, reply, p.token, true);
    if (!r) return;
    const item = itemOfRun(r.run.id, p.itemId);
    if (!item) return reply.code(404).send({ error: "not_found" });
    deleteRunItem(db, item);
    touch(r.run.id);
    req.log.info({ event: "share_edit", shareId: r.share.id, action: "delete_item" }, "Änderung über Freigabelink");
    return view(r.share, fresh(r.run.id));
  });

  app.post("/api/v1/public/runs/:token/items/:itemId/move", ipLimit(60), async (req, reply) => {
    const p = parse(itemParams, req.params, reply);
    const body = parse(itemMove, req.body, reply);
    if (!p || !body) return;
    const r = await resolve(req, reply, p.token, true);
    if (!r) return;
    const item = itemOfRun(r.run.id, p.itemId);
    if (!item) return reply.code(404).send({ error: "not_found" });
    try {
      moveRunItem(db, item, r.run.id, body.sectionId ?? item.sectionId, body.parentItemId, body.position);
      touch(r.run.id);
      req.log.info({ event: "share_edit", shareId: r.share.id, action: "move_item" }, "Änderung über Freigabelink");
      return view(r.share, fresh(r.run.id));
    } catch (err) {
      return itemFail(reply, err);
    }
  });
}
