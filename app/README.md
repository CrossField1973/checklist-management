# Checklisten-Management – Anwendung

Umsetzung des [Pflichtenhefts](../Pflichtenheft.md). Dokumentation: [../docs/](../docs/README.md). Klickbares Design-Mockup: [../mockup.html](../mockup.html).

## Stand

| Schritt (Entwicklungsreihenfolge, Pflichtenheft Abschnitt 7) | Status |
|---|---|
| 1. Projektgerüst, Docker, Konfiguration, Health-Endpoint, JSON-Logging | fertig |
| 2. Datenbankschema und Migrationen | fertig |
| 3. Konto: Registrierung (abschaltbar), Login/Logout, Profil, Passwort ändern/vergessen/zurücksetzen, Konto löschen, CLI `create-user` | fertig (nur API, Oberfläche folgt) |
| 4. Vorlagen mit Unterpunkten, Verschieben (Drag-and-Drop-API), Tags mit automatischer Farbe, Suche/Filter, Duplizieren, Löschen (Soft-Delete) | fertig (nur API) |
| 5. Checklisten: aus mehreren Vorlagen anlegen, Vorlagen ergänzen, Abhaken mit Fortschritt, eigene Punkte, Abschnitte, Umbenennen, Löschen (Soft-Delete) | fertig (nur API) |
| 6. Abschließen (= Papierkorb), Archivieren, Wieder öffnen, Papierkorb (Liste, Wiederherstellen, endgültig löschen, leeren), automatisches Leeren nach Frist | fertig (nur API) |
| 7. Freigabelinks: anlegen/ändern/neu erzeugen/widerrufen, Passwortschutz, ansehen/bearbeiten, öffentliche Ansicht ohne Konto, Geteilt-Kennzeichnung, Verwaltung im Profil | fertig (nur API) |
| 8. API-Token-Verwaltung (lesen / lesen+schreiben, Ablauf, Rate-Limit), OpenAPI unter `/api/docs` | fertig |
| 9. MCP-Server unter `/mcp` (17 Werkzeuge: lesen, erstellen, bearbeiten; kein Löschen/Archivieren/Teilen) | fertig |
| 10. Import/Export: JSON/CSV/Markdown, Vorschau, Fehlerzeilen, Konto-Export (DSGVO) | fertig |
| 11. Zwei-Faktor (TOTP, Wiederherstellungscodes) und SSO (OpenID Connect, PKCE) | fertig |
| 12a. Oberfläche: Gerüst, Anmelden (inkl. 2FA/SSO), Registrieren, Passwort vergessen/zurücksetzen, Profil (Konto, Passwort, 2FA, SSO, Token, Freigaben, Daten, Konto löschen), Deutsch/Englisch, hell/dunkel, Auslieferung durch den Server | fertig |
| 12b. Oberfläche: Vorlagen (Liste mit Suche/Tag-Filter/Sortierung/Seiten, Editor mit Unterpunkten, Drag-and-Drop per Maus/Touch/Tastatur plus Schaltflächen, Duplizieren, Löschen, Export) und Tags (automatische Farbe) | fertig |
| 12c. Oberfläche: Checklisten (Liste, Anlegen aus mehreren Vorlagen, Abhaken, Ergänzen), Beenden (Abschließen/Archivieren), Archiv, Papierkorb, Teilen und öffentliche Ansicht `/s/<token>` | fertig |
| 13. Barrierefreiheit: automatische Prüfung (axe-core) und Kontrastprüfung hell/dunkel; i18n-Vollständigkeit | fertig |
| 14. Sicherheits-/Mandantentests über alle Routen, Playwright-Hauptabläufe (auch gegen Docker), Abschlussdoku | fertig |
| 15. Offline/PWA: installierbar, Oberfläche und Daten offline, Abhaken/Hinzufügen mit Änderungswarteschlange und Synchronisierung | fertig |

Der Docker-Build und -Betrieb wurde getestet (Image baut, Container wird `healthy`, `create-user` im Container, Daten bleiben nach `down`/`up` im Volume erhalten).

## Oberfläche

Die Weboberfläche (`web/`, React + Vite) wird vom Server mit ausgeliefert: nach `docker compose up -d --build` unter <http://localhost:3000>. Entwicklung und Tests: [docs/entwicklung.md](../docs/entwicklung.md#oberfläche-appweb). Bedienung: [docs/benutzerhandbuch.md](../docs/benutzerhandbuch.md).

```bash
npm run build:all    # Oberfläche + Server bauen
npm run test:all     # Backend- und Oberflächen-Tests
```

## Entwicklung (Node.js ≥ 24)

```bash
npm install
cp .env.example .env   # SESSION_SECRET setzen
npm test               # Tests
npm run typecheck
npm run dev            # Start mit Neuladen (liest Umgebungsvariablen, z. B. via .env-Loader der Shell)
```

Beispiel für den lokalen Start ohne Docker (PowerShell):

```powershell
$env:APP_BASE_URL="http://localhost:3000"; $env:SESSION_SECRET=("x"*32); $env:DATABASE_PATH="./data/app.db"; npm run dev
```

## Betrieb mit Docker

```bash
cp .env.example .env   # SESSION_SECRET und APP_BASE_URL setzen
docker compose up -d --build
docker compose logs -f app   # JSON-Logs (F-37)
```

Daten liegen im Volume `app-data` (`/data/app.db`). Backup = Kopie dieses Volumes. Migrationen laufen beim Start automatisch.

## Konto-API (Schritt 3)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/v1/auth/register` | Registrierung (403 bei `REGISTRATION_ENABLED=false`) |
| POST | `/api/v1/auth/login`, `/logout` | Anmelden/Abmelden (Cookie `session`, HttpOnly, SameSite=Lax) |
| POST | `/api/v1/auth/forgot`, `/reset` | Passwort vergessen (404 ohne SMTP), Zurücksetzen mit einmaligem Token |
| GET/PUT/DELETE | `/api/v1/me` | Profil lesen/ändern, Konto löschen |
| POST | `/api/v1/me/password` | Passwort ändern (beendet andere Sitzungen) |

Fehler: `400 validation_error`, `401 unauthorized`, `403`, `409 email_taken`, `422 password_policy` (mit `problems`), `429 too_many_attempts`.

Hinweis: Die Sperre nach Fehlversuchen (F-04) liegt im Arbeitsspeicher und wird bei einem Neustart zurückgesetzt; das IP-Rate-Limit gilt zusätzlich.

## Vorlagen-API (Schritt 4)

Alle Routen verlangen Anmeldung; fremde IDs liefern `404` (Mandantentrennung).

| Methode | Pfad | Zweck |
|---|---|---|
| GET/POST | `/api/v1/tags` | Liste (mit `templateCount`) / anlegen (ohne `color` wird die unterscheidbarste Farbe gewählt, F-18) |
| PUT/DELETE | `/api/v1/tags/:id` | Umbenennen/Farbe ändern / löschen (nur Zuordnungen) |
| GET | `/api/v1/templates?search=&tagId=&sort=updated\|title&limit=&offset=` | Liste mit Suche, Tag-Filter, Paginierung |
| POST | `/api/v1/templates` | Anlegen `{title, description?, tagIds?}` |
| GET/PUT/DELETE | `/api/v1/templates/:id` | Lesen (inkl. Punktebaum) / ändern / in den Papierkorb |
| POST | `/api/v1/templates/:id/duplicate` | Duplizieren |
| POST | `/api/v1/templates/:id/items` | Punkt anlegen `{title, description?, parentItemId?, position?}` |
| PUT/DELETE | `/api/v1/template-items/:id` | Punkt ändern / löschen (mit Unterpunkten) |
| POST | `/api/v1/template-items/:id/move` | Verschieben `{parentItemId \| null, position}` (Zyklen → `422 cycle`, Tiefe > 50 → `422 too_deep`) |

Punkt-Routen liefern den vollständigen, verschachtelten Baum (`items`) zurück, damit eine Oberfläche ihn direkt ersetzen kann.

## Checklistes-API (Schritt 5)

Alle Routen verlangen Anmeldung; fremde IDs liefern `404`. Änderungen an nicht aktiven (archivierten) Checklisten liefern `409 run_not_active`. Mutierende Routen geben die komplette Checkliste (`run` mit `sections`, Punktebaum und `progress`) zurück.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/v1/runs?status=active\|archived&search=&limit=&offset=` | Liste mit Fortschritt und Abschnittstiteln |
| POST | `/api/v1/runs` | Anlegen `{title, templateIds?: []}` – je Vorlage ein Abschnitt (Momentaufnahme), Reihenfolge = Reihenfolge der IDs, Duplikate erlaubt |
| GET/PUT/DELETE | `/api/v1/runs/:id` | Lesen / umbenennen / in den Papierkorb |
| POST | `/api/v1/runs/:id/sections` | Vorlagen ergänzen `{templateIds}` oder eigenen leeren Abschnitt `{title}` |
| DELETE | `/api/v1/run-sections/:id` | Abschnitt entfernen |
| POST | `/api/v1/run-sections/:id/move` | Abschnitt umsortieren `{position}` |
| POST | `/api/v1/run-sections/:id/items` | Eigenen Punkt anlegen `{title, description?, parentItemId?, position?}` |
| PUT | `/api/v1/run-items/:id` | Abhaken `{isChecked}` (mit `checkedAt`), Titel/Beschreibung ändern |
| DELETE | `/api/v1/run-items/:id` | Punkt samt Unterpunkten löschen |
| POST | `/api/v1/run-items/:id/move` | Verschieben `{sectionId?, parentItemId \| null, position}` (auch zwischen Abschnitten) |

Noch nicht enthalten: Teilen-Kennzeichnung in der Liste (Schritt 7).

## Abschließen, Archiv, Papierkorb (Schritt 6)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/v1/runs/:id/complete` | **Abschließen** = in den Papierkorb (`204`); auch aus dem Archiv |
| POST | `/api/v1/runs/:id/archive` | Archivieren (`409 run_not_active`, wenn nicht aktiv); widerruft Freigabelinks |
| POST | `/api/v1/runs/:id/reopen` | Archiv → aktiv (`409 run_not_archived`) |
| GET | `/api/v1/trash` | Vorlagen und Checklisten im Papierkorb inkl. `purgeAt` (oder `null` bei „nie“) |
| POST | `/api/v1/trash/:type/:id/restore` | Wiederherstellen, `type` = `template`\|`run` (Checkliste kehrt in früheren Status zurück) |
| DELETE | `/api/v1/trash/:type/:id` | Endgültig löschen (Cascade) |
| DELETE | `/api/v1/trash` | Papierkorb leeren → `{templates, runs}` |

`DELETE /api/v1/runs/:id` und `DELETE /api/v1/templates/:id` verschieben ebenfalls in den Papierkorb. Das Archiv wird nie automatisch geleert.

**Hintergrundjob** (`src/jobs.ts`): beim Start und danach stündlich werden Papierkorb-Einträge gelöscht, die älter als die Aufbewahrungsdauer des jeweiligen Nutzers sind (Profil, Standard `TRASH_RETENTION_DAYS`), sowie abgelaufene/verbrauchte Reset-Token. Jeder Lauf mit Löschungen erzeugt eine Logzeile `event: "maintenance"`.

## Zwei-Faktor und SSO (Schritt 11)

Einrichtung und Abläufe: [docs/anmeldung.md](../docs/anmeldung.md).

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/v1/auth/login` | wie bisher, mit optionalem `code` (Pflicht bei aktiver 2FA, sonst `401 two_factor_required`) |
| GET | `/api/v1/me/2fa` | Status |
| POST | `/api/v1/me/2fa/setup`, `/enable`, `/disable`, `/recovery-codes` | Einrichten, Aktivieren (liefert 10 Codes), Deaktivieren, Codes erneuern – nur Browser-Sitzung |
| GET | `/api/v1/auth/oidc/login`, `/api/v1/auth/oidc/callback` | SSO-Ablauf (`?link=1` zum Verknüpfen) |
| GET, POST | `/api/v1/me/sso`, `/api/v1/me/sso/unlink` | SSO-Status, Verknüpfung lösen |

SSO einschalten: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (optional `OIDC_NAME`, `OIDC_SCOPES`); Redirect-URI beim Anbieter: `<APP_BASE_URL>/api/v1/auth/oidc/callback`.

## Import und Export (Schritt 10)

Formate, Regeln und Mendix-Migration: [docs/import-export.md](../docs/import-export.md).

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/v1/export` | Alle eigenen Daten (JSON-Download) |
| GET | `/api/v1/templates/:id/export`, `/api/v1/runs/:id/export` | `?format=json\|csv\|md&delimiter=comma\|semicolon\|tab` |
| GET | `/api/v1/me/export` | Vollständiger Konto-Export (DSGVO), nur Browser-Sitzung |
| POST | `/api/v1/import` | `{format: json\|csv, content, title?, dryRun?}` – Vorschau oder Import (immer neue Datensätze, alles oder nichts) |

## MCP-Server (Schritt 9)

Einrichtung, Werkzeuge und Sicherheit: [docs/mcp.md](../docs/mcp.md). Endpunkt `POST /mcp` (nur API-Token, zustandslos); Lese-Token sehen nur die 5 lesenden Werkzeuge. `GET /api/v1/config` nennt die `mcpUrl`.

## API-Token und OpenAPI (Schritt 8)

Beschreibung: [docs/api.md](../docs/api.md#api-token). Interaktive Doku: `/api/docs`, Datei: `/api/openapi.json`.

| Methode | Pfad | Zweck |
|---|---|---|
| GET/POST | `/api/v1/me/tokens` | Token auflisten / anlegen (Klartext nur in der Antwort) – nur Browser-Sitzung |
| DELETE | `/api/v1/me/tokens/:id` | Token widerrufen – nur Browser-Sitzung |

Verwendung: `Authorization: Bearer ck_…`. Lese-Token → nur GET (`403 token_read_only`); Konto/Passwort/Token-Verwaltung nur mit Sitzung (`403 session_required`); Rate-Limit `API_RATE_LIMIT_PER_MINUTE` (Standard 120).

## Freigabelinks (Schritt 7)

Beschreibung, Beispiele und Regeln: [docs/api.md](../docs/api.md#teilen-mit-dritten).

| Methode | Pfad | Zweck |
|---|---|---|
| GET/PUT/DELETE | `/api/v1/runs/:id/share` | Link lesen / anlegen oder Einstellungen ändern / widerrufen |
| POST | `/api/v1/runs/:id/share/regenerate` | Neuer Link, alter ungültig |
| GET/DELETE | `/api/v1/me/shares`, `/api/v1/me/shares/:id` | Verwaltung im Profil, einzeln oder alle zurückziehen |
| GET | `/api/v1/public/runs/:token` | Öffentliche Ansicht (Passwort per Header `X-Share-Password`) |
| PUT/DELETE/POST | `/api/v1/public/runs/:token/items/...`, `.../sections/:id/items` | Bearbeiten über den Link (nur bei Berechtigung „bearbeiten“) |

Listen und Detail der Checklisten enthalten `share: {access, permission} | null` (Kennzeichnung „Geteilt“).

## Nutzer per Kommandozeile anlegen

Funktioniert auch bei `REGISTRATION_ENABLED=false`. Ohne `CREATE_USER_PASSWORD` wird ein Zufallspasswort erzeugt und einmalig ausgegeben.

```bash
docker compose exec app create-user anna@example.org "Anna Muster"
```

Lokal: `node dist/cli/create-user.js <email> [Name]` (nach `npm run build`).

## Datenbank ändern

`src/db/schema.ts` bearbeiten, dann `npm run db:generate` – erzeugt eine neue SQL-Migration in `drizzle/`.

## Struktur

```
src/config.ts      Umgebungsvariablen (zod-validiert)
src/logger.ts      pino, JSON auf stdout, redaktiert Passwörter/Token
src/db/schema.ts   Datenmodell (Pflichtenheft Abschnitt 4)
src/db/index.ts    SQLite öffnen + Migrationen
src/server.ts      Fastify, /healthz, /api/v1/config
src/plugins/auth.ts Sitzungen (Cookie), CSRF-Origin-Prüfung, requireUser
src/auth/          Passwort (argon2id, Richtlinie), Sitzungen
src/routes/        auth.ts (Registrierung, Login, Reset), me.ts (Profil)
src/mail.ts        SMTP-Versand (nodemailer)
src/routes/        tags.ts, templates.ts, runs.ts, trash.ts, shares.ts, tokens.ts, two-factor.ts, sso.ts, import-export.ts
src/services/      template-items.ts, run-items.ts (Baum, Verschieben, Kopieren, Fortschritt)
src/colors.ts      Tag-Farbwahl (OKLab) und Schriftkontrast
src/auth/          totp.ts, two-factor.ts, oidc.ts (neben Passwort/Sitzung/Token)
src/web.ts          Auslieferung der Oberfläche (web/ → dist/public)
src/mcp.ts          MCP-Server (/mcp)
src/services/      csv.ts, export.ts, import.ts
src/openapi.ts      OpenAPI-Beschreibung (Test gleicht mit den Routen ab)
src/jobs.ts        Hintergrundjobs (Papierkorb leeren, Reset-Token)
src/cli/           create-user
drizzle/           SQL-Migrationen
test/              Vitest
```
