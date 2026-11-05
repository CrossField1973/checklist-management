import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { buildSections, loadRunItems, loadSections, type RunItemNode } from "./run-items.js";
import { buildTree, loadItems, type ItemNode } from "./template-items.js";
import { toCsv, type Delimiter } from "./csv.js";

export const EXPORT_FORMAT = "checklisten-export";
export const EXPORT_VERSION = 1;

export interface ExportItem { title: string; description: string | null; children: ExportItem[] }
export interface ExportRunItem extends ExportItem { isChecked: boolean; checkedAt: string | null; children: ExportRunItem[] }
export interface ExportTemplate { title: string; description: string | null; tags: string[]; items: ExportItem[]; deletedAt?: string }
export interface ExportRun {
  title: string; status: "active" | "archived"; createdAt: string; archivedAt: string | null;
  sections: { title: string; items: ExportRunItem[] }[];
  deletedAt?: string;
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

const toExportItems = (nodes: ItemNode[]): ExportItem[] =>
  nodes.map((n) => ({ title: n.title, description: n.description, children: toExportItems(n.children) }));
const toExportRunItems = (nodes: RunItemNode[]): ExportRunItem[] =>
  nodes.map((n) => ({ title: n.title, description: n.description, isChecked: n.isChecked, checkedAt: iso(n.checkedAt), children: toExportRunItems(n.children) }));

type TemplateRow = typeof schema.templates.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

function tagNamesOf(db: Db, templateId: string): string[] {
  return db.select({ name: schema.tags.name }).from(schema.templateTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.templateTags.tagId))
    .where(eq(schema.templateTags.templateId, templateId)).all().map((r) => r.name).sort((a, b) => a.localeCompare(b, "de"));
}

export function exportTemplate(db: Db, t: TemplateRow): ExportTemplate {
  return {
    title: t.title, description: t.description, tags: tagNamesOf(db, t.id),
    items: toExportItems(buildTree(loadItems(db, t.id))),
    ...(t.deletedAt !== null && { deletedAt: iso(t.deletedAt)! }),
  };
}

export function exportRun(db: Db, r: RunRow): ExportRun {
  const sections = buildSections(loadSections(db, r.id), loadRunItems(db, r.id));
  return {
    title: r.title, status: r.status, createdAt: iso(r.createdAt)!, archivedAt: iso(r.archivedAt),
    sections: sections.map((s) => ({ title: s.title, items: toExportRunItems(s.items) })),
    ...(r.deletedAt !== null && { deletedAt: iso(r.deletedAt)! }),
  };
}

const header = () => ({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString() });

/** Alle eigenen Daten für Sicherung/Migration (ohne Papierkorb). Import erzeugt immer neue Datensätze. */
export function exportAll(db: Db, userId: string, opts: { includeTrash?: boolean } = {}) {
  const templates = db.select().from(schema.templates).where(eq(schema.templates.ownerId, userId)).all()
    .filter((t) => opts.includeTrash || t.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt);
  const runs = db.select().from(schema.runs).where(eq(schema.runs.ownerId, userId)).all()
    .filter((r) => opts.includeTrash || r.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt);
  return {
    ...header(),
    tags: db.select().from(schema.tags).where(eq(schema.tags.userId, userId)).orderBy(schema.tags.name).all().map((t) => ({ name: t.name, color: t.color })),
    templates: templates.map((t) => exportTemplate(db, t)),
    runs: runs.map((r) => exportRun(db, r)),
  };
}

/** Vollständiger Konto-Export (DSGVO, F-52): inkl. Profil, Papierkorb, Freigabe-Einstellungen und Token-Metadaten – ohne Geheimnisse. */
export function exportAccount(db: Db, user: typeof schema.users.$inferSelect) {
  const shares = db.select({ share: schema.runShares, runTitle: schema.runs.title }).from(schema.runShares)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.runShares.runId)).where(eq(schema.runs.ownerId, user.id)).all();
  return {
    ...exportAll(db, user.id, { includeTrash: true }),
    account: {
      email: user.email, displayName: user.displayName, language: user.language, theme: user.theme,
      trashRetentionDays: user.trashRetentionDays, twoFactorEnabled: user.totpEnabledAt !== null, createdAt: iso(user.createdAt),
    },
    shares: shares.map(({ share, runTitle }) => ({
      run: runTitle, access: share.access, permission: share.permission, passwordProtected: share.passwordHash !== null,
      createdAt: iso(share.createdAt), revokedAt: iso(share.revokedAt),
    })),
    apiTokens: db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.userId, user.id), isNull(schema.apiTokens.revokedAt))).all()
      .map((t) => ({ name: t.name, prefix: t.tokenPrefix, permission: t.permission, expiresAt: iso(t.expiresAt), lastUsedAt: iso(t.lastUsedAt), createdAt: iso(t.createdAt) })),
  };
}

// ---------------------------------------------------------------------------------------------
// CSV (Vorlagen: Vorlage, Ebene, Titel, Beschreibung – Durchführungen: Abschnitt, Ebene, Titel, Beschreibung, Erledigt, Erledigt am)
// ---------------------------------------------------------------------------------------------
export const TEMPLATE_CSV_HEADER = ["Vorlage", "Ebene", "Titel", "Beschreibung"];
export const RUN_CSV_HEADER = ["Abschnitt", "Ebene", "Titel", "Beschreibung", "Erledigt", "Erledigt am"];

function flatten<T extends ExportItem>(items: T[], level = 1): { level: number; item: T }[] {
  return items.flatMap((item) => [{ level, item }, ...flatten(item.children as T[], level + 1)]);
}

export function templateToCsv(t: ExportTemplate, delimiter: Delimiter): string {
  const rows = flatten(t.items).map(({ level, item }) => [t.title, String(level), item.title, item.description ?? ""]);
  return toCsv([TEMPLATE_CSV_HEADER, ...rows], delimiter);
}

export function runToCsv(r: ExportRun, delimiter: Delimiter): string {
  const rows = r.sections.flatMap((s) =>
    flatten(s.items).map(({ level, item }) => [s.title, String(level), item.title, item.description ?? "", item.isChecked ? "ja" : "nein", item.checkedAt ?? ""]));
  return toCsv([RUN_CSV_HEADER, ...rows], delimiter);
}

// ---------------------------------------------------------------------------------------------
// Markdown (lesbar/druckbar)
// ---------------------------------------------------------------------------------------------
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

function mdItems(items: ExportItem[], checkbox: boolean, depth = 0): string[] {
  return items.flatMap((i) => {
    const box = checkbox ? ((i as ExportRunItem).isChecked ? "[x] " : "[ ] ") : "";
    const desc = i.description ? ` – ${oneLine(i.description)}` : "";
    return [`${"  ".repeat(depth)}- ${box}${oneLine(i.title)}${desc}`, ...mdItems(i.children, checkbox, depth + 1)];
  });
}

export function templateToMarkdown(t: ExportTemplate): string {
  const parts = [`# ${oneLine(t.title)}`];
  if (t.description) parts.push(t.description.trim());
  if (t.tags.length) parts.push(`Tags: ${t.tags.join(", ")}`);
  if (t.items.length) parts.push(mdItems(t.items, false).join("\n"));
  return parts.join("\n\n") + "\n";
}

export function runToMarkdown(r: ExportRun): string {
  const parts = [`# ${oneLine(r.title)}`];
  for (const s of r.sections) {
    parts.push(`## ${oneLine(s.title)}`);
    if (s.items.length) parts.push(mdItems(s.items, true).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}
