import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { AppDeps } from "../server.js";
import { DELIMITERS } from "../services/csv.js";
import {
  exportAll, exportRun, exportTemplate, runToCsv, runToMarkdown, templateToCsv, templateToMarkdown,
} from "../services/export.js";
import { applyImport, planFromCsv, planFromJson, previewOf, type ImportIssue } from "../services/import.js";
import { parse } from "./auth.js";

export const idParams = z.object({ id: z.string().uuid() });
export const exportQuery = z.object({
  format: z.enum(["json", "csv", "md"]).default("json").describe("json = vollständig, csv = tabellarisch, md = lesbar/druckbar"),
  delimiter: z.enum(["comma", "semicolon", "tab"]).default("comma").describe("Trennzeichen bei CSV (Excel in Deutschland: semicolon)"),
});
export const allExportQuery = z.object({
  scope: z.enum(["all", "templates"]).default("all").describe("all = Vorlagen und Checklisten, templates = nur Vorlagen (mit Tags)"),
});
export const importBody = z.object({
  format: z.enum(["json", "csv"]),
  /** JSON: Text oder Objekt im Export-Format · CSV: Text mit den Spalten Vorlage, Ebene, Titel */
  content: z.union([z.string().max(10_000_000), z.record(z.string(), z.unknown())]),
  /** Nur CSV ohne Spalte „Vorlage“: Name der Vorlage, in die alle Zeilen importiert werden */
  title: z.string().trim().min(1).max(200).optional(),
  /** true = nur prüfen und Vorschau liefern, nichts anlegen */
  dryRun: z.boolean().optional(),
  /** true = Checklisten in der Datei ignorieren, nur Vorlagen importieren */
  templatesOnly: z.boolean().optional(),
});

const MIME = { json: "application/json", csv: "text/csv", md: "text/markdown" } as const;
const slug = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "export";

/** Sendet eine Datei zum Herunterladen (kein Caching, sicherer Dateiname). */
function download(reply: FastifyReply, name: string, ext: "json" | "csv" | "md", body: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${slug(name)}-${stamp}.${ext}`;
  return reply
    .header("Content-Type", `${MIME[ext]}; charset=utf-8`)
    .header("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`)
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .send(body);
}

const countItems = (list: { items: any[] }[]): number => list.reduce((n, t) => n + count(t.items), 0);
const count = (items: { children: any[] }[]): number => items.reduce((n, i) => n + 1 + count(i.children), 0);

export async function importExportRoutes(app: FastifyInstance, { db }: AppDeps) {
  const auth = { preHandler: app.requireUser };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  // ---------- Export (F-50) ----------
  /** Alle eigenen Daten (ohne Papierkorb) für Sicherung und Migration. */
  app.get("/api/v1/export", auth, async (req, reply) => {
    const q = parse(allExportQuery, req.query, reply);
    if (!q) return;
    const doc = exportAll(db, req.user!.id);
    if (q.scope === "templates") doc.runs = [];
    req.log.info({ event: "export", userId: req.user!.id, scope: q.scope, templates: doc.templates.length, runs: doc.runs.length }, "Export");
    return download(reply, q.scope === "templates" ? "vorlagen" : "checklisten-daten", "json", JSON.stringify(doc, null, 2));
  });

  app.get("/api/v1/templates/:id/export", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const q = parse(exportQuery, req.query, reply);
    if (!p || !q) return;
    const t = db.select().from(schema.templates)
      .where(and(eq(schema.templates.id, p.id), eq(schema.templates.ownerId, req.user!.id), isNull(schema.templates.deletedAt))).get();
    if (!t) return notFound(reply);
    const doc = exportTemplate(db, t);
    req.log.info({ event: "export", userId: req.user!.id, scope: "template", format: q.format }, "Export");
    if (q.format === "csv") return download(reply, t.title, "csv", templateToCsv(doc, DELIMITERS[q.delimiter]));
    if (q.format === "md") return download(reply, t.title, "md", templateToMarkdown(doc));
    return download(reply, t.title, "json", JSON.stringify({ format: "checklisten-export", version: 1, exportedAt: new Date().toISOString(), tags: [], templates: [doc], runs: [] }, null, 2));
  });

  app.get("/api/v1/runs/:id/export", auth, async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const q = parse(exportQuery, req.query, reply);
    if (!p || !q) return;
    const r = db.select().from(schema.runs)
      .where(and(eq(schema.runs.id, p.id), eq(schema.runs.ownerId, req.user!.id), isNull(schema.runs.deletedAt))).get();
    if (!r) return notFound(reply);
    const doc = exportRun(db, r);
    req.log.info({ event: "export", userId: req.user!.id, scope: "run", format: q.format }, "Export");
    if (q.format === "csv") return download(reply, r.title, "csv", runToCsv(doc, DELIMITERS[q.delimiter]));
    if (q.format === "md") return download(reply, r.title, "md", runToMarkdown(doc));
    return download(reply, r.title, "json", JSON.stringify({ format: "checklisten-export", version: 1, exportedAt: new Date().toISOString(), tags: [], templates: [], runs: [doc] }, null, 2));
  });

  // ---------- Import (F-51) ----------
  app.post("/api/v1/import", { ...auth, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(importBody, req.body, reply);
    if (!body) return;
    const userId = req.user!.id;

    let planned: { plan: ReturnType<typeof planFromJson>["plan"]; issues: ImportIssue[]; itemCount: number; warnings?: string[] };
    if (body.format === "json") {
      planned = planFromJson(body.content);
    } else {
      if (typeof body.content !== "string") return reply.code(400).send({ error: "validation_error", details: [{ path: "content", message: "CSV muss als Text übergeben werden" }] });
      planned = planFromCsv(body.content, body.title);
    }
    const warnings = [...(planned.warnings ?? [])];
    if (body.templatesOnly) {
      if (planned.plan.runs.length) warnings.push(`${planned.plan.runs.length} Checkliste(n) in der Datei wurden ignoriert (nur Vorlagen werden importiert).`);
      planned.plan.runs = [];
      planned.itemCount = countItems(planned.plan.templates);
      if (planned.issues.length === 0 && planned.plan.templates.length === 0) planned.issues.push({ path: "", message: "Keine Vorlagen enthalten" });
    }

    if (body.dryRun) {
      const valid = planned.issues.length === 0;
      return {
        valid, issues: planned.issues, warnings,
        ...(valid && { counts: { templates: planned.plan.templates.length, runs: planned.plan.runs.length, items: planned.itemCount }, preview: previewOf(db, userId, planned.plan) }),
      };
    }
    if (planned.issues.length) return reply.code(422).send({ error: "import_invalid", issues: planned.issues, warnings });

    const result = applyImport(db, userId, planned.plan);
    req.log.info({ event: "import", userId, format: body.format, ...result }, "Import abgeschlossen");
    return reply.code(201).send({ result, warnings });
  });
}
