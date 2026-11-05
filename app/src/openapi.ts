import { z } from "zod";
import type { Config } from "./config.js";
import * as auth from "./routes/auth.js";
import * as ie from "./routes/import-export.js";
import * as me from "./routes/me.js";
import * as runs from "./routes/runs.js";
import * as shares from "./routes/shares.js";
import * as tags from "./routes/tags.js";
import * as sso from "./routes/sso.js";
import * as templates from "./routes/templates.js";
import * as tokens from "./routes/tokens.js";
import * as twoFactor from "./routes/two-factor.js";

/**
 * OpenAPI-3.0-Beschreibung der REST-API (F-60). Request-Schemas stammen direkt aus den zod-Schemas der Routen,
 * damit Doku und Validierung nicht auseinanderlaufen. Ein Test stellt sicher, dass jede registrierte Route
 * hier beschrieben ist und umgekehrt.
 */

/** none = öffentlich · any = Sitzung oder API-Token · session = nur Browser-Sitzung (API-Token verboten) · token = nur API-Token */
type Auth = "none" | "any" | "session" | "token";
interface Op {
  method: "get" | "post" | "put" | "delete";
  path: string;
  tag: string;
  summary: string;
  auth: Auth;
  status?: number;
  body?: z.ZodType;
  query?: z.ZodObject;
  /** zusätzliche Fehlerantworten: Statuscode → Beschreibung */
  errors?: Record<number, string>;
  description?: string;
}

const op = (method: Op["method"], path: string, tag: string, auth: Auth, summary: string, extra: Partial<Op> = {}): Op =>
  ({ method, path, tag, auth, summary, ...extra });

const OPERATIONS: Op[] = [
  // ---------- System ----------
  op("get", "/healthz", "System", "none", "Gesundheitsprüfung", { description: "Prüft, ob die Datenbank erreichbar ist." }),
  op("get", "/api/v1/config", "System", "none", "Öffentliche Laufzeit-Konfiguration", { description: "Registrierung aktiv, SMTP/SSO verfügbar, Standardsprache." }),

  // ---------- MCP ----------
  op("post", "/mcp", "MCP", "token", "MCP-Server (Streamable HTTP, JSON-RPC)", {
    description: [
      "Model-Context-Protocol-Endpunkt für KI-Assistenten (zustandslos, JSON-Antworten). Anmeldung nur per API-Token im Header `Authorization: Bearer ck_…`.",
      "Token mit Recht *lesen* sehen nur lesende Werkzeuge, Token mit *lesen+schreiben* zusätzlich Werkzeuge zum Erstellen und Bearbeiten. Löschen, Archivieren, Teilen und Kontoverwaltung sind nicht verfügbar.",
      "Clients senden `Accept: application/json, text/event-stream`. Anleitung: docs/mcp.md.",
    ].join("\n\n"),
    body: z.object({ jsonrpc: z.literal("2.0"), method: z.string(), id: z.union([z.string(), z.number()]).optional(), params: z.record(z.string(), z.unknown()).optional() }),
    errors: { 403: "Fremder `Origin`-Header", 429: "Rate-Limit des Tokens überschritten" },
  }),
  op("get", "/mcp", "MCP", "token", "Nicht unterstützt (405)", { status: 405, description: "Es gibt keinen Server-Push-Stream; nur POST." }),
  op("delete", "/mcp", "MCP", "token", "Nicht unterstützt (405)", { status: 405, description: "Der Server ist zustandslos, es gibt keine Sitzungen zu beenden." }),

  // ---------- Anmeldung ----------
  op("post", "/api/v1/auth/register", "Anmeldung", "none", "Registrieren", { status: 201, body: auth.registerBody, errors: { 403: "Registrierung deaktiviert (`registration_disabled`)", 409: "E-Mail bereits vergeben", 422: "Passwort entspricht nicht der Richtlinie (`password_policy`, mit `problems`)", 429: "Zu viele Anfragen" } }),
  op("post", "/api/v1/auth/login", "Anmeldung", "none", "Anmelden (setzt das Cookie `session`)", { body: auth.loginBody, errors: { 401: "Ungültige Zugangsdaten", 429: "Vorübergehend gesperrt (`Retry-After`)" } }),
  op("post", "/api/v1/auth/logout", "Anmeldung", "none", "Abmelden", { status: 204 }),
  op("post", "/api/v1/auth/forgot", "Anmeldung", "none", "Passwort-Reset anfordern", { status: 202, body: auth.forgotBody, description: "Antwortet immer gleich, auch bei unbekannter E-Mail. Ohne SMTP-Konfiguration `404 smtp_not_configured`.", errors: { 404: "SMTP nicht konfiguriert" } }),
  op("post", "/api/v1/auth/reset", "Anmeldung", "none", "Passwort mit Reset-Token setzen", { body: auth.resetBody, errors: { 400: "Token ungültig oder abgelaufen", 422: "Passwort entspricht nicht der Richtlinie" } }),

  op("get", "/api/v1/auth/oidc/login", "Anmeldung", "none", "SSO: Anmeldung beim Identitätsanbieter starten (OpenID Connect)", {
    status: 302, query: z.object({ link: z.literal("1").optional().describe("1 = bestehendes Konto (angemeldeter Browser) mit dem SSO-Konto verknüpfen") }),
    description: "Leitet zum Identitätsanbieter weiter (Authorization-Code-Flow mit PKCE, state und nonce). Nur wenn `OIDC_*` konfiguriert ist, sonst `404 sso_not_configured`.",
    errors: { 404: "SSO nicht konfiguriert" },
  }),
  op("get", "/api/v1/auth/oidc/callback", "Anmeldung", "none", "SSO: Rückkehr vom Identitätsanbieter", {
    status: 302, query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
    description: "Prüft Antwort, ID-Token, state und nonce, legt Sitzung an und leitet auf `/` weiter; bei Fehlern auf `/login?error=<code>` (`sso_failed`, `sso_denied`, `sso_flow_expired`, `sso_email_missing`, `sso_email_not_verified`, `registration_disabled`, `sso_already_linked`, `sso_unavailable`). Ein vorhandenes Konto wird nur bei vom Anbieter **bestätigter** E-Mail verknüpft; neue Konten nur, wenn die Registrierung aktiv ist.",
    errors: { 404: "SSO nicht konfiguriert" },
  }),

  // ---------- Profil ----------
  op("get", "/api/v1/me", "Profil", "any", "Eigenes Profil lesen"),
  op("put", "/api/v1/me", "Profil", "session", "Profil ändern", { body: me.updateBody, errors: { 403: "Für E-Mail-Änderung ist das aktuelle Passwort nötig", 409: "E-Mail bereits vergeben" } }),
  op("delete", "/api/v1/me", "Profil", "session", "Konto samt allen Daten löschen", { status: 204, body: me.deleteBody, errors: { 403: "Passwort falsch" } }),
  op("post", "/api/v1/me/password", "Profil", "session", "Passwort ändern", { status: 204, body: me.passwordBody, description: "Beendet alle anderen Sitzungen.", errors: { 403: "Aktuelles Passwort falsch", 422: "Neues Passwort entspricht nicht der Richtlinie" } }),

  // ---------- Zwei-Faktor und SSO im Profil ----------
  op("get", "/api/v1/me/2fa", "Sicherheit", "session", "Status der Zwei-Faktor-Authentifizierung"),
  op("post", "/api/v1/me/2fa/setup", "Sicherheit", "session", "2FA einrichten: Geheimnis erzeugen (noch nicht aktiv)", { body: twoFactor.setupBody, description: "Liefert `secret` und `otpauthUrl` (für QR-Code). Mit Passwort, falls das Konto eines hat.", errors: { 403: "Passwort falsch", 409: "Bereits aktiv" } }),
  op("post", "/api/v1/me/2fa/enable", "Sicherheit", "session", "2FA aktivieren (Code aus der Authenticator-App bestätigen)", { body: twoFactor.enableBody, description: "Liefert **einmalig** 10 Wiederherstellungscodes. Beendet alle anderen Sitzungen.", errors: { 409: "Bereits aktiv oder Einrichtung fehlt", 422: "Code ungültig" } }),
  op("post", "/api/v1/me/2fa/disable", "Sicherheit", "session", "2FA deaktivieren", { status: 204, body: twoFactor.confirmBody, description: "Erfordert Passwort (falls vorhanden) und einen gültigen Authenticator- oder Wiederherstellungscode.", errors: { 403: "Passwort oder Code falsch", 409: "Nicht aktiv", 429: "Zu viele Fehlversuche" } }),
  op("post", "/api/v1/me/2fa/recovery-codes", "Sicherheit", "session", "Neue Wiederherstellungscodes erzeugen", { body: twoFactor.confirmBody, description: "Die bisherigen Codes werden ungültig. Die neuen werden **einmalig** angezeigt.", errors: { 403: "Passwort oder Code falsch", 409: "Nicht aktiv", 429: "Zu viele Fehlversuche" } }),
  op("get", "/api/v1/me/sso", "Sicherheit", "session", "SSO-Status des Kontos (verknüpft?)"),
  op("post", "/api/v1/me/sso/unlink", "Sicherheit", "session", "SSO-Verknüpfung lösen", { status: 204, body: sso.unlinkBody, errors: { 403: "Passwort falsch", 404: "Nicht verknüpft oder SSO nicht konfiguriert", 409: "Konto hat kein Passwort (würde aussperren)" } }),

  // ---------- API-Token ----------
  op("get", "/api/v1/me/tokens", "API-Token", "session", "Eigene API-Token auflisten", { description: "Nur Präfix, Rechte, Ablauf und letzte Nutzung – nie der Token selbst." }),
  op("post", "/api/v1/me/tokens", "API-Token", "session", "API-Token anlegen", { status: 201, body: tokens.createBody, description: "Der Klartext-Token (`ck_…`) steht **nur in dieser Antwort**.", errors: { 422: "`invalid_expiry` oder `too_many_tokens`" } }),
  op("delete", "/api/v1/me/tokens/{id}", "API-Token", "session", "API-Token widerrufen", { status: 204 }),

  // ---------- Tags ----------
  op("get", "/api/v1/tags", "Tags", "any", "Tags auflisten (mit Anzahl verwendeter Vorlagen)"),
  op("post", "/api/v1/tags", "Tags", "any", "Tag anlegen", { status: 201, body: tags.createBody, description: "Ohne `color` wird automatisch die am stärksten abweichende Farbe gewählt.", errors: { 409: "Name bereits vergeben" } }),
  op("put", "/api/v1/tags/{id}", "Tags", "any", "Tag umbenennen / Farbe ändern", { body: tags.updateBody, errors: { 409: "Name bereits vergeben" } }),
  op("delete", "/api/v1/tags/{id}", "Tags", "any", "Tag löschen (nur die Zuordnungen)", { status: 204 }),

  // ---------- Vorlagen ----------
  op("get", "/api/v1/templates", "Vorlagen", "any", "Vorlagen auflisten", { query: templates.listQuery }),
  op("post", "/api/v1/templates", "Vorlagen", "any", "Vorlage anlegen", { status: 201, body: templates.templateBody, errors: { 422: "Unbekannter Tag (`unknown_tag`)" } }),
  op("get", "/api/v1/templates/{id}", "Vorlagen", "any", "Vorlage mit Punktebaum lesen"),
  op("put", "/api/v1/templates/{id}", "Vorlagen", "any", "Vorlage ändern", { body: templates.templateUpdate, errors: { 422: "Unbekannter Tag" } }),
  op("delete", "/api/v1/templates/{id}", "Vorlagen", "any", "Vorlage in den Papierkorb", { status: 204 }),
  op("post", "/api/v1/templates/{id}/duplicate", "Vorlagen", "any", "Vorlage duplizieren", { status: 201 }),
  op("post", "/api/v1/templates/{id}/items", "Vorlagen", "any", "Punkt anlegen", { status: 201, body: templates.itemCreate, errors: { 422: "`too_deep` (Tiefe > 50)" } }),
  op("put", "/api/v1/template-items/{id}", "Vorlagen", "any", "Punkt ändern", { body: templates.itemUpdate }),
  op("delete", "/api/v1/template-items/{id}", "Vorlagen", "any", "Punkt samt Unterpunkten löschen", { description: "Liefert den kompletten Punktebaum." }),
  op("post", "/api/v1/template-items/{id}/move", "Vorlagen", "any", "Punkt verschieben (auch zwischen Ebenen)", { body: templates.itemMove, errors: { 422: "`cycle` oder `too_deep`" } }),

  // ---------- Durchführungen ----------
  op("get", "/api/v1/runs", "Durchführungen", "any", "Durchführungen auflisten", { query: runs.listQuery, description: "Enthält Fortschritt und `share` (Kennzeichnung „geteilt“, sonst `null`)." }),
  op("post", "/api/v1/runs", "Durchführungen", "any", "Durchführung aus null, einer oder mehreren Vorlagen anlegen", { status: 201, body: runs.createBody, errors: { 422: "Unbekannte Vorlage (`unknown_template`)" } }),
  op("get", "/api/v1/runs/{id}", "Durchführungen", "any", "Durchführung mit Abschnitten, Punktebaum und Fortschritt lesen"),
  op("put", "/api/v1/runs/{id}", "Durchführungen", "any", "Durchführung umbenennen", { body: runs.updateBody, errors: { 409: "Durchführung nicht aktiv (`run_not_active`)" } }),
  op("delete", "/api/v1/runs/{id}", "Durchführungen", "any", "Durchführung in den Papierkorb", { status: 204 }),
  op("post", "/api/v1/runs/{id}/complete", "Durchführungen", "any", "Abschließen (= in den Papierkorb)", { status: 204 }),
  op("post", "/api/v1/runs/{id}/archive", "Durchführungen", "any", "Archivieren (widerruft Freigabelinks)", { errors: { 409: "Nicht aktiv" } }),
  op("post", "/api/v1/runs/{id}/reopen", "Durchführungen", "any", "Aus dem Archiv wieder öffnen", { errors: { 409: "Nicht archiviert (`run_not_archived`)" } }),
  op("post", "/api/v1/runs/{id}/sections", "Durchführungen", "any", "Vorlagen ergänzen oder eigenen Abschnitt anlegen", { status: 201, body: runs.addSectionsBody, errors: { 409: "Nicht aktiv", 422: "Unbekannte Vorlage" } }),
  op("delete", "/api/v1/run-sections/{id}", "Durchführungen", "any", "Abschnitt entfernen", { errors: { 409: "Nicht aktiv" } }),
  op("post", "/api/v1/run-sections/{id}/move", "Durchführungen", "any", "Abschnitt umsortieren", { body: runs.sectionMoveBody, errors: { 409: "Nicht aktiv" } }),
  op("post", "/api/v1/run-sections/{id}/items", "Durchführungen", "any", "Eigenen Punkt anlegen", { status: 201, body: runs.itemCreate, errors: { 409: "Nicht aktiv", 422: "`too_deep`" } }),
  op("put", "/api/v1/run-items/{id}", "Durchführungen", "any", "Abhaken / Punkt ändern", { body: runs.itemUpdate, errors: { 409: "Nicht aktiv" } }),
  op("delete", "/api/v1/run-items/{id}", "Durchführungen", "any", "Punkt samt Unterpunkten löschen", { errors: { 409: "Nicht aktiv" } }),
  op("post", "/api/v1/run-items/{id}/move", "Durchführungen", "any", "Punkt verschieben (auch in anderen Abschnitt)", { body: runs.itemMove, errors: { 409: "Nicht aktiv", 422: "`cycle`, `too_deep`" } }),

  // ---------- Papierkorb ----------
  op("get", "/api/v1/trash", "Papierkorb", "any", "Papierkorb auflisten (Vorlagen und Durchführungen)"),
  op("post", "/api/v1/trash/{type}/{id}/restore", "Papierkorb", "any", "Wiederherstellen (Durchführung kehrt in früheren Status zurück)", { status: 204 }),
  op("delete", "/api/v1/trash/{type}/{id}", "Papierkorb", "any", "Endgültig löschen", { status: 204 }),
  op("delete", "/api/v1/trash", "Papierkorb", "any", "Papierkorb leeren", { description: "Liefert `{templates, runs}` mit den gelöschten Anzahlen." }),

  // ---------- Import und Export ----------
  op("get", "/api/v1/export", "Import/Export", "any", "Alle eigenen Daten exportieren (JSON-Download)", { description: "Tags, Vorlagen (mit Unterpunkten) und Durchführungen ohne Papierkorb. Format zum Wiedereinlesen mit `POST /import`; enthält keine Geheimnisse, Freigabelinks oder IDs." }),
  op("get", "/api/v1/me/export", "Import/Export", "session", "Vollständiger Konto-Export (DSGVO, JSON-Download)", { description: "Zusätzlich Profil, Papierkorb, Freigabe-Einstellungen und Token-Metadaten – nie Passwörter, Token oder Freigabe-Links." }),
  op("get", "/api/v1/templates/{id}/export", "Import/Export", "any", "Vorlage exportieren (JSON, CSV oder Markdown)", { query: ie.exportQuery, description: "CSV-Spalten: Vorlage, Ebene, Titel, Beschreibung (UTF-8 mit BOM, Zellen mit `=`,`+`,`-`,`@` am Anfang werden mit `'` geschützt)." }),
  op("get", "/api/v1/runs/{id}/export", "Import/Export", "any", "Durchführung exportieren (JSON, CSV oder Markdown)", { query: ie.exportQuery, description: "CSV-Spalten: Abschnitt, Ebene, Titel, Beschreibung, Erledigt, Erledigt am. Markdown mit Kontrollkästchen `- [x]`." }),
  op("post", "/api/v1/import", "Import/Export", "any", "Importieren (JSON oder CSV), optional nur prüfen", {
    status: 201, body: ie.importBody,
    description: [
      "Legt **immer neue** Datensätze an (nichts wird überschrieben oder zusammengeführt); alles oder nichts.",
      "Mit `dryRun: true` wird nur geprüft: Antwort `{valid, issues, warnings, counts, preview}` mit Fehlern je Zeile bzw. Pfad (Status 200).",
      "**JSON:** Export-Format (Round-Trip). **CSV:** Spalten Vorlage, Ebene, Titel, Beschreibung (Trennzeichen `,` `;` oder Tab wird erkannt); Ebene 1 = oberster Punkt, 2 = Unterpunkt …; ohne Spalte Vorlage mit `title`.",
      "Grenzen: 2000 Vorlagen, 2000 Durchführungen, 50 000 Punkte, 12 MB.",
    ].join("\n\n"),
    errors: { 413: "Anfrage zu groß", 422: "Import ungültig (`import_invalid`, `issues` nennt Zeilen/Pfade)" },
  }),

  // ---------- Teilen ----------
  op("get", "/api/v1/runs/{id}/share", "Teilen", "any", "Freigabelink lesen (oder `share: null`)"),
  op("put", "/api/v1/runs/{id}/share", "Teilen", "any", "Link anlegen (201) oder Einstellungen ändern (200)", { body: shares.settingsBody, errors: { 409: "Durchführung nicht aktiv – archivierte sind nicht teilbar", 422: "Passwort erforderlich (`password_required`)" } }),
  op("delete", "/api/v1/runs/{id}/share", "Teilen", "any", "Link widerrufen", { status: 204 }),
  op("post", "/api/v1/runs/{id}/share/regenerate", "Teilen", "any", "Neuen Link erzeugen, alter wird ungültig"),
  op("get", "/api/v1/me/shares", "Teilen", "any", "Alle eigenen aktiven Freigaben (Verwaltung im Profil)"),
  op("delete", "/api/v1/me/shares/{id}", "Teilen", "any", "Eine Freigabe zurückziehen", { status: 204 }),
  op("delete", "/api/v1/me/shares", "Teilen", "any", "Alle Freigaben zurückziehen", { description: "Liefert `{revoked: n}`." }),

  // ---------- Öffentlich über Freigabelink ----------
  op("get", "/api/v1/public/runs/{token}", "Freigabelink (öffentlich)", "none", "Geteilte Durchführung ansehen", { description: "Bei Passwortschutz im Header `X-Share-Password`. Antworten sind `noindex` und `no-store`.", errors: { 401: "`password_required` / `invalid_password`", 404: "Link unbekannt, widerrufen, Durchführung gelöscht oder archiviert", 429: "Zu viele falsche Passwörter" } }),
  op("put", "/api/v1/public/runs/{token}/items/{itemId}", "Freigabelink (öffentlich)", "none", "Abhaken / Punkt ändern (Berechtigung „bearbeiten“)", { body: shares.itemUpdate, errors: { 401: "Passwort fehlt/falsch", 403: "Link erlaubt nur Ansehen (`read_only_link`)", 404: "Unbekannt" } }),
  op("delete", "/api/v1/public/runs/{token}/items/{itemId}", "Freigabelink (öffentlich)", "none", "Punkt löschen (Berechtigung „bearbeiten“)", { errors: { 401: "Passwort fehlt/falsch", 403: "`read_only_link`", 404: "Unbekannt" } }),
  op("post", "/api/v1/public/runs/{token}/sections/{sectionId}/items", "Freigabelink (öffentlich)", "none", "Punkt hinzufügen (Berechtigung „bearbeiten“)", { status: 201, body: shares.itemCreate, errors: { 401: "Passwort fehlt/falsch", 403: "`read_only_link`", 404: "Unbekannt" } }),
  op("post", "/api/v1/public/runs/{token}/items/{itemId}/move", "Freigabelink (öffentlich)", "none", "Punkt verschieben (Berechtigung „bearbeiten“)", { body: shares.itemMove, errors: { 401: "Passwort fehlt/falsch", 403: "`read_only_link`", 404: "Unbekannt" } }),
];

const ERROR_TEXT: Record<number, string> = {
  400: "Eingabe ungültig (`validation_error`, `details` nennt die Felder)",
  401: "Nicht angemeldet bzw. Token ungültig/abgelaufen",
  403: "Nicht erlaubt",
  404: "Nicht gefunden – oder gehört einem anderen Nutzer",
  429: "Zu viele Anfragen (`Retry-After`)",
};

const toJson = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

const pathParams = (path: string) =>
  [...path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const name = m[1]!;
    const schema = name === "type" ? { type: "string", enum: ["template", "run"] }
      : name === "token" ? { type: "string", minLength: 10, maxLength: 100 }
      : { type: "string", format: "uuid" };
    return { name, in: "path", required: true, schema };
  });

const queryParams = (schema: z.ZodObject) => {
  const json = toJson(schema) as { properties?: Record<string, object>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name, in: "query", required: json.required?.includes(name) ?? false, schema: s,
  }));
};

const security = (auth: Auth) =>
  auth === "none" ? [] : auth === "session" ? [{ cookieAuth: [] }] : auth === "token" ? [{ bearerAuth: [] }] : [{ cookieAuth: [] }, { bearerAuth: [] }];

function tokenNote(o: Op): string {
  if (o.auth === "token") return "**Nur mit API-Token** (kein Cookie).";
  if (o.auth === "session") return "**Nur mit Browser-Sitzung** – API-Token sind hier nicht erlaubt (`403 session_required`).";
  if (o.auth === "any") {
    return o.method === "get"
      ? "API-Token: Recht *lesen* genügt."
      : "API-Token: Recht *lesen+schreiben* nötig (sonst `403 token_read_only`).";
  }
  return "";
}

export function buildOpenApi(config: Pick<Config, "APP_BASE_URL">) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of OPERATIONS) {
    const responses: Record<string, unknown> = {
      [String(o.status ?? 200)]: o.status === 405
        ? { description: "Methode nicht erlaubt", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        : o.status === 302
        ? { description: "Weiterleitung (Header `Location`)" }
        : o.status === 204
        ? { description: "Erfolgreich, kein Inhalt" }
        : { description: "Erfolgreich", content: { "application/json": { schema: { type: "object" } } } },
    };
    const codes = new Set<number>();
    if (o.body || o.query) codes.add(400);
    if (o.auth !== "none") codes.add(401);
    if (o.path.includes("{")) codes.add(404);
    if (o.auth === "none" && o.path.includes("/auth/")) codes.add(429);
    for (const code of codes) responses[String(code)] = { description: ERROR_TEXT[code], content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    for (const [code, description] of Object.entries(o.errors ?? {})) {
      responses[code] = { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    }
    const parameters = [...pathParams(o.path), ...(o.query ? queryParams(o.query) : [])];
    const description = [o.description, tokenNote(o)].filter(Boolean).join("\n\n");
    (paths[o.path] ??= {})[o.method] = {
      tags: [o.tag],
      summary: o.summary,
      ...(description && { description }),
      operationId: `${o.method}_${o.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      security: security(o.auth),
      ...(parameters.length && { parameters }),
      ...(o.body && { requestBody: { required: true, content: { "application/json": { schema: toJson(o.body) } } } }),
      responses,
    };
  }

  const tagNames = [...new Set(OPERATIONS.map((o) => o.tag))];
  return {
    openapi: "3.0.3",
    info: {
      title: "Checklisten-Management API",
      version: "1.0.0",
      description: [
        "REST-API der selbst gehosteten Checklisten-App.",
        "",
        "**Authentifizierung:** Browser-Sitzung (Cookie `session`, nach `POST /auth/login`) oder API-Token im Header `Authorization: Bearer ck_…` (Token legt man im Profil an).",
        "Token mit Recht *lesen* dürfen nur GET-Anfragen; Konto-, Passwort- und Token-Verwaltung ist ausschließlich mit Browser-Sitzung möglich.",
        "Pro Token gilt ein Rate-Limit (Standard 120 Anfragen/Minute, `429` mit `Retry-After`).",
        "",
        "**Mandantentrennung:** Jede Anfrage sieht nur Daten des angemeldeten Nutzers; fremde IDs liefern `404`.",
      ].join("\n"),
    },
    servers: [{ url: config.APP_BASE_URL.replace(/\/$/, "") }],
    tags: tagNames.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "session", description: "Browser-Sitzung nach dem Login" },
        bearerAuth: { type: "http", scheme: "bearer", description: "API-Token aus dem Profil (`ck_…`)" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string", description: "Maschinenlesbarer Fehlercode, z. B. `not_found`" } },
          additionalProperties: true,
        },
      },
    },
  };
}

/** Für Tests: alle beschriebenen Operationen als „METHODE pfad“. */
export const documentedOperations = () => OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path}`);
