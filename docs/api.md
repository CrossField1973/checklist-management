# REST-API

Basis: `{APP_BASE_URL}/api/v1`. Alle Daten sind JSON. Die interaktive Beschreibung (Swagger) liegt unter **`/api/docs`**, die maschinenlesbare OpenAPI-3.0-Datei unter **`/api/openapi.json`** – beide ohne Anmeldung erreichbar. Sie wird aus den Validierungsschemas der Routen erzeugt und per Test auf Vollständigkeit geprüft.

## Grundregeln

- **Authentifizierung:** entweder Browser-Sitzung (`POST /auth/login`, danach Cookie `session`; schreibende Anfragen mit fremdem `Origin`-Header werden abgelehnt, `403 forbidden_origin`) oder **API-Token** (siehe unten).
- **Mandantentrennung:** Jede Anfrage sieht nur Daten des angemeldeten Nutzers. Fremde IDs liefern `404`.
- **Fehlerformat:** `{ "error": "code", ... }`

| Status | Bedeutung |
|---|---|
| 400 `validation_error` | Eingabe ungültig (`details` nennt die Felder) |
| 401 `unauthorized` | nicht angemeldet |
| 403 | verboten (z. B. `registration_disabled`, `read_only_link`) |
| 404 `not_found` | gibt es nicht oder gehört jemand anderem |
| 409 | Konflikt (`email_taken`, `run_not_active`, `tag_name_taken`) |
| 422 | fachlich ungültig (`password_policy`, `cycle`, `too_deep`, `unknown_template`, `password_required`) |
| 429 `too_many_attempts` | Sperre nach Fehlversuchen; Header `Retry-After` |

Die vollständige Liste der Routen steht im [README der Anwendung](../app/README.md).

## Zwei-Faktor und SSO

Anmeldung mit zweitem Faktor (`code` im Login), 2FA-Verwaltung und OpenID-Connect-Ablauf: siehe [anmeldung.md](anmeldung.md).

## Import und Export

Export als JSON/CSV/Markdown, Import mit Vorschau (`dryRun`) und Fehlermeldungen je Zeile, siehe [import-export.md](import-export.md).

## API-Token

> KI-Assistenten binden Sie über den MCP-Server an (`/mcp`, siehe [mcp.md](mcp.md)); er verwendet dieselben Token.

Für Skripte, Automatisierung und KI-Assistenten. Token legt man im Profil an (oder per API mit Browser-Sitzung).

```bash
# anlegen (Browser-Sitzung nötig) – der Klartext steht NUR in dieser Antwort
curl -b cookies.txt -X POST "$BASE/api/v1/me/tokens" -H 'content-type: application/json' \
  -d '{"name":"Home-Assistant","permission":"write","expiresAt":"2027-12-31T23:59:59Z"}'
# → 201 {"token":"ck_…","apiToken":{"id":"…","prefix":"ck_Ab3x","permission":"write",…}}

# verwenden
curl -H "Authorization: Bearer ck_…" "$BASE/api/v1/templates"
```

| Recht | Erlaubt |
|---|---|
| `read` (lesen) | nur GET-Anfragen; Änderungen → `403 token_read_only` |
| `write` (lesen+schreiben) | alles, was der Nutzer in der Oberfläche darf – außer unten |

Nur mit **Browser-Sitzung** möglich (API-Token erhalten `403 session_required`): Profil ändern (inkl. Darstellung: `theme`, `accent` = blue|indigo|violet|rose|orange|green|teal|slate, `fontSize` = normal|large|xlarge, `hideDone`), Passwort ändern, Konto löschen, Token verwalten.

- Ein Token handelt immer als sein Besitzer und sieht nur dessen Daten.
- Gespeichert werden nur der Hash und ein kurzes Präfix; verlorene Token lassen sich nicht wieder anzeigen – neu anlegen und den alten widerrufen.
- Optionales Ablaufdatum (max. 10 Jahre). Abgelaufene oder widerrufene Token → `401` (`token_expired` bzw. `invalid_token`).
- Höchstens 50 aktive Token je Nutzer.
- **Rate-Limit:** je Token `API_RATE_LIMIT_PER_MINUTE` Anfragen (Standard 120); danach `429 rate_limited` mit `Retry-After`.
- Ein ungültiger Bearer-Header führt immer zu `401` – es gibt keinen Rückfall auf ein gleichzeitig gesendetes Cookie.
- Im Docker-Log erscheinen `api_token_created`, `api_token_used` (höchstens einmal pro Minute und Token), `api_token_rejected`, `api_token_revoked` – nie der Token selbst.

## Teilen mit Dritten

Eine **aktive** Durchführung kann per Link geteilt werden. Pro Durchführung gibt es höchstens einen aktiven Link.

### Link verwalten (angemeldet)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/runs/:id/share` | aktueller Link oder `{"share": null}` |
| PUT | `/runs/:id/share` | anlegen (`201`) oder Einstellungen ändern (`200`, Link bleibt gleich) |
| POST | `/runs/:id/share/regenerate` | neuen Link mit gleichen Einstellungen erzeugen, alter wird ungültig |
| DELETE | `/runs/:id/share` | Link widerrufen (`204`) |
| GET | `/me/shares` | alle eigenen aktiven Freigaben (mit `runTitle`, `runDeleted`, `url`) |
| DELETE | `/me/shares/:id` | eine Freigabe zurückziehen |
| DELETE | `/me/shares` | alle Freigaben zurückziehen → `{ "revoked": n }` |

Beispiel – mit Passwort teilen, Empfänger dürfen bearbeiten:

```bash
curl -b cookies.txt -X PUT "$BASE/api/v1/runs/$RUN_ID/share" \
  -H 'content-type: application/json' \
  -d '{"access":"password","permission":"edit","password":"geheimes-passwort"}'
# → 201 {"share":{"id":"…","access":"password","permission":"edit","url":"https://…/s/Zx…","createdAt":…}}
```

| Feld | Werte |
|---|---|
| `access` | `anyone` (jeder mit dem Link) · `password` (Link + Passwort, mind. 8 Zeichen; ohne neues Passwort bleibt das bisherige) |
| `permission` | `view` (nur ansehen) · `edit` (ansehen und bearbeiten) |

Regeln:
- Der Link enthält einen zufälligen Token mit 192 Bit. In der Datenbank liegen nur sein Hash und eine verschlüsselte Fassung (damit „Link kopieren“ funktioniert).
- **Archivierte Durchführungen sind nicht teilbar** (`409 run_not_active`). Beim Archivieren wird der Link widerrufen.
- Im **Papierkorb** ist der Link unwirksam, nach Wiederherstellung (aus dem Zustand „aktiv“) wieder gültig.
- Es gibt **kein Ablaufdatum**; der Link gilt bis zum Widerruf.

Liste und Detail der Durchführungen enthalten `share: { access, permission }` bzw. `null` zur Kennzeichnung geteilter Durchführungen.

### Zugriff über den Link (ohne Konto)

Pfad: `/public/runs/:token` – der Token steht am Ende des Links (`…/s/<token>`). Bei Passwortschutz wird das Passwort bei **jeder** Anfrage im Header `X-Share-Password` gesendet.

| Methode | Pfad | Berechtigung | Zweck |
|---|---|---|---|
| GET | `/public/runs/:token` | ansehen | Durchführung lesen: `{ permission, run: { title, updatedAt, progress, sections } }` |
| PUT | `/public/runs/:token/items/:itemId` | bearbeiten | abhaken `{isChecked}`, Titel/Beschreibung ändern |
| POST | `/public/runs/:token/sections/:sectionId/items` | bearbeiten | Punkt hinzufügen |
| POST | `/public/runs/:token/items/:itemId/move` | bearbeiten | Punkt verschieben/umsortieren |
| DELETE | `/public/runs/:token/items/:itemId` | bearbeiten | Punkt löschen |

Antworten enthalten jeweils die komplette, aktuelle Ansicht. Mit `run.updatedAt` erkennt ein Client per Polling (z. B. alle 5–10 Sekunden), ob sich etwas geändert hat.

Nicht möglich über den Link: Vorlagen hinzufügen, Durchführung umbenennen/abschließen/archivieren/löschen, Abschnitte ändern, Link ändern.

| Status | Bedeutung |
|---|---|
| 401 `password_required` / `invalid_password` | Passwort fehlt bzw. ist falsch |
| 403 `read_only_link` | Link erlaubt nur Ansehen |
| 404 | Link unbekannt, widerrufen, Durchführung gelöscht oder archiviert |
| 429 | Nach 5 falschen Passwörtern von derselben Adresse zeitweise gesperrt |

Die Antworten sind mit `X-Robots-Tag: noindex` und `Cache-Control: no-store` versehen.
