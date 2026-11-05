import { eq } from "drizzle-orm";
import { z } from "zod";
import { HEX_COLOR, pickDistinctColor } from "../colors.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { EXPORT_FORMAT, EXPORT_VERSION } from "./export.js";
import { detectDelimiter, parseCsv, stripBom, unguardFormula } from "./csv.js";
import { MAX_DEPTH } from "./template-items.js";

/** Grenzen schützen vor versehentlich riesigen oder bösartigen Dateien. */
export const LIMITS = { templates: 2000, runs: 2000, items: 50_000, rows: 50_000, tags: 500 } as const;

export interface ImportIssue { path: string; message: string }

// ---------- Zielstruktur (gleich für JSON und CSV) ----------
interface PItem { title: string; description: string | null; isChecked: boolean; checkedAt: number | null; children: PItem[] }
interface PTemplate { title: string; description: string | null; tags: string[]; items: PItem[] }
interface PRun { title: string; status: "active" | "archived"; sections: { title: string; items: PItem[] }[] }
interface PTag { name: string; color?: string }
export interface ImportPlan { tags: PTag[]; templates: PTemplate[]; runs: PRun[] }

// ---------- JSON-Schema der Eingabe ----------
const text = (max: number) => z.string().trim().min(1, "darf nicht leer sein").max(max, `höchstens ${max} Zeichen`);
const description = z.string().max(5000, "höchstens 5000 Zeichen").nullable().optional();
const time = z.union([z.string().datetime({ offset: true }), z.number().int().nonnegative()]).nullable().optional();

interface RawItem { title: string; description?: string | null; isChecked?: boolean; checkedAt?: string | number | null; children?: RawItem[] }
const itemSchema: z.ZodType<RawItem> = z.lazy(() =>
  z.object({
    title: text(200), description,
    isChecked: z.boolean().optional(), checkedAt: time,
    children: z.array(itemSchema).optional(),
  }),
);

const docSchema = z.object({
  format: z.literal(EXPORT_FORMAT, { error: `format muss "${EXPORT_FORMAT}" sein` }).optional(),
  version: z.literal(EXPORT_VERSION, { error: `Nur Version ${EXPORT_VERSION} wird unterstützt` }).optional(),
  tags: z.array(z.object({ name: text(50), color: z.string().regex(HEX_COLOR, "Farbe muss das Format #RRGGBB haben").optional() })).optional(),
  templates: z.array(z.object({
    title: text(200), description, tags: z.array(text(50)).optional(), items: z.array(itemSchema).optional(),
  })).optional(),
  runs: z.array(z.object({
    title: text(200),
    status: z.enum(["active", "archived"], { error: 'status muss "active" oder "archived" sein' }).optional(),
    sections: z.array(z.object({ title: text(200), items: z.array(itemSchema).optional() })).optional(),
  })).optional(),
});

const formatPath = (path: PropertyKey[]) =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");

const toMs = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  return typeof v === "number" ? v : Date.parse(v);
};

function convertItems(raw: RawItem[] | undefined, isRun: boolean, path: string, depth: number, issues: ImportIssue[], counter: { items: number }): PItem[] {
  return (raw ?? []).map((r, i) => {
    counter.items += 1;
    const here = `${path}[${i}]`;
    if (depth > MAX_DEPTH) issues.push({ path: here, message: `Verschachtelung tiefer als ${MAX_DEPTH} Ebenen` });
    const checked = isRun ? Boolean(r.isChecked) : false;
    return {
      title: r.title, description: r.description ?? null, isChecked: checked,
      checkedAt: checked ? (toMs(r.checkedAt) ?? Date.now()) : null,
      children: depth > MAX_DEPTH ? [] : convertItems(r.children, isRun, `${here}.children`, depth + 1, issues, counter),
    };
  });
}

/** Prüft ein JSON-Dokument (Export-Format) und überführt es in den Importplan. */
export function planFromJson(input: unknown): { plan: ImportPlan; issues: ImportIssue[]; itemCount: number } {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(stripBom(input)); } catch (e) {
      return { plan: empty(), issues: [{ path: "", message: `Kein gültiges JSON: ${(e as Error).message}` }], itemCount: 0 };
    }
  }
  const parsed = docSchema.safeParse(value);
  if (!parsed.success) {
    return { plan: empty(), issues: parsed.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })), itemCount: 0 };
  }
  const d = parsed.data;
  const issues: ImportIssue[] = [];
  const counter = { items: 0 };
  if ((d.templates?.length ?? 0) + (d.runs?.length ?? 0) === 0) issues.push({ path: "", message: "Keine Vorlagen oder Durchführungen enthalten" });
  if ((d.templates?.length ?? 0) > LIMITS.templates) issues.push({ path: "templates", message: `Höchstens ${LIMITS.templates} Vorlagen pro Import` });
  if ((d.runs?.length ?? 0) > LIMITS.runs) issues.push({ path: "runs", message: `Höchstens ${LIMITS.runs} Durchführungen pro Import` });
  if ((d.tags?.length ?? 0) > LIMITS.tags) issues.push({ path: "tags", message: `Höchstens ${LIMITS.tags} Tags pro Import` });

  const plan: ImportPlan = {
    tags: d.tags ?? [],
    templates: (d.templates ?? []).map((t, ti) => ({
      title: t.title, description: t.description ?? null, tags: t.tags ?? [],
      items: convertItems(t.items, false, `templates[${ti}].items`, 1, issues, counter),
    })),
    runs: (d.runs ?? []).map((r, ri) => ({
      title: r.title, status: r.status ?? "active",
      sections: (r.sections ?? []).map((s, si) => ({
        title: s.title, items: convertItems(s.items, true, `runs[${ri}].sections[${si}].items`, 1, issues, counter),
      })),
    })),
  };
  if (counter.items > LIMITS.items) issues.push({ path: "", message: `Höchstens ${LIMITS.items} Punkte pro Import (gefunden: ${counter.items})` });
  return { plan, issues, itemCount: counter.items };
}

const empty = (): ImportPlan => ({ tags: [], templates: [], runs: [] });

// ---------- CSV ----------
const fold = (s: string) => s.toLowerCase().replace(/[\s_\-.]/g, "").replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");
const ALIASES: Record<"template" | "level" | "title" | "description", string[]> = {
  template: ["vorlage", "template", "checkliste", "checklist", "liste", "list", "taskchecklist", "checklistname", "vorlagenname"],
  level: ["ebene", "level", "stufe", "tiefe", "depth"],
  title: ["titel", "title", "name", "aufgabe", "task", "punkt", "item", "taskname"],
  description: ["beschreibung", "description", "desc", "notiz", "notes", "details"],
};

/**
 * Liest eine CSV-Datei (Komma, Semikolon oder Tab) mit den Spalten Vorlage, Ebene, Titel, Beschreibung.
 * Die Ebene (1 = oberste, 2 = Unterpunkt …) bestimmt zusammen mit der Zeilenreihenfolge die Verschachtelung.
 * Ohne Spalte „Vorlage“ wird `fallbackTitle` als Vorlagenname verwendet (z. B. für den Export einer Mendix-Aufgabenliste).
 */
export function planFromCsv(content: string, fallbackTitle?: string): { plan: ImportPlan; issues: ImportIssue[]; itemCount: number; warnings: string[] } {
  const issues: ImportIssue[] = [];
  const warnings: string[] = [];
  let csv;
  try { csv = parseCsv(content, detectDelimiter(content)); } catch (e) {
    return { plan: empty(), issues: [{ path: "", message: (e as Error).message }], itemCount: 0, warnings };
  }
  if (csv.rows.length === 0) return { plan: empty(), issues: [{ path: "", message: "Die Datei ist leer" }], itemCount: 0, warnings };
  if (csv.rows.length - 1 > LIMITS.rows) return { plan: empty(), issues: [{ path: "", message: `Höchstens ${LIMITS.rows} Zeilen pro Import` }], itemCount: 0, warnings };

  const header = csv.rows[0]!.map(fold);
  const col = (kind: keyof typeof ALIASES) => header.findIndex((h) => ALIASES[kind].includes(h));
  const idx = { template: col("template"), level: col("level"), title: col("title"), description: col("description") };
  if (idx.title < 0) {
    return { plan: empty(), issues: [{ path: "Zeile 1", message: `Spalte „Titel“ fehlt (erlaubt: ${ALIASES.title.slice(0, 4).join(", ")} …). Gefunden: ${csv.rows[0]!.join(", ")}` }], itemCount: 0, warnings };
  }
  if (idx.template < 0 && !fallbackTitle) {
    return { plan: empty(), issues: [{ path: "Zeile 1", message: "Spalte „Vorlage“ fehlt – oder einen Vorlagennamen (`title`) angeben" }], itemCount: 0, warnings };
  }
  const known = new Set(Object.values(idx));
  const ignored = csv.rows[0]!.filter((_, i) => !known.has(i));
  if (ignored.length) warnings.push(`Ignorierte Spalten: ${ignored.join(", ")}`);

  const groups = new Map<string, { items: PItem[]; stack: PItem[] }>();
  let itemCount = 0;
  csv.rows.slice(1).forEach((cells, n) => {
    const line = csv.lines[n + 1]!;
    const where = `Zeile ${line}`;
    const cell = (i: number) => (i >= 0 ? unguardFormula((cells[i] ?? "").trim()) : "");
    const templateTitle = idx.template >= 0 ? cell(idx.template) : fallbackTitle!.trim();
    const title = cell(idx.title);
    const desc = cell(idx.description);
    const levelRaw = cell(idx.level);
    let ok = true;
    const fail = (message: string) => { issues.push({ path: where, message }); ok = false; };

    if (!templateTitle) fail("Vorlage fehlt");
    else if (templateTitle.length > 200) fail("Vorlagenname länger als 200 Zeichen");
    if (!title) fail("Titel fehlt");
    else if (title.length > 200) fail("Titel länger als 200 Zeichen");
    if (desc.length > 5000) fail("Beschreibung länger als 5000 Zeichen");
    let level = 1;
    if (levelRaw !== "") {
      level = Number(levelRaw);
      if (!Number.isInteger(level) || level < 1) fail(`Ebene „${levelRaw}“ ist keine ganze Zahl ≥ 1`);
      else if (level > MAX_DEPTH) fail(`Ebene ${level} ist tiefer als ${MAX_DEPTH}`);
    }
    if (!ok) return;

    const g = groups.get(templateTitle) ?? { items: [], stack: [] };
    groups.set(templateTitle, g);
    if (level > g.stack.length + 1) {
      fail(`Ebene springt von ${g.stack.length} auf ${level} (es fehlt ein übergeordneter Punkt in „${templateTitle}“)`);
      return;
    }
    const item: PItem = { title, description: desc || null, isChecked: false, checkedAt: null, children: [] };
    g.stack.length = level - 1;
    (level === 1 ? g.items : g.stack[level - 2]!.children).push(item);
    g.stack.push(item);
    itemCount += 1;
  });

  if (groups.size === 0 && issues.length === 0) issues.push({ path: "", message: "Keine Datenzeilen gefunden" });
  if (groups.size > LIMITS.templates) issues.push({ path: "", message: `Höchstens ${LIMITS.templates} Vorlagen pro Import` });
  const plan: ImportPlan = { tags: [], runs: [], templates: [...groups].map(([title, g]) => ({ title, description: null, tags: [], items: g.items })) };
  return { plan, issues, itemCount, warnings };
}

// ---------- Vorschau und Anlegen ----------
const sample = (items: PItem[]) => items.slice(0, 5).map((i) => i.title);
const countItems = (items: PItem[]): number => items.reduce((n, i) => n + 1 + countItems(i.children), 0);

export function previewOf(db: Db, userId: string, plan: ImportPlan) {
  const existing = new Map(db.select().from(schema.tags).where(eq(schema.tags.userId, userId)).all().map((t) => [t.name.toLowerCase(), t.name]));
  const wanted = new Map<string, string>();
  for (const t of plan.tags) wanted.set(t.name.toLowerCase(), t.name);
  for (const t of plan.templates) for (const n of t.tags) if (!wanted.has(n.toLowerCase())) wanted.set(n.toLowerCase(), n);
  const names = [...wanted];
  return {
    templates: plan.templates.map((t) => ({ title: t.title, itemCount: countItems(t.items), tags: t.tags, sample: sample(t.items) })),
    runs: plan.runs.map((r) => {
      const all = r.sections.flatMap((s) => s.items);
      const done = (items: PItem[]): number => items.reduce((n, i) => n + (i.isChecked ? 1 : 0) + done(i.children), 0);
      return { title: r.title, status: r.status, sections: r.sections.map((s) => s.title), progress: { done: done(all), total: countItems(all) } };
    }),
    tags: { new: names.filter(([k]) => !existing.has(k)).map(([, n]) => n), existing: names.filter(([k]) => existing.has(k)).map(([k]) => existing.get(k)!) },
  };
}

export interface ImportResult { templates: number; runs: number; items: number; tagsCreated: number; tagsReused: number }

/** Legt alles in einer Transaktion neu an (nie vorhandene Datensätze überschreiben). */
export function applyImport(db: Db, userId: string, plan: ImportPlan): ImportResult {
  return db.transaction((tx) => {
    const tagIds = new Map<string, string>(); // kleingeschriebener Name → ID
    for (const t of tx.select().from(schema.tags).where(eq(schema.tags.userId, userId)).all()) tagIds.set(t.name.toLowerCase(), t.id);
    const existedBefore = new Set(tagIds.keys());
    const requested = new Map(plan.tags.map((t) => [t.name.toLowerCase(), t]));
    const allColors = () => tx.select({ c: schema.tags.color }).from(schema.tags).where(eq(schema.tags.userId, userId)).all().map((r) => r.c);
    /** Vorhandenen Tag (Name ohne Beachtung der Groß-/Kleinschreibung) wiederverwenden, sonst neu anlegen (Farbe automatisch, wenn nicht angegeben). */
    const ensureTag = (name: string) => {
      const key = name.toLowerCase();
      const known = tagIds.get(key);
      if (known) return known;
      const color = (requested.get(key)?.color ?? pickDistinctColor(allColors())).toLowerCase();
      const [row] = tx.insert(schema.tags).values({ userId, name, color }).returning().all();
      tagIds.set(key, row!.id);
      return row!.id;
    };
    for (const t of plan.tags) ensureTag(t.name);

    let items = 0;
    const insertItems = (list: PItem[], parent: string | null, ctx: { templateId?: string; sectionId?: string }, isRun: boolean) => {
      list.forEach((it, position) => {
        items += 1;
        const id = crypto.randomUUID();
        if (isRun) {
          tx.insert(schema.runItems).values({ id, sectionId: ctx.sectionId!, parentItemId: parent, title: it.title, description: it.description, position, isChecked: it.isChecked, checkedAt: it.checkedAt }).run();
        } else {
          tx.insert(schema.templateItems).values({ id, templateId: ctx.templateId!, parentItemId: parent, title: it.title, description: it.description, position }).run();
        }
        insertItems(it.children, id, ctx, isRun);
      });
    };

    for (const t of plan.templates) {
      const [row] = tx.insert(schema.templates).values({ ownerId: userId, title: t.title, description: t.description }).returning().all();
      insertItems(t.items, null, { templateId: row!.id }, false);
      for (const key of new Set(t.tags.map((n) => n.toLowerCase()))) {
        const tagId = ensureTag(t.tags.find((n) => n.toLowerCase() === key)!);
        tx.insert(schema.templateTags).values({ templateId: row!.id, tagId }).run();
      }
    }
    for (const r of plan.runs) {
      const archived = r.status === "archived";
      const now = Date.now();
      const [run] = tx.insert(schema.runs).values({ ownerId: userId, title: r.title, status: r.status, archivedAt: archived ? now : null }).returning().all();
      r.sections.forEach((s, position) => {
        const [section] = tx.insert(schema.runSections).values({ runId: run!.id, title: s.title, position }).returning().all();
        insertItems(s.items, null, { sectionId: section!.id }, true);
      });
    }
    const referenced = new Set([...plan.tags.map((t) => t.name.toLowerCase()), ...plan.templates.flatMap((t) => t.tags.map((n) => n.toLowerCase()))]);
    const tagsCreated = [...referenced].filter((k) => !existedBefore.has(k)).length;
    return { templates: plan.templates.length, runs: plan.runs.length, items, tagsCreated, tagsReused: referenced.size - tagsCreated };
  });
}
