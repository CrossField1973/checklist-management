# Checklisten-Management – Hinweise für Claude

Selbst gehostete Neuumsetzung der Mendix-„Checklist App“ (Vorlagen, Durchführungen, Teilen, API, MCP). Sprache im Projekt: **Deutsch** (Doku, UI-Texte, Antworten); Code und Bezeichner englisch.

## Wo steht was
- `Pflichtenheft.md` – maßgebliche Anforderungen (F-xx, N-xx), Datenmodell, API-Skizze und **Entwicklungsreihenfolge in §7 mit ✔-Markierungen = aktueller Stand**. Nach jedem Schritt dort das ✔ setzen.
- `docs/` – Betriebs-, API-, MCP-, Import/Export-, Anmelde-, Benutzer- und Entwicklungsdoku (`docs/entwicklung.md` zuerst lesen). Nur bei Änderungen am Verhalten anpassen.
- `mockup.html` – Designvorlage für die Oberfläche (nur Referenz).
- `app/` – Server (Fastify 5, TypeScript, SQLite/Drizzle, zod). `app/web/` – Oberfläche (React 19, Vite, Tailwind 4, TanStack Query, react-i18next, dnd-kit).

## Befehle (in `app/`)
- `npm run typecheck:all`, `npm run test:all` (Server `vitest` + `test:web`), `npm run build:all`.
- Ende-zu-Ende: `npm run test:e2e` (Playwright, Edge; nur nach vollständigen Änderungen, nicht pro Schritt).
- Einzeln: `npm test -- <datei>` bzw. `npm --prefix web test -- <datei>`.
- Docker (Windows: `docker.exe` liegt in `%LOCALAPPDATA%\Programs\DockerDesktop
esourcesin`, nicht im PATH): `docker compose up --build` (braucht `.env`, siehe `.env.example`; nach Tests `docker compose down -v` und `.env`/Cookie-Dateien entfernen).

## Arbeitsweise (Absprache mit dem Nutzer)
- Der Nutzer bestätigt jeden Schritt einzeln („Ja, Schritt N“); nichts ungefragt weiterführen.
- **Prüfaufwand minimal halten:** nur die Tests der geänderten Bereiche laufen lassen, zum Abschluss eines Schritts einmal `typecheck:all` und die betroffenen Testdateien. Keine Fehlereinbau-Prüfungen, kein Docker- oder Browserlauf pro Schritt, außer bei sicherheitsrelevanten Änderungen (Teilen, Token, Anmeldung). Eine Gesamtprüfung (alle Tests, Docker, Browser, Playwright) gibt es erst nach vollständiger Umsetzung.
- Doku gesammelt am Ende eines Schritts, kurz. Antworten kurz, ohne lange Zusammenfassungen.
- Dateien nur gezielt lesen (Teilbereiche), nicht ganze große Dateien ohne Grund.
- Alle Schritte 1–15 sind umgesetzt. Offene Restpunkte: Gesamtprüfung durch den Nutzer, Optionales aus Teil B des Pflichtenhefts.

## Konventionen
- **Datenisolation:** jede Abfrage filtert nach `userId` (keine Rollen). Fremde Ressourcen → 404.
- **Geheimnisse:** nie in Logs oder Antworten (Passwörter, Token, Freigabe-Token, Codes). `src/logger.ts` maskiert URLs; neue Query-Parameter mit Geheimnissen dort ergänzen. Token/Wiederherstellungscodes werden nur einmal angezeigt.
- Eingaben mit zod prüfen; Routen müssen im OpenAPI-Schema stehen (Abdeckungstest schlägt sonst fehl).
- Datenbankänderungen: `npm run db:generate` (Migration in `app/drizzle`), nie bestehende Migrationen ändern.
- Fehlermeldungen als Code + Text; Oberfläche übersetzt über `errors.*` in `de.json`/`en.json`. **Jeder neue UI-Text in beiden Sprachdateien** (Plural: `_one/_other`).
- Geschäftslogik in `src/services/`, Routen dünn halten.

## Oberfläche (`app/web`)
- Bausteine in `src/components/ui.tsx` (`Button`, `Dialog` auf `<dialog>`, `Alert`, `TextInput`, `useErrorText`, …) wiederverwenden; Dark Mode über CSS-Variablen in `styles.css`.
- Daten über `api` (`src/api/client.ts`) und TanStack Query (`queryKey`s: `templates`, `template`, `tags`, …); nach Änderungen die passenden Keys invalidieren.
- Baum-Logik (Verschieben, Ziehen) liegt rein in `src/lib/tree.ts`; Muster für Editoren: optimistisch ändern, Antwort des Servers übernehmen, bei Fehler neu laden (siehe `TemplateEditor.tsx`).
- Tests: Vitest + Testing Library; Fake-Server `mockApi` und `harness.tsx` in `src/test/`. jsdom kann kein Drag-and-Drop – Ziehen nur über Unit-Tests der Logik und Schaltflächen testen. Bei Zeitüberschreitungen die Zeitlimits in `setup.ts`/`vite.config.ts` nutzen, nicht die Tests lockern.
- Barrierefreiheit: Beschriftungen für alle Bedienelemente, Tastaturbedienung, bewegungsfreie Alternative zu Ziehen.

## Bekannte Stolpersteine
- Bash-Heredocs mit Apostrophen in der Shell scheitern; längere Skripte/Dateien mit dem Write-Werkzeug anlegen.
- Windows/Git-Bash: Pfade mit `/` werden umgewandelt (MSYS); bei `docker`/`curl`-Pfaden aufpassen.
- Docker-Image: `npm ci --ignore-scripts` (better-sqlite3 bringt Binaries mit), Node 24.
- SPA-Fallback liefert für Pfade mit Dateiendung 404, sonst `index.html`.
