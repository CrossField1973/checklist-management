import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { INTERNAL_CALL_HEADER } from "./plugins/auth.js";

/**
 * MCP-Server (Model Context Protocol, Streamable HTTP) unter `/mcp` (F-63 bis F-66).
 *
 * - Anmeldung ausschließlich per API-Token (`Authorization: Bearer ck_…`), nie per Cookie.
 * - Zustandslos: pro Anfrage ein eigener Server; die angebotenen Werkzeuge richten sich nach dem Token-Recht
 *   (Lese-Token sehen nur lesende Werkzeuge).
 * - Jedes Werkzeug ruft intern die REST-API des Nutzers auf. So gelten garantiert dieselben Regeln wie in der
 *   Oberfläche (Validierung, Mandantentrennung, archivierte Durchführungen schreibgeschützt, Tiefe, Zyklen).
 * - Bewusst nicht enthalten: Löschen, Abschließen/Archivieren, Teilen, Konto- und Token-Verwaltung, Import/Export.
 */

const id = (what: string) => z.string().uuid().describe(`ID (UUID) ${what}`);
const title = z.string().trim().min(1).max(200);
const description = z.string().max(5000).nullable();
const position = z.number().int().min(0).describe("Index unter den Geschwistern (0 = ganz oben, sehr große Zahl = ans Ende)");

type Json = Record<string, unknown>;
interface Call { method: "GET" | "POST" | "PUT"; url: string; query?: Json; body?: Json }
interface Tool {
  name: string;
  title: string;
  description: string;
  write: boolean;
  shape: z.ZodRawShape;
  build: (args: any) => Call;
}

/** Entfernt nicht gesetzte (undefined) Felder, damit PUT/POST nur Übergebenes ändern. */
const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const TOOLS: Tool[] = [
  // ---------- Lesen (F-64) ----------
  {
    name: "list_templates", title: "Vorlagen auflisten", write: false,
    description: "Listet die eigenen Vorlagen (Titel, Tags, Anzahl Punkte). Mit `search` nach Titel suchen, mit `tagId` nach Tag filtern.",
    shape: {
      search: z.string().max(200).optional().describe("Teil des Titels"),
      tagId: id("eines Tags").optional(),
      sort: z.enum(["updated", "title"]).optional().describe("Standard: zuletzt geändert zuerst"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    build: (a) => ({ method: "GET", url: "/api/v1/templates", query: a }),
  },
  {
    name: "get_template", title: "Vorlage lesen", write: false,
    description: "Liefert eine Vorlage mit ihrem vollständigen, verschachtelten Punktebaum (IDs der Punkte für spätere Änderungen).",
    shape: { templateId: id("der Vorlage") },
    build: (a) => ({ method: "GET", url: `/api/v1/templates/${a.templateId}` }),
  },
  {
    name: "list_runs", title: "Durchführungen auflisten", write: false,
    description: "Listet Durchführungen mit Fortschritt, Abschnittstiteln und Kennzeichnung, ob sie geteilt sind. Standard: aktive; mit `status: archived` die archivierten.",
    shape: {
      status: z.enum(["active", "archived"]).optional(),
      search: z.string().max(200).optional().describe("Teil des Titels"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    build: (a) => ({ method: "GET", url: "/api/v1/runs", query: a }),
  },
  {
    name: "get_run", title: "Durchführung lesen", write: false,
    description: "Liefert eine Durchführung mit Abschnitten, verschachteltem Punktebaum (inkl. Abhak-Status), Fortschritt und IDs.",
    shape: { runId: id("der Durchführung") },
    build: (a) => ({ method: "GET", url: `/api/v1/runs/${a.runId}` }),
  },
  {
    name: "list_tags", title: "Tags auflisten", write: false,
    description: "Listet alle eigenen Tags (Name, Farbe, Anzahl verwendeter Vorlagen). Tags gibt es nur für Vorlagen.",
    shape: {},
    build: () => ({ method: "GET", url: "/api/v1/tags" }),
  },

  // ---------- Erstellen und Bearbeiten (F-65) ----------
  {
    name: "create_template", title: "Vorlage anlegen", write: true,
    description: "Legt eine neue, leere Vorlage an. Punkte danach mit `add_template_item` ergänzen.",
    shape: { title, description: description.optional(), tagIds: z.array(id("eines Tags")).max(50).optional() },
    build: (a) => ({ method: "POST", url: "/api/v1/templates", body: clean(a) }),
  },
  {
    name: "update_template", title: "Vorlage ändern", write: true,
    description: "Ändert Titel, Beschreibung und/oder Tags einer Vorlage. Nur übergebene Felder werden geändert; `tagIds` ersetzt die komplette Tag-Liste.",
    shape: { templateId: id("der Vorlage"), title: title.optional(), description: description.optional(), tagIds: z.array(id("eines Tags")).max(50).optional() },
    build: ({ templateId, ...rest }) => ({ method: "PUT", url: `/api/v1/templates/${templateId}`, body: clean(rest) }),
  },
  {
    name: "add_template_item", title: "Punkt zu Vorlage hinzufügen", write: true,
    description: "Fügt einen Punkt zu einer Vorlage hinzu. Mit `parentItemId` entsteht ein Unterpunkt (beliebig tief). Ohne `position` wird am Ende eingefügt.",
    shape: { templateId: id("der Vorlage"), title, description: description.optional(), parentItemId: id("des Elternpunkts").nullable().optional(), position: position.optional() },
    build: ({ templateId, ...rest }) => ({ method: "POST", url: `/api/v1/templates/${templateId}/items`, body: clean(rest) }),
  },
  {
    name: "update_template_item", title: "Punkt einer Vorlage ändern", write: true,
    description: "Ändert Titel und/oder Beschreibung eines Vorlagenpunkts.",
    shape: { itemId: id("des Vorlagenpunkts"), title: title.optional(), description: description.optional() },
    build: ({ itemId, ...rest }) => ({ method: "PUT", url: `/api/v1/template-items/${itemId}`, body: clean(rest) }),
  },
  {
    name: "move_template_item", title: "Punkt einer Vorlage verschieben", write: true,
    description: "Verschiebt einen Vorlagenpunkt samt Unterpunkten: neuer Elternpunkt (`null` = oberste Ebene) und Position. Kein Verschieben in die eigenen Unterpunkte.",
    shape: { itemId: id("des Vorlagenpunkts"), parentItemId: id("des neuen Elternpunkts").nullable(), position },
    build: ({ itemId, ...rest }) => ({ method: "POST", url: `/api/v1/template-items/${itemId}/move`, body: rest }),
  },
  {
    name: "create_run", title: "Durchführung anlegen", write: true,
    description: "Startet eine Durchführung. Jede Vorlage in `templateIds` wird als eigener Abschnitt kopiert (in der angegebenen Reihenfolge; dieselbe Vorlage darf mehrfach vorkommen). Ohne `templateIds` entsteht eine leere Durchführung.",
    shape: { title, templateIds: z.array(id("einer Vorlage")).max(100).optional() },
    build: (a) => ({ method: "POST", url: "/api/v1/runs", body: clean(a) }),
  },
  {
    name: "add_templates_to_run", title: "Vorlagen zu Durchführung hinzufügen", write: true,
    description: "Hängt weitere Vorlagen als neue Abschnitte an eine aktive Durchführung an (Kopie, spätere Änderungen an der Vorlage wirken nicht zurück).",
    shape: { runId: id("der Durchführung"), templateIds: z.array(id("einer Vorlage")).min(1).max(100) },
    build: ({ runId, templateIds }) => ({ method: "POST", url: `/api/v1/runs/${runId}/sections`, body: { templateIds } }),
  },
  {
    name: "add_run_section", title: "Eigenen Abschnitt anlegen", write: true,
    description: "Legt in einer aktiven Durchführung einen eigenen, leeren Abschnitt an (für selbst geschriebene Punkte, die in keiner Vorlage stehen).",
    shape: { runId: id("der Durchführung"), title },
    build: ({ runId, title: t }) => ({ method: "POST", url: `/api/v1/runs/${runId}/sections`, body: { title: t } }),
  },
  {
    name: "add_run_item", title: "Punkt zu Durchführung hinzufügen", write: true,
    description: "Fügt einen eigenen Punkt in einen Abschnitt einer aktiven Durchführung ein (nur in dieser Durchführung; die Vorlage bleibt unverändert). Mit `parentItemId` entsteht ein Unterpunkt im selben Abschnitt.",
    shape: { sectionId: id("des Abschnitts"), title, description: description.optional(), parentItemId: id("des Elternpunkts").nullable().optional(), position: position.optional() },
    build: ({ sectionId, ...rest }) => ({ method: "POST", url: `/api/v1/run-sections/${sectionId}/items`, body: clean(rest) }),
  },
  {
    name: "update_run_item", title: "Punkt abhaken oder ändern", write: true,
    description: "Hakt einen Durchführungspunkt ab (`isChecked: true`) oder nimmt das zurück (`false`) und/oder ändert Titel/Beschreibung. Nur bei aktiven Durchführungen.",
    shape: { itemId: id("des Durchführungspunkts"), isChecked: z.boolean().optional(), title: title.optional(), description: description.optional() },
    build: ({ itemId, ...rest }) => ({ method: "PUT", url: `/api/v1/run-items/${itemId}`, body: clean(rest) }),
  },
  {
    name: "move_run_item", title: "Durchführungspunkt verschieben", write: true,
    description: "Verschiebt einen Durchführungspunkt samt Unterpunkten, auch in einen anderen Abschnitt derselben Durchführung (`sectionId`). `parentItemId: null` = oberste Ebene.",
    shape: { itemId: id("des Durchführungspunkts"), sectionId: id("des Zielabschnitts").optional(), parentItemId: id("des neuen Elternpunkts").nullable(), position },
    build: ({ itemId, ...rest }) => ({ method: "POST", url: `/api/v1/run-items/${itemId}/move`, body: clean(rest) }),
  },
  {
    name: "create_tag", title: "Tag anlegen", write: true,
    description: "Legt einen Tag für Vorlagen an. Ohne `color` wird automatisch eine von den vorhandenen Tags gut unterscheidbare Farbe gewählt. Zuordnung danach mit `update_template` (`tagIds`).",
    shape: { name: z.string().trim().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("#RRGGBB") },
    build: (a) => ({ method: "POST", url: "/api/v1/tags", body: clean(a) }),
  },
];

export const mcpToolNames = (write: boolean) => TOOLS.filter((t) => write || !t.write).map((t) => t.name);

const HINTS: Record<string, string> = {
  not_found: "Nicht gefunden – die ID existiert nicht oder gehört nicht zu diesem Konto.",
  run_not_active: "Die Durchführung ist archiviert und damit schreibgeschützt.",
  cycle: "Ein Punkt kann nicht in sich selbst oder in einen seiner Unterpunkte verschoben werden.",
  too_deep: "Maximale Verschachtelungstiefe (50) überschritten.",
  unknown_template: "Mindestens eine Vorlage existiert nicht (oder ist im Papierkorb).",
  unknown_tag: "Mindestens ein Tag existiert nicht.",
  parent_not_found: "Elternpunkt nicht gefunden (er muss in derselben Vorlage bzw. im selben Abschnitt liegen).",
  section_not_found: "Abschnitt nicht gefunden.",
  tag_name_taken: "Ein Tag mit diesem Namen existiert bereits.",
};

function errorText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: string; details?: { path: string; message: string }[] };
  const code = b.error ?? "unknown_error";
  const detail = b.details?.length ? " " + b.details.map((d) => `${d.path}: ${d.message}`).join("; ") : "";
  return `Fehler ${status} (${code}).${HINTS[code] ? " " + HINTS[code] : ""}${detail}`;
}

export async function mcpRoutes(app: FastifyInstance, { config }: { config: Pick<Config, "APP_BASE_URL"> }) {
  const allowedOrigin = new URL(config.APP_BASE_URL).origin;

  function buildServer(req: { user: { id: string }; tokenId: string | null; tokenPermission: "read" | "write" | null; headers: Record<string, unknown>; log: FastifyInstance["log"] }) {
    const canWrite = req.tokenPermission === "write";
    const authorization = String(req.headers.authorization ?? "");
    const server = new McpServer(
      { name: "checklisten-management", version: "1.0.0" },
      {
        instructions: [
          "Verwaltet Checklisten: Vorlagen (wiederverwendbare Punktelisten mit Unterpunkten und Tags) und Durchführungen (aus einer oder mehreren Vorlagen kopierte Abschnitte, deren Punkte abgehakt werden).",
          "Für Änderungen zuerst mit get_template/get_run lesen, um die IDs der Punkte und Abschnitte zu erhalten.",
          canWrite ? "Löschen, Archivieren und Teilen sind über MCP nicht möglich." : "Dieser Token hat nur Leserechte: Es stehen ausschließlich lesende Werkzeuge zur Verfügung.",
        ].join("\n"),
      },
    );

    for (const tool of TOOLS) {
      if (tool.write && !canWrite) continue; // Lese-Token sehen schreibende Werkzeuge gar nicht (F-66)
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.shape,
          annotations: { readOnlyHint: !tool.write, destructiveHint: false, openWorldHint: false },
        },
        async (args: Json) => {
          const call = tool.build(args);
          let url = call.url;
          if (call.query) {
            const qs = new URLSearchParams(Object.entries(clean(call.query)).map(([k, v]) => [k, String(v)]));
            if ([...qs].length) url += `?${qs}`;
          }
          const res = await app.inject({
            method: call.method, url, payload: call.body,
            headers: { authorization, [INTERNAL_CALL_HEADER]: app.internalCallSecret },
          });
          const ok = res.statusCode < 400;
          // Nur Werkzeugname und Ergebnis ins Log – keine Inhalte (F-37, F-66).
          req.log.info({ event: "mcp_tool_call", userId: req.user.id, tokenId: req.tokenId, tool: tool.name, ok, status: res.statusCode }, "MCP-Werkzeug aufgerufen");
          let parsed: unknown;
          try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
          if (!ok) return { isError: true, content: [{ type: "text" as const, text: errorText(res.statusCode, parsed) }] };
          return { content: [{ type: "text" as const, text: parsed === null ? "OK" : JSON.stringify(parsed, null, 2) }] };
        },
      );
    }
    return server;
  }

  app.route({
    method: ["POST", "GET", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      // Nur mit API-Token (kein Cookie): schützt vor Anfragen aus fremden Webseiten.
      if (!req.user || req.authMethod !== "token") {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized", message: "API-Token erforderlich: Authorization: Bearer ck_…" });
      }
      // Schutz vor DNS-Rebinding (MCP-Empfehlung): Browser-Anfragen mit fremdem Origin werden abgelehnt.
      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) return reply.code(403).send({ error: "forbidden_origin" });
      // Zustandslos: kein Server-Push-Stream und keine Sitzungen.
      if (req.method !== "POST") return reply.code(405).header("Allow", "POST").send({ error: "method_not_allowed" });

      const server = buildServer({ user: req.user, tokenId: req.tokenId, tokenPermission: req.tokenPermission, headers: req.headers, log: req.log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err, event: "mcp_error" }, "MCP-Anfrage fehlgeschlagen");
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
          reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Interner Fehler" }, id: null }));
        }
      }
    },
  });
}
