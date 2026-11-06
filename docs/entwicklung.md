# Entwicklung

## Architektur

Ein einziger Node.js-Prozess (TypeScript, Fastify) liefert REST-API und – später – die Web-Oberfläche aus. Daten liegen in SQLite (Drizzle ORM, Migrationen unter `app/drizzle/`). Hintergrundjobs laufen im selben Prozess.

```
Browser / MCP-Client / Freigabelink
        │  HTTP (JSON)
┌───────▼─────────────────────────────┐
│ Fastify                             │
│  plugins/auth    Cookie-Sitzung,    │
│                  CSRF (Origin)      │
│  routes/*        dünn: validieren,  │
│                  Rechte prüfen      │
│  services/*      Fachlogik          │
│  jobs            stündlich          │
└───────┬─────────────────────────────┘
        │ better-sqlite3 (synchron)
   /data/app.db
```

## Oberfläche (`app/web/`)

React-Single-Page-App (Vite, TypeScript, Tailwind v4, `react-router`, TanStack Query, `react-i18next`). Der Server liefert die gebaute App aus (`src/web.ts`): Dateien unter `/assets/` unveränderlich zwischengespeichert, alle unbekannten Seiten-Adressen (nicht `/api`, `/mcp`, `/healthz`, keine Dateiendung) erhalten `index.html` (damit `/profile` und `/s/<token>` beim Neuladen funktionieren), `index.html` nie zwischengespeichert. Dazu setzt der Server strenge Sicherheits-Header (CSP u. a.).

| Pfad | Inhalt |
|---|---|
| `web/src/api/` | `client.ts` (fetch-Client, `ApiError`, Download), `types.ts` |
| `web/src/auth/AuthProvider.tsx` | Sitzung (`GET /me`), Konfiguration, Sprache und Design anwenden, Abmelden |
| `web/src/components/` | `ui.tsx` (Button, Feld, Dialog auf `<dialog>`, Alert, Fehlertexte), `Layout.tsx` (Navigation, Zugriffsschutz) |
| `web/src/pages/` | Anmelden, Registrieren, Passwort vergessen/zurücksetzen, Platzhalter; `profile/` mit einem Abschnitt je Datei; `templates/` (Liste, Editor, Punktebaum, Tags); `runs/` (Liste/Archiv, Ansicht, `RunBoard` für Abschnitte und Punkte, Teilen-Dialog, öffentliche Ansicht); `TrashPage.tsx` |
| `web/src/lib/tree.ts` | Reine Funktionen des Punktebaums: Abflachen, Verschieben (gleiche Semantik wie der Server), Ziel beim Ziehen (`getProjection`), Ziele der Schaltflächen |
| `web/src/i18n/` | `de.json`, `en.json` (identische Schlüssel, Plural mit `_one`/`_other`) |
| `web/src/test/` | Testhilfen (`harness.tsx`: Fake-API) und Tests |

**Entwicklung:** Backend starten (siehe unten), dann in `app/web`: `npm install`, `npm run dev` → <http://localhost:5173> (leitet `/api` und `/mcp` an `localhost:3000`). Tests: `npm test`. Alles zusammen: im Ordner `app` `npm run build:all`, `npm run test:all`, `npm run typecheck:all`.

**Punktebaum (Drag-and-Drop):** `ItemTree.tsx` nutzt dnd-kit (Pointer- und Tastatursensor) über eine abgeflachte Liste; die horizontale Ziehbewegung bestimmt die Ebene. Die Zielberechnung steckt in `lib/tree.ts` und ist unabhängig von der Oberfläche getestet. Weil jsdom keine Layoutgrößen kennt, sind Ziehen und Tastaturbedienung dort nicht simulierbar: Die Logik wird per Unit-Test, die Bedienung im echten Browser geprüft; die Schaltflächen (↑↓←→) sind in den Komponententests abgedeckt. Der Editor aktualisiert den Baum optimistisch (`moveInTree`) und ersetzt ihn durch die Antwort des Servers; bei Fehlern wird neu geladen.

**Durchführungen:** `RunBoard.tsx` zeigt Abschnitte und Punkte und wird von der eigenen Ansicht (`RunView`) und der öffentlichen Freigabe-Ansicht (`PublicRun`, Route `/s/:token`, ohne Anmeldung) genutzt; die Aktionen kommen als `BoardActions` herein (eigene bzw. `/public/runs/<token>/…`-Endpunkte). Abhaken ist optimistisch, jede Serverantwort ersetzt den Zwischenspeicher, bei Fehlern wird neu geladen. Das Freigabe-Passwort wird nur im Speicher gehalten und als Header `x-share-password` gesendet (nie in Adresse oder Browser-Speicher). Die öffentliche Ansicht fragt alle 5 s neu ab.

**Barrierefreiheit:** `web/src/test/a11y.test.tsx` lässt axe-core (WCAG 2.0–2.2 A/AA) über alle Seiten und die wichtigsten Dialoge laufen und rechnet die Farbkontraste der Design-Variablen (hell und dunkel) aus `styles.css` nach (Text ≥ 4,5:1, Fokus ≥ 3:1). Neue Seiten dort in die Liste aufnehmen. Nicht automatisch prüfbar (jsdom): Layout, Zoom/Reflow und echtes Screenreader-Verhalten – das bleibt Stichprobe von Hand.

**Offline (F-74):** `web/public/sw.js` (eigener, kleiner Service Worker) hält die App-Oberfläche vor: beim Installieren werden `/` und alle darin verlinkten Dateien geladen, `/assets/*` sind cache-first (Hash im Namen), Seitenaufrufe network-first mit Rückfall auf die gespeicherte Startseite; `/api`, `/mcp` und `/healthz` gehen immer direkt ins Netz. Daten: `src/offline/persist.ts` sichert ausgewählte React-Query-Abfragen (`runs`, `run`, `templates`, `template`, `tags` – bewusst nicht `run-share`, `me`, öffentliche Ansichten) nach IndexedDB (`idb.ts`), samt Nutzer-ID; beim Start werden sie nur für denselben Nutzer wiederhergestellt. `queue.ts` ist die Änderungswarteschlange (Abhaken = fester Wert, daher wiederholbar; Hinzufügen mit vorläufiger ID `tmp-…`), `OfflineManager.tsx` überträgt bei Verbindung/Start/alle 30 s und meldet Konflikte. Wichtig: `onlineManager.setOnline(navigator.onLine)` in `main.tsx` (sonst scheitern Abfragen beim Start ohne Netz), `networkMode: "always"` für `/me` und `/config`, `gcTime` 7 Tage, Seiten zeigen vorhandene Daten auch bei Abfragefehlern. Abmelden/Sitzungsende ruft `clearOfflineData()`. Neue offline-fähige Aktionen: Operation in `queue.ts` ergänzen (Typ, Senden, Meldungstext `offline.reason.*`) und in der Seite einen `whenOffline`-Zweig angeben (siehe `RunView.call`). Der Service Worker wird nur im Produktionsbuild registriert; der Offline-Ablauf ist im Playwright-Test abgedeckt (`context.setOffline`).

**Bedienkonzept (UX):** Die ganze Zeile eines Punkts ist ein Schalter (großes Ziel, auch für Touch); Zweitaktionen (＋, 🗑) stehen in `.row-actions` und werden per Hover/Fokus eingeblendet (`styles.css`; bei `hover: none` immer sichtbar). Dialoge fragen zuerst nach dem Wichtigen (Vorlagen), Titel und Standardwerte werden vorgeschlagen. Leere Zustände erklären den nächsten Schritt. Texte: deutsche Begriffe „Checkliste/Vorlage“, englisch „checklist/template“ – beim Umbenennen von Begriffen **keine** Platzhalter (`{{runs}}`) in den Sprachdateien mitändern; `i18n.test.ts` prüft, dass beide Sprachen dieselben Platzhalter nutzen. Datumsangaben immer mit `toLocaleDateString(i18n.language, { dateStyle: "medium" })`.

**Regeln für die Oberfläche**
- Jeder Text steht in **beiden** Sprachdateien; ein Test prüft gleiche Schlüssel, gleiche Platzhalter und dass jeder im Code verwendete Schlüssel existiert.
- Fehler des Servers werden über den Fehlercode übersetzt (`errors.<code>`), nie als Rohtext angezeigt.
- Formularfelder immer mit sichtbarer Beschriftung (`Field`), Fehler als `role="alert"`, Dialoge als `<dialog>` (Fokusfalle, Esc).
- Geheimnisse (Token, Wiederherstellungscodes) nur einmal anzeigen und danach nicht im Zustand halten.
- Tests nutzen eine Fake-API (`mockApi`), die nicht registrierte Aufrufe als Fehler meldet.

## Projektstruktur (`app/`)

| Pfad | Inhalt |
|---|---|
| `src/config.ts` | Umgebungsvariablen, zod-validiert |
| `src/logger.ts` | pino, JSON auf stdout, redaktiert Passwörter/Token |
| `src/crypto.ts` | AES-256-GCM für wieder lesbare Geheimnisse (Freigabe-Token) |
| `src/services/csv.ts`, `export.ts`, `import.ts` | CSV lesen/schreiben (inkl. Formel-Schutz), Export (JSON/CSV/Markdown), Import (Prüfung, Vorschau, Anlegen in einer Transaktion) |
| `src/colors.ts` | Tag-Farbwahl (OKLab-Abstand), Schriftkontrast |
| `src/mcp.ts` | MCP-Server (`/mcp`): Werkzeugtabelle, jedes Werkzeug ruft intern die REST-API auf |
| `src/web.ts` | Auslieferung der Oberfläche (SPA-Fallback, Caching) |
| `src/openapi.ts` | OpenAPI-Beschreibung; Request-Schemas aus den Routen, Test gleicht mit den registrierten Routen ab |
| `src/jobs.ts` | Papierkorb leeren, Reset-Token bereinigen |
| `src/db/` | Schema (`schema.ts`) und Datenbank öffnen + migrieren |
| `src/auth/` | Passwort (argon2id, Richtlinie), Sitzungen, API-Token (`api-tokens.ts`), TOTP (`totp.ts`), 2FA und Wiederherstellungscodes (`two-factor.ts`), OIDC-Dienst (`oidc.ts`), Sperre bei Fehlversuchen |
| `src/plugins/auth.ts` | Sitzungs-Cookie, Bearer-Token, Rate-Limit je Token, Origin-Prüfung, `requireUser` / `requireSession` |
| `src/routes/` | `auth`, `me`, `two-factor`, `sso`, `tokens`, `tags`, `templates`, `runs`, `trash`, `shares`, `import-export` |
| `src/services/` | `template-items`, `run-items` (Baum, Verschieben, Fortschritt), `shares` |
| `src/cli/create-user.ts` | Nutzer per Kommandozeile |
| `test/` | Vitest-Tests je Bereich |

## Neue Route hinzufügen

1. Route in `src/routes/…` mit `app.requireUser` (Sitzung oder Token) bzw. `app.requireSession` (nur Browser) schützen; Eingabe-Schema als `export const …` anlegen.
2. In `src/openapi.ts` einen `op(...)`-Eintrag ergänzen (Schema wiederverwenden). Der Test `openapi.test.ts` schlägt fehl, solange Route und Beschreibung nicht übereinstimmen.
3. Tests für Fachregeln, Mandantentrennung und – bei Schreibzugriffen – Lese-Token (`token_read_only`).

## MCP-Werkzeug hinzufügen

Neuer Eintrag in der Tabelle `TOOLS` in `src/mcp.ts` (Name, Beschreibung für das Sprachmodell, zod-Eingabe, `write: true/false`, Zuordnung auf einen REST-Aufruf). Es gibt keine eigene Fachlogik im MCP-Teil – so bleiben Regeln und Rechte identisch zur REST-API. Schreibende Werkzeuge sehen nur Token mit Recht *lesen+schreiben*. Bewusst ausgeschlossen bleiben Löschen, Archivieren, Teilen und Kontoverwaltung; ein Test prüft die Namen der Werkzeuge darauf.

## Grundsätze

- **Mandantentrennung:** Jede Abfrage filtert auf den Besitzer; fremde IDs verhalten sich wie nicht vorhanden (`404`). Jede neue Route braucht einen Test dafür.
- **Löschen = Soft-Delete** (`deleted_at`); endgültiges Löschen entfernt per Cascade alle Unterdaten.
- **Momentaufnahme:** Eine Durchführung kopiert Vorlagen; spätere Änderungen an Vorlagen wirken nicht zurück.
- **Bäume:** Punkte haben `parent_item_id` und `position`. Einfügen, Verschieben und Löschen nummerieren die Geschwister lückenlos neu; Zyklen und Tiefe > 50 werden abgelehnt.
- **Keine Geheimnisse im Log:** Token, Passwörter und Inhalte werden nie protokolliert, nur Ereignisse mit IDs.
- **Fehlermeldungen:** Codes in `snake_case`, deutsche/englische Texte erzeugt später die Oberfläche.

## Lokal entwickeln (Node.js ≥ 24)

```bash
cd app
npm install
npm test               # Backend-Tests (Oberfläche: npm run test:web, alles: npm run test:all)
npm run typecheck
npm run build
```

Start ohne Docker (PowerShell):

```powershell
$env:APP_BASE_URL="http://localhost:3000"; $env:SESSION_SECRET=("x"*32); $env:DATABASE_PATH="./data/app.db"; npm run dev
```

## Tests

Für SSO startet der Test einen eigenen minimalen OIDC-Anbieter (`test/fake-idp.ts`) mit echten HTTP-Anfragen und RS256-Signaturen, inklusive Fehlerfällen (falsche nonce/Zielgruppe/Aussteller, abgelaufene Token, Replay). Für 2FA wird die Uhr (`Date`) vorgestellt, um mehrere Zeitschritte zu durchlaufen.

Die Tests laufen gegen eine In-Memory-Datenbank und ersetzen den Mailversand. Sie prüfen jeweils die Fachregeln, die Mandantentrennung und die Grenzfälle (Archiv schreibgeschützt, Zyklen, Sperren). Neue Funktionen werden mit Tests geliefert; wichtige Regeln wurden zusätzlich durch gezieltes Einbauen von Fehlern (Mutation) auf Wirksamkeit geprüft.

### Querschnittstests (`test/security.test.ts`)
- **Anmeldung überall:** Aus der Routentabelle werden alle API-Routen ohne Sitzung aufgerufen – außer einer ausdrücklich öffentlichen Liste müssen alle mit 401 antworten. Eine neue Route ist damit automatisch geprüft; eine neue öffentliche Route muss bewusst in die Liste.
- **Mandantentrennung:** Nutzer A legt Vorlage, Punkte, Tag, Durchführung, Freigabe, Token und Papierkorb-Einträge an; Nutzer B ruft jede Route mit diesen IDs auf und erhält 404 (bzw. 422 bei fremden IDs im Body). Danach muss A's Datenbestand unverändert sein. Ein Abgleich mit der Routentabelle verlangt, dass jede Route mit ID in der Angriffsliste steht.
- Außerdem: keine Hashes/Geheimnisse in Antworten, Cookie-Attribute, Schutz-Kopfzeilen.

### Ende-zu-Ende-Tests (Playwright)
`app/e2e/` enthält die Hauptabläufe im echten Browser gegen den gebauten Server (frische temporäre Datenbank, Port 3100):

```bash
npm run test:e2e
```

Der Befehl baut vorher alles. Standardbrowser ist das installierte **Microsoft Edge**; mit `E2E_BROWSER=chrome` bzw. `E2E_BROWSER=chromium` (vorher `npx playwright install chromium`) lässt sich wechseln. Mit `E2E_BASE_URL=http://localhost:3000` laufen dieselben Tests gegen einen bereits laufenden Server, z. B. den Docker-Container. Abgedeckt: Vorlage → Durchführung → Abhaken → Archivieren → Wiederöffnen → Abschließen → Papierkorb; Teilen mit Passwort samt Gast im eigenen Browserkontext (Bearbeiten, automatische Aktualisierung, Widerruf); Abmelden/Zugriffsschutz; fremde Durchführung.

## Datenbank ändern

1. `src/db/schema.ts` bearbeiten
2. `npm run db:generate` → neue SQL-Datei in `drizzle/` (nicht von Hand ändern)
3. Test schreiben, `npm test`

Migrationen werden beim Start automatisch angewendet.

## Docker-Image

Zweistufig (Build → Laufzeit), Node 24 auf Debian-slim, läuft als Nutzer `node`. `npm ci --ignore-scripts`, da `better-sqlite3` fertige Binärdateien mitliefert (sonst würde `node-gyp` versuchen zu kompilieren). Der Healthcheck ruft `/healthz` auf.
