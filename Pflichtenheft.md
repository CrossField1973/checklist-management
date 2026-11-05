# Pflichtenheft – Checklisten-Management (Self-Hosted)

**Version:** 3.14 (Entwurf) · **Stand:** 2026-11-05
**Zweck:** Nachbau und Erweiterung der Mendix-„Checklist App“ als selbst gehostete Anwendung ohne Nutzer-/Datenlimits. Grundlage für die Entwicklung mit KI-Unterstützung.
**Quelle:** Analyse des Mendix-Projekts `Checklist App/Checklist App-main` plus Anpassungswünsche vom 2026-11-05.
**Hinweis:** Anforderungs-IDs sind stabil und bewusst nicht lückenlos (entfallene Anforderungen wurden nicht neu nummeriert).

---

## 1. Ziel und Umfang

Eine Web-App, mit der jeder Nutzer **Vorlagen** für Checklisten pflegt und daraus **Durchführungen** startet. Eine Durchführung kann aus **mehreren Vorlagen** zusammengesetzt und nachträglich um weitere Vorlagen ergänzt werden. Fertige Durchführungen werden **abgeschlossen** (= gelöscht, landen im Papierkorb) oder **archiviert** (dauerhaft aufbewahrt). Eine Durchführung kann per Link mit Dritten geteilt werden.

- Selbst gehostet (Docker), eigene Datenbank, keine Limits.
- Jeder Nutzer sieht nur seine eigenen Daten. Es gibt keine Rollen.
- Responsive, mehrsprachig (DE/EN), Dark Mode, offlinefähig (PWA).

**Beispiel:** „Ausflug Füssen mit Flo“ = Durchführung aus den Vorlagen *Tagesausflug*, *Übernachtung*, *Therme*, *Wandern*. Fällt später noch ein Punkt ein, kommt eine weitere Vorlage zur laufenden Durchführung hinzu.

## 2. Begriffe (selbsterklärende Benennung)

| Begriff | Bedeutung | Mendix-Original |
|---|---|---|
| **Vorlage** | Wiederverwendbare Liste von Punkten. Wird nie abgehakt. Kann Tags tragen. | `Checklist` (Original) |
| **Punkt** | Eintrag einer Vorlage mit Titel, Beschreibung und beliebig vielen Unterpunkten. | `Task` |
| **Durchführung** | Konkrete Verwendung, z. B. „Ausflug Füssen“. Besteht aus einem oder mehreren Abschnitten. Ist aktiv oder archiviert. | `Checklist` (Kopie) |
| **Abschnitt** | Aus einer Vorlage übernommene Punkte innerhalb einer Durchführung. Momentaufnahme (Kopie). | – (neu) |
| **Durchführungspunkt** | Ein abhakbarer Punkt in einem Abschnitt. | `Task` (Kopie) |
| **Abschließen** | Durchführung ist erledigt und wird **gelöscht** (Papierkorb). Es gibt keinen Status „abgeschlossen“. | `Complete` (löschte) |
| **Status** | `aktiv` oder `archiviert` (siehe 3.4). | – (neu) |
| **Archiv** | Dauerhafte Ablage archivierter Durchführungen. Wird nie automatisch geleert. | – (neu, Original löschte) |
| **Papierkorb** | Gelöschte Vorlagen und Durchführungen, wiederherstellbar, wird automatisch geleert. | – (neu) |
| **Tag** | Farbige Markierung für **Vorlagen** (nicht für Durchführungen). | – (neu) |

---

## 3. Funktionale Anforderungen

### 3.1 Konto, Anmeldung, Profil

| ID | Anforderung |
|---|---|
| **F-01** | **Registrierung** mit E-Mail, Anzeigename und Passwort. Per Konfiguration abschaltbar (siehe N-06, Abschnitt 6). |
| **F-02** | **Login/Logout** mit E-Mail und Passwort. Ohne Login ist nichts erreichbar, außer geteilte Links (F-40). |
| **F-03** | **Passwort-Richtlinie** nach Branchenstandard (NIST SP 800-63B / OWASP): mind. 12 Zeichen, max. 128 Zeichen, alle Zeichen und Leerzeichen erlaubt, Einfügen erlaubt, **keine** Pflicht für Sonderzeichen/Groß-/Kleinschreibung, **keine** erzwungene regelmäßige Änderung. Abgelehnt werden häufige oder bekannt kompromittierte Passwörter (lokale Liste oder HIBP-k-Anonymity, einstellbar) sowie Passwörter, die E-Mail/Namen enthalten. Hashing mit argon2id. |
| **F-04** | **Brute-Force-Schutz:** Rate-Limit und zunehmende Verzögerung bei Fehlversuchen je Konto und IP. |
| **F-05** | **Benutzerprofil** mit: Anzeigename, E-Mail, **Sprache** (Deutsch/Englisch), Design (hell/dunkel/System), Aufbewahrungsdauer des Papierkorbs (F-32), geteilte Durchführungen verwalten (F-45), Passwort ändern, 2-Faktor-Einrichtung, API-Tokens, Konto löschen. |
| **F-06** | **Passwort ändern** im Profil (aktuelles + neues Passwort, Richtlinie F-03). Danach werden alle anderen Sitzungen beendet. |
| **F-07** | **Passwort vergessen** per E-Mail (SMTP): einmaliger, 1 Stunde gültiger Link. Die Antwort verrät nicht, ob die E-Mail existiert. Ist SMTP nicht konfiguriert, wird die Funktion ausgeblendet. |
| **F-08** | **2-Faktor-Authentifizierung** (TOTP nach RFC 6238, kompatibel mit gängigen Authenticator-Apps) mit 10 einmaligen Wiederherstellungscodes. Je Nutzer optional; Einrichtung in zwei Schritten (Geheimnis/QR-Code erzeugen, mit Code bestätigen), nur mit Browser-Sitzung und Passwort. Anmeldung: Passwort + `code` (sonst `401 two_factor_required`); ein Code gilt nur einmal (Replay-Schutz), Sperre nach 5 Fehlversuchen; Deaktivieren und Erneuern der Codes nur mit Passwort und gültigem Code. Geheimnis verschlüsselt, Wiederherstellungscodes nur als HMAC gespeichert. 2FA gilt für die Passwort-Anmeldung, nicht für API-Token und nicht für SSO (dort entscheidet der Anbieter). |
| **F-09** | **SSO per OpenID Connect** (z. B. Authentik, Keycloak, Dex), per Konfiguration aktivierbar: Authorization-Code-Flow mit PKCE (S256), `state` und `nonce`; Redirect-URI `APP_BASE_URL/api/v1/auth/oidc/callback`. Kontozuordnung: bekannte Identität → Anmeldung; sonst Konto mit gleicher E-Mail nur bei vom Anbieter **bestätigter** Adresse (`email_verified`) verknüpfen; sonst neues Konto, **nur wenn `REGISTRATION_ENABLED=true`** (bei `false` melden sich nur vorhandene Nutzer an). Bewusstes Verknüpfen und Lösen im Profil (Lösen nur mit vorhandenem Passwort). Autorisierungscode und `state` erscheinen nicht im Log. |

### 3.2 Vorlagen

| ID | Anforderung |
|---|---|
| **F-11** | **Vorlagenliste:** Eigene Vorlagen mit Titel, Anzahl Punkte und farbigen Tags; Suche nach Titel, Filter nach Tag, Sortierung, Paginierung. Button „Neue Vorlage“. |
| **F-12** | **Vorlage anlegen/bearbeiten:** Titel (Pflicht), Beschreibung (optional), Tags. |
| **F-13** | **Punkte pflegen:** Hinzufügen, Bearbeiten (Titel Pflicht, Beschreibung mehrzeilig), Löschen, **Umsortieren per Drag-and-Drop**. |
| **F-14** | **Unterpunkte:** Jeder Punkt kann Unterpunkte haben, **beliebig tief** (technisch unproblematisch über `parent_item_id` und rekursive Abfrage). Auf-/Zuklappen; Verschieben zwischen Ebenen per Drag-and-Drop (Maus, Touch **und Tastatur**: Leertaste aufnehmen, Pfeiltasten bewegen, Leertaste ablegen; horizontales Ziehen ändert die Ebene). **Gleichwertige Alternative ohne Ziehen** (WCAG 2.5.7): Schaltflächen „nach oben/unten“ und „ein-/ausrücken“ an jedem Punkt; Screenreader-Ansagen beim Ziehen. Änderungen erscheinen sofort (optimistisch) und werden bei Fehlern zurückgenommen. |
| **F-15** | **Vorlage duplizieren.** |
| **F-16** | **Vorlage löschen** nach Bestätigung → Papierkorb (F-31). Bereits gestartete Durchführungen bleiben unverändert. |
| **F-17** | **Tags (nur für Vorlagen):** Tags anlegen (auch direkt beim Bearbeiten einer Vorlage), umbenennen, löschen, Farbe wählen. Löschen eines Tags entfernt nur die Zuordnung. Nicht für Durchführungen verfügbar. |
| **F-18** | **Automatische Tag-Farbe:** Beim Anlegen eines neuen Tags wird eine Farbe vorgeschlagen und gesetzt, die sich von den bereits vorhandenen Tags des Nutzers **möglichst deutlich unterscheidet**. Verfahren: Kandidatenfarben (alle 10° ein Farbton in vier Helligkeitsstufen); gewählt wird der Kandidat mit dem **größten Mindestabstand** zu allen vorhandenen Tag-Farben (Abstand im Farbraum OKLab). Der Nutzer kann die Farbe jederzeit per Palette/Farbwähler ändern. Alle Tag-Farben müssen WCAG-AA-Kontrast für die Beschriftung bieten (Textfarbe schwarz/weiß automatisch). |

### 3.3 Durchführungen

| ID | Anforderung |
|---|---|
| **F-20** | **Startseite „Aktuelle Durchführungen“:** zeigt aktive Durchführungen mit Titel, Fortschrittsbalken (x von y erledigt) und letzter Änderung. Keine Vorlagen, keine archivierten. Suche. **Geteilt-Kennzeichnung:** Geteilte Durchführungen tragen ein gut sichtbares Symbol/Badge „Geteilt“ (mit Berechtigung und Zugriffsart, z. B. „Geteilt · bearbeiten · Passwort“), nicht geteilte nicht. Filter „Alle / Geteilt / Nicht geteilt“. |
| **F-21** | **Plus-Button** auf der Startseite: Dialog zum Anlegen einer Durchführung mit Titel und **Auswahl einer oder mehrerer Vorlagen** (Mehrfachauswahl mit Suche und Tag-Filter). Auch ohne Vorlage möglich (leere Durchführung). Gewählte Vorlagen werden als **Abschnitte** kopiert; Reihenfolge der Abschnitte = Auswahlreihenfolge. |
| **F-22** | **Vorlagen nachträglich ergänzen:** In einer Durchführung Button „Vorlage hinzufügen“ → Auswahl einer oder mehrerer Vorlagen → neue Abschnitte werden angehängt. Dieselbe Vorlage kann mehrfach hinzugefügt werden. Nur bei aktiven Durchführungen. |
| **F-23** | **Durchführungsansicht:** Abschnitte (Titel = Vorlagenname) mit Punkten als verschachtelter Baum, Checkbox je Punkt, auf-/zuklappbar. Fortschritt je Abschnitt und gesamt. |
| **F-24** | **Abhaken** speichert sofort mit Zeitstempel. Abhaken eines Elternpunkts ist unabhängig von den Unterpunkten; am Elternpunkt wird deren Fortschritt (x/y) angezeigt. |
| **F-25** | **Eigene Punkte** in einer Durchführung hinzufügen, bearbeiten, löschen, umsortieren (Vorlage bleibt unverändert). Einzelne Abschnitte entfernen. |
| **F-26** | **Änderungen an Vorlagen** wirken nicht rückwirkend auf bestehende Durchführungen (Momentaufnahme). Der Abschnitt merkt sich den Verweis auf die Quellvorlage (nur zur Anzeige). |
| **F-27** | **Durchführung umbenennen** und löschen (→ Papierkorb nach Bestätigung). |

### 3.4 Abschluss, Archiv und Papierkorb

| ID | Anforderung |
|---|---|
| **F-28** | **Beenden einer Durchführung – zwei Möglichkeiten:** **„Abschließen“** **löscht** die Durchführung (→ Papierkorb, F-31, wiederherstellbar). **„Archivieren“** setzt den Status auf `archiviert` und bewahrt sie dauerhaft auf. Ein Dialog bietet beide Optionen an und warnt vor noch offenen Punkten. Es gibt keinen Zwischenstatus „abgeschlossen“ und keinen Bereich „Abgeschlossen“ auf der Startseite. |
| **F-30** | **Archiv-Ansicht:** Liste archivierter Durchführungen mit Abschlussdatum, Fortschritt und Suche; schreibgeschützte Detailansicht. **Wieder öffnen** (zurück auf `aktiv`) und **Löschen** (→ Papierkorb) möglich. Das Archiv wird **nie automatisch geleert**. |
| **F-31** | **Papierkorb** für **Vorlagen und Durchführungen** (auch archivierte; abgeschlossene Durchführungen landen hier): Anzeige mit Löschdatum und „Wird endgültig gelöscht am …“, **Wiederherstellen** (zurück in den früheren Status `aktiv` bzw. `archiviert`), **endgültig löschen**, **Papierkorb leeren** (jeweils mit Bestätigung). Löschen einer Vorlage entfernt ihre Punkte per Cascade erst beim endgültigen Löschen, nichts bleibt verwaist. |
| **F-32** | **Automatisches Leeren des Papierkorbs:** Je Nutzer einstellbare Aufbewahrungsdauer (7 / 30 / 90 / 365 Tage oder nie). Ein Hintergrundjob (beim Start und stündlich) löscht ältere Einträge endgültig. Standardwert für neue Nutzer per `TRASH_RETENTION_DAYS` (N-06). |

### 3.5 Teilen mit Dritten

| ID | Anforderung |
|---|---|
| **F-40** | **Freigabelink** je Durchführung: zufälliger, nicht erratbarer Token (192 Bit; gespeichert als Hash plus verschlüsselte Fassung, damit der Link in der Verwaltung erneut angezeigt werden kann). Link jederzeit **widerrufbar** oder neu erzeugbar (der alte wird sofort ungültig). |
| **F-41** | **Zugriffsart einstellbar:** (a) „Jeder mit dem Link“ oder (b) „Link + Passwort“ (Passwort gehasht, eigene Rate-Limits). |
| **F-42** | **Berechtigung einstellbar:** „nur ansehen“ oder „ansehen und bearbeiten“. Bearbeiten umfasst Abhaken sowie Punkte hinzufügen, ändern, löschen und umsortieren. Nicht möglich für Empfänger: Vorlagen hinzufügen, Durchführung umbenennen, abschließen, archivieren, löschen oder den Link ändern. Empfänger brauchen kein Konto. |
| **F-43** | Der Link hat **kein Ablaufdatum**; er gilt bis zum Widerruf. Die geteilte Ansicht ist schlank (ohne Navigation, ohne Konto) und aktualisiert sich automatisch (Polling oder SSE). |
| **F-45** | **Verwaltung geteilter Durchführungen im Profil:** Eigener Bereich „Geteilte Durchführungen“ listet alle aktiven Freigabelinks des Nutzers (Durchführung, Zugriffsart, Berechtigung, erstellt am). Je Eintrag: **Einstellungen ändern** (Zugriffsart, Passwort, Berechtigung), **Link kopieren**, **Teilen zurückziehen** (Link widerrufen, mit Bestätigung), Sprung zur Durchführung. Zusätzlich „Alle Freigaben zurückziehen“. Durchführungen im Papierkorb werden gekennzeichnet. |
| **F-44** | **Archivierte Durchführungen sind nicht teilbar:** Beim Archivieren wird ein bestehender Freigabelink widerrufen (mit Hinweis im Dialog); im Archiv ist „Teilen“ nicht verfügbar. Geteilte Seiten sind per `noindex` von Suchmaschinen ausgeschlossen. Ein Link einer gelöschten (Papierkorb) Durchführung ist unwirksam, bei Wiederherstellung wieder gültig; wird die Durchführung beim Löschen archiviert gewesen, gibt es keinen Link. |

### 3.6 Import und Export

| ID | Anforderung |
|---|---|
| **F-50** | **Export** einzelner Vorlagen/Durchführungen oder aller eigenen Daten (ohne Papierkorb) als **JSON** (vollständig, inkl. Unterpunkte und Tags mit Farbe; ohne IDs, Freigabelinks und Geheimnisse) sowie einzelne Vorlagen/Durchführungen als **CSV** (Trennzeichen Komma/Semikolon/Tab, UTF-8 mit BOM, Schutz vor Formel-Injektion) und **Markdown** (lesbar/druckbar, Durchführungen mit Kontrollkästchen). Download mit sicherem Dateinamen. |
| **F-51** | **Import** von JSON (Round-Trip des Exports) und CSV (Spalten: Vorlage, Ebene/Eltern, Titel, Beschreibung). Mit **Vorschau** (`dryRun`: Zählung, Inhalt, neue/vorhandene Tags) und **Fehlermeldungen je Zeile bzw. JSON-Pfad**; alles oder nichts; Import erzeugt immer neue Datensätze (kein Überschreiben/Zusammenführen); Tags werden ohne Beachtung der Schreibweise wiederverwendet, neue erhalten Farbe automatisch. Grenzen: 2000 Vorlagen, 2000 Durchführungen, 50 000 Punkte, 12 MB. Dient auch der Migration aus der Mendix-App (Grid-Export als CSV, alternative Spaltennamen werden erkannt). |
| **F-52** | **Kompletter Daten-Export des Kontos** (DSGVO; nur Browser-Sitzung): zusätzlich Profil, Papierkorb, Freigabe-Einstellungen und Token-Metadaten – nie Passwörter, Token, Freigabelinks, 2FA-Secrets. Konto-Löschung mit allen Daten (F-05). |

### 3.7 API und Tokens

| ID | Anforderung |
|---|---|
| **F-60** | **REST-API** `/api/v1` mit allen Funktionen der Oberfläche (Vorlagen, Punkte, Tags, Durchführungen, Abschnitte, Abhaken, Status, Papierkorb, Import/Export, Freigabelinks). Maschinenlesbare **OpenAPI-Beschreibung** (`/api/openapi.json`) und Swagger-Ansicht unter `/api/docs` (öffentlich, ohne externe Abhängigkeiten). Die Request-Schemas stammen aus der Validierung; ein Test stellt sicher, dass jede Route beschrieben ist. |
| **F-61** | **API-Token-Verwaltung** im Profil: Token anlegen (Name, Rechte *lesen* / *lesen+schreiben*, optionales Ablaufdatum bis max. 10 Jahre), Liste mit Präfix, Erstellt-/Zuletzt-benutzt-Datum, Widerrufen; höchstens 50 aktive Token je Nutzer. Das Token wird nur **einmalig** im Klartext angezeigt, gespeichert wird nur der Hash. |
| **F-62** | Authentifizierung per `Authorization: Bearer <token>`. Tokens handeln immer als der besitzende Nutzer und sehen nur dessen Daten. Token mit Recht *lesen* dürfen nur GET-Anfragen (`403 token_read_only`). **Konto-, Passwort- und Token-Verwaltung ist nur mit Browser-Sitzung möglich** (`403 session_required`). Ein ungültiger oder abgelaufener Token führt immer zu `401` (kein Rückfall auf ein Cookie). Rate-Limit pro Token (`API_RATE_LIMIT_PER_MINUTE`, Standard 120, `429` mit `Retry-After`). |
| **F-63** | **MCP-Server** (Model Context Protocol, Streamable HTTP) unter `/mcp`, damit KI-Assistenten (z. B. Claude) Vorlagen und Durchführungen lesen, erstellen und bearbeiten können. Authentifizierung ausschließlich per API-Token (F-61/F-62), nie per Cookie; der Server handelt als der Token-Besitzer und sieht nur dessen Daten (N-04). Zustandslos (kein Server-Push, keine Sitzungen; `GET`/`DELETE` → `405`). Anfragen mit fremdem `Origin`-Header werden abgewiesen (Schutz vor DNS-Rebinding). |
| **F-64** | **Lesende MCP-Tools:** `list_templates` (Suche, Tag-Filter), `get_template` (inkl. Punktebaum), `list_runs` (aktiv/archiviert, Suche), `get_run` (Abschnitte, Punktebaum, Fortschritt), `list_tags`. |
| **F-65** | **Schreibende MCP-Tools:** `create_template`, `update_template` (Titel, Beschreibung, Tags), `add_template_item`, `update_template_item`, `move_template_item`, `create_run` (aus einer oder mehreren Vorlagen), `add_templates_to_run`, `add_run_section` (eigener leerer Abschnitt), `add_run_item`, `update_run_item` (Titel, Beschreibung, abhaken/zurücknehmen), `move_run_item`, `create_tag` (Farbe automatisch). Die Werkzeuge rufen intern die REST-API auf; damit gelten garantiert dieselben Regeln wie in der Oberfläche (Validierung, Mandantentrennung, Tiefe, Zyklen, archivierte Durchführungen schreibgeschützt). **Bewusst nicht per MCP:** Löschen, Archivieren/Abschließen, Teilen, Konto- und Token-Verwaltung, Import/Export. |
| **F-66** | **Rechte und Nachvollziehbarkeit:** Token mit Recht *lesen* sehen und nutzen nur lesende Tools, schreibende Tools erfordern *lesen+schreiben*. Jeder Tool-Aufruf wird im Docker-Log protokolliert (`mcp_tool_call`, F-37, nur Werkzeugname, Ergebnis und Token-ID – keine Inhalte), jede MCP-Anfrage zählt einmal gegen das Rate-Limit (F-62) und Fehler enthalten Code und Hinweis. Die öffentliche Konfiguration (`GET /api/v1/config`) nennt die `mcpUrl`; im Profil steht eine kopierbare MCP-Konfiguration (URL, Hinweis auf Token) bereit (Oberfläche, Schritt 12). |

### 3.8 Oberfläche und Betrieb

| ID | Anforderung |
|---|---|
| **F-70** | **Navigation:** Aktuelle Durchführungen (Startseite), Vorlagen, Archiv, Papierkorb, Profil. |
| **F-71** | **Sprachen:** Deutsch (Standard) und Englisch, vollständig übersetzbar; Sprache aus Profil (F-05), vor dem Login aus der Browsereinstellung. |
| **F-72** | **Responsive** für Smartphone/Tablet/Desktop; als **PWA installierbar**. |
| **F-73** | **Dark Mode** (hell/dunkel/System) und **Barrierefreiheit** nach WCAG 2.1 AA: Tastaturbedienung, Fokus-Anzeige, Screenreader-Labels, ausreichende Kontraste. |
| **F-74** | **Offline-Nutzung:** Aktive Durchführungen und Vorlagen werden lokal zwischengespeichert (Service Worker + IndexedDB). **Umgesetzt:** Die App-Oberfläche startet ohne Verbindung (Service Worker); Durchführungen, Vorlagen und Tags sind lesbar (IndexedDB, nutzerbezogen, bei Abmeldung gelöscht). **Abhaken und Hinzufügen von Punkten** funktionieren offline und werden bei Verbindung in Reihenfolge übertragen (Änderungswarteschlange); noch nicht übertragene Punkte sind gekennzeichnet. Alles andere (Löschen, Abschnitte, Vorlagen bearbeiten, Archivieren, Teilen) braucht eine Verbindung. **Konfliktregel (vereinfacht):** Die Änderungen werden in der Reihenfolge der Übertragung angewendet, die letzte Übertragung gewinnt – ohne Zeitstempelvergleich; Löschkonflikte (Punkt/Abschnitt/Durchführung gelöscht, Durchführung inzwischen archiviert) werden mit Namen gemeldet und verworfen. Geteilte Links sind nur online nutzbar. |
| **F-75** | **Bestätigungsdialoge** für löschende, abschließende und archivierende Aktionen; **Validierung** aller Eingaben (Pflichtfelder, Längen; Verschachtelungstiefe technisch nur auf 50 begrenzt als Schutz vor Endlosschleifen). |
| **F-37** | **Protokollierung im Docker-Log (kein Audit-Log in der App):** Sicherheits- und Änderungsereignisse (Login/Fehlversuch, Passwortänderung, Token-Anlage/-Nutzung, Freigabelink angelegt/widerrufen/aufgerufen, Anlegen/Löschen/Wiederherstellen von Vorlagen und Durchführungen, Statuswechsel, Import/Export) werden als **strukturierte Logzeilen (JSON) auf stdout** ausgegeben und sind mit `docker compose logs` einsehbar. Keine Passwörter, Token oder Inhalte im Log; geheime URL-Bestandteile (Freigabe-Token) werden maskiert. Keine Oberfläche dafür. |

---

## 4. Datenmodell (selbsterklärend)

```
User            id, email (unique), display_name, password_hash (null bei reinem SSO),
                language (de|en), theme (light|dark|system),
                trash_retention_days (null = nie), totp_secret (verschlüsselt, null),
                created_at
UserIdentity    id, user_id → User, provider, subject                     (SSO/OIDC)
RecoveryCode    id, user_id → User, code_hash, used_at
PasswordReset   id, user_id → User, token_hash, expires_at, used_at
ApiToken        id, user_id → User, name, token_prefix, token_hash,
                permission (read|write), expires_at, last_used_at, revoked_at
(Browser-Sitzungen: technische Tabelle Session, ohne Oberfläche)

Tag             id, user_id → User, name (unique je Nutzer), color (#RRGGBB)

Template        id, owner_id → User, title, description,
                created_at, updated_at, deleted_at
TemplateItem    id, template_id → Template, parent_item_id → TemplateItem (null = oberste Ebene),
                title, description, position
TemplateTag     template_id → Template, tag_id → Tag

Run             id, owner_id → User, title,
                status (active|archived),
                created_at, updated_at, archived_at,
                deleted_at, status_before_delete (für Wiederherstellung)
RunSection      id, run_id → Run, source_template_id → Template (null erlaubt),
                title (Kopie des Vorlagennamens), position
RunItem         id, section_id → RunSection, parent_item_id → RunItem (null = oberste Ebene),
                title, description, position,
                is_checked (default false), checked_at

RunShare        id, run_id → Run, token_hash, token_enc (verschlüsselt, für „Link kopieren“),
                access (anyone|password), password_hash,
                permission (view|edit), revoked_at, created_at
```

Regeln:
- Alle Daten tragen den Besitzer; jede Abfrage filtert zwingend auf den angemeldeten Nutzer (Test: Zugriff auf fremde IDs → 404).
- Eine Durchführung ist unabhängig von ihren Quellvorlagen (Kopie). `source_template_id` wird auf NULL gesetzt, wenn die Vorlage **endgültig** gelöscht wird.
- Löschen = Soft-Delete (`deleted_at`); endgültiges Löschen entfernt Unterdatensätze per Cascade (Punkte, Abschnitte, Freigabelinks, Tag-Zuordnungen).
- Statuswechsel: `active → archived` (Archivieren, widerruft Freigabelink) und `archived → active` (Wieder öffnen). „Abschließen“ ist kein Status, sondern Löschen (Soft-Delete). Beim Wiederherstellen aus dem Papierkorb wird `status_before_delete` zurückgesetzt.
- Unterpunkte: Selbstreferenz `parent_item_id`, rekursive Abfrage (SQLite/PostgreSQL), Zyklen beim Verschieben verhindert.
- Tags gehören nur zu Vorlagen (`TemplateTag`), es gibt kein `RunTag`.

---

## 5. Nicht-funktionale Anforderungen

| ID | Anforderung |
|---|---|
| **N-01** | Betrieb als **Docker-Container** (`docker compose up`), Daten im persistenten Volume. |
| **N-02** | Keine Begrenzung von Nutzern, Vorlagen, Durchführungen oder Punkten (außer Speicherplatz). |
| **N-03** | **Sicherheit:** argon2id, HttpOnly/Secure/SameSite-Cookies, CSRF-Schutz, Rate-Limits, Security-Header (strenge CSP ohne `unsafe-inline` für Skripte, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`; HSTS bei https-Adresse), Eingaben validiert, Ausgaben escaped, TOTP-Secret verschlüsselt, HTTPS über Reverse Proxy. |
| **N-04** | Fremde Daten sind nie sichtbar (Mandantentrennung, siehe Datenmodell). |
| **N-05** | Antwortzeit normaler Seiten unter 500 ms bei ca. 10 000 Punkten je Nutzer. |
| **N-06** | **Konfiguration per Umgebungsvariablen** (siehe Abschnitt 6). |
| **N-07** | Kein Standardpasswort, keine Demo-Konten. Das erste Konto entsteht per Registrierung oder per Kommandozeile (`create-user`). |
| **N-08** | Backup = Kopie des Daten-Volumes; Doku für Backup/Restore und Update (Migrationen laufen automatisch beim Start). |
| **N-09** | Logs auf stdout (strukturiert, siehe F-37), Health-Endpoint `/healthz`. |
| **N-10** | Hintergrundjobs (Papierkorb leeren, abgelaufene Reset-Token bereinigen) laufen im selben Container. |
| **N-11** | **Dokumentation** im Ordner `docs/`, in Deutsch: (a) *Betrieb* – Installation mit Docker, Konfiguration, Reverse Proxy/HTTPS, Backup und Wiederherstellung, Update, Nutzer per CLI, Fehlersuche; (b) *Benutzerhandbuch* – Vorlagen, Durchführungen, Archiv, Papierkorb, Teilen, Import/Export, 2FA, Profil; (c) *API* – automatisch erzeugte OpenAPI (`/api/docs`) plus Einstieg mit Beispielen; (d) *MCP* – Einrichtung für gängige KI-Clients, Tool-Liste, Sicherheitshinweise; (e) *Entwicklung* – Architektur, Projektstruktur, Tests. Die Doku wird mit jedem Entwicklungsschritt gepflegt, nicht erst am Ende. |

## 6. Konfiguration (Docker / Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `APP_BASE_URL` | Öffentliche URL (für Links/E-Mails) | – (Pflicht) |
| `SESSION_SECRET` | Geheimnis für Sitzungen/Verschlüsselung | – (Pflicht) |
| `REGISTRATION_ENABLED` | `false` = Erstellen neuer Nutzer deaktiviert (Registrierseite, API und SSO-Auto-Anlage gesperrt). Nutzer dann nur per CLI: `docker compose exec app create-user <email>`. | `true` |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURE` | Mailserver für „Passwort vergessen“ | leer = Funktion aus |
| `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET` | SSO | leer = aus |
| `OIDC_NAME`, `OIDC_SCOPES` | Beschriftung der SSO-Schaltfläche, angeforderte Scopes | `SSO`, `openid email profile` |
| `PASSWORD_BREACH_CHECK` | `local`, `hibp`, `off` | `local` |
| `DEFAULT_LANGUAGE` | `de` oder `en` | `de` |
| `TRASH_RETENTION_DAYS` | Vorgabe der Papierkorb-Aufbewahrung für neue Nutzer (`0` = nie) | `30` |
| `API_RATE_LIMIT_PER_MINUTE` | Anfragen pro Minute und API-Token | `120` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `DATABASE_PATH` | Pfad der SQLite-Datei | `/data/app.db` |
| `PORT` | HTTP-Port | `3000` |

## 7. Technische Umsetzung (Empfehlung für KI-Entwicklung)

| Bereich | Empfehlung | Begründung |
|---|---|---|
| Sprache | **TypeScript** (Frontend + Backend) | Eine Sprache, starke KI-Unterstützung |
| Backend | **Fastify**, REST/JSON `/api/v1`, OpenAPI via `@fastify/swagger`, Zod-Validierung, `pino` (JSON-Logs) | Spec aus Schema generierbar (F-60), Logs (F-37) |
| Datenbank | **SQLite** mit **Drizzle ORM** + Migrationen (spätere Umstellung auf PostgreSQL möglich) | Kein DB-Server nötig, rekursive Abfragen unterstützt |
| Jobs | `setInterval` im Prozess (stündlich) | N-10 |
| Frontend | **React + Vite**, Tailwind CSS, `react-router`, TanStack Query, `react-i18next`, `qrcode.react`, `dnd-kit` (ab 12b); Tests mit Vitest + Testing Library. Wird vom Server als Single-Page-App aus `dist/public` ausgeliefert (kein zweiter Container). | Responsive, Standard-Stack |
| Farben | `culori` (OKLab-Abstand) | F-18 |
| Offline | Workbox (Service Worker), IndexedDB (`idb`), Änderungswarteschlange | F-74 |
| i18n | `i18next` (`de.json`, `en.json`) | F-71 |
| Auth | Sitzungs-Cookies, `@node-rs/argon2`, `openid-client`, `nodemailer` | F-02…F-09 (TOTP ohne Fremdbibliothek, mit RFC-Testvektoren) |
| Tests | Vitest (Logik, Mandantentrennung, Farbwahl), Playwright (Hauptabläufe) | Absicherung |
| MCP | `@modelcontextprotocol/sdk` (Streamable HTTP), Tools rufen dieselben Dienste wie die REST-API auf | F-63…F-66 |
| Betrieb | `Dockerfile` (Node 24, Debian-slim) + `docker-compose.yml`, Reverse Proxy (Caddy/Traefik) | N-01 |

**API-Skizze (Auszug, Präfix `/api/v1`)**

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset` | F-01, F-02, F-07 |
| GET/PUT | `/me`; POST `/me/password` | F-05, F-06 |
| GET; POST `/me/2fa/setup`, `/enable`, `/disable`, `/recovery-codes` | `/me/2fa` (nur Browser-Sitzung) | F-08 |
| GET `/auth/oidc/login`, `/auth/oidc/callback`; GET `/me/sso`; POST `/me/sso/unlink` | SSO | F-09 |
| GET/POST/DELETE | `/me/tokens`, `/me/tokens/:id` (nur Browser-Sitzung) | F-61 |
| POST/GET | `/mcp` (außerhalb von `/api/v1`, Bearer-Token) | F-63…F-66 |
| GET/POST/PUT/DELETE | `/tags` | F-17 |
| GET/POST; GET/PUT/DELETE | `/templates`; `/templates/:id` | F-11…F-16 |
| POST/PUT/DELETE | `/templates/:id/items`, `/template-items/:id`; POST `/template-items/:id/move` | F-13, F-14 |
| GET/POST | `/runs?status=active\|archived` | F-20, F-21, F-30 |
| POST | `/runs/:id/sections` (Body: Vorlagen-IDs) | F-22 |
| POST/DELETE | `/runs/:id/sections`, `/run-sections/:id`; POST `/run-sections/:id/move`, `/run-sections/:id/items` | F-22, F-25 |
| PUT/DELETE | `/run-items/:id` (u. a. `isChecked`); POST `/run-items/:id/move` | F-24, F-25 |
| POST | `/runs/:id/complete` (= Papierkorb), `/archive`, `/reopen` | F-28, F-30 |
| GET/PUT/DELETE | `/runs/:id/share`; POST `/runs/:id/share/regenerate` | F-40…F-43 |
| GET/DELETE | `/me/shares`, `/me/shares/:id` | F-45 |
| GET; PUT/DELETE `…/items/:itemId`; POST `…/sections/:sectionId/items`, `…/items/:itemId/move` | `/public/runs/:token` (Passwort per Header `X-Share-Password`; Bearbeiten nur bei Berechtigung „bearbeiten“) | F-40…F-44 |
| GET | `/export`, `/templates/:id/export`, `/runs/:id/export`, `/me/export` | F-50, F-52 |
| POST | `/import` (`dryRun` für Vorschau) | F-51 |
| GET/POST/DELETE | `/trash`, `/trash/:type/:id/restore`, `DELETE /trash` | F-31 |

**Entwicklungsreihenfolge (jeden Schritt einzeln beauftragen und testen):**
1. Projektgerüst, Docker, Konfiguration, Health-Endpoint, JSON-Logging ✔
2. Datenbankschema und Migrationen ✔
3. Konto: Registrierung (abschaltbar), Login, Profil, Passwort-Richtlinie, Passwort ändern/vergessen ✔
4. Vorlagen mit Unterpunkten, Verschieben, Tags mit automatischer Farbe ✔
5. Durchführungen: Mehrfach-Vorlagenauswahl, Ergänzen, Abhaken, Fortschritt ✔
6. Abschließen (= Papierkorb), Archivieren, Papierkorb mit automatischem Leeren ✔
7. Freigabelinks (inkl. öffentliche Ansicht, Geteilt-Kennzeichnung, Verwaltung im Profil) ✔
8. API-Token-Verwaltung und OpenAPI-Dokumentation ✔
9. MCP-Server (Lesen, Erstellen, Bearbeiten von Vorlagen und Durchführungen) ✔
10. Import/Export ✔
11. 2FA und SSO ✔
12. Oberfläche (Web-App): 12a Gerüst, Login, Profil ✔ – 12b Vorlagen und Tags ✔ – 12c Durchführungen, Archiv, Papierkorb, Teilen ✔
13. i18n (DE/EN), Dark Mode, Barrierefreiheit (Stichprobe mit Prüfwerkzeug; DE/EN und Dark Mode entstehen bereits laufend in 12a–12c) ✔
14. Sicherheits- und Mandantentests, Playwright-Hauptabläufe, Betriebs- und Benutzerdoku abschließen (Doku wird bereits ab Schritt 7 laufend gepflegt, N-11) ✔
15. Offline/PWA mit Synchronisierung ✔ (bewusst zuletzt umgesetzt)

## 8. Gelöste Lücken des Mendix-Originals

| ID | Lücke im Original | Lösung hier |
|---|---|---|
| L-01 | Vorlage und Kopie nicht unterscheidbar, Kopien in Vorlagenliste | Getrennte Tabellen `Template` / `Run`; Startseite zeigt nur Durchführungen (F-20) |
| L-02 | Löschen hinterließ verwaiste Aufgaben | Cascade und Papierkorb (F-16, F-31) |
| L-03 | Löschen/Abschließen ohne Bestätigung | Bestätigungsdialoge (F-75) |
| L-04 | Admin-Passwort `1`, Demo-Konten | Kein Standardpasswort (N-07) |
| L-05 | Abschließen vernichtete das Ergebnis unwiderruflich | Papierkorb (F-31) und Archivieren (F-28, F-30) |
| L-06 | Keine Reihenfolge der Aufgaben | `position` und Drag-and-Drop (F-13) |
| L-07 | Keine Suche/Filter | Suche und Tag-Filter (F-11, F-20, F-21) |
| L-08 | Keine Rechtetrennung | Eigentümer-Modell, Freigabelinks (N-04, F-40…F-45) |
| L-09 | Keine Validierung | Pflichtfelder und Längen (F-75) |

## 9. Abnahmekriterien (Auszug)

1. Mit `REGISTRATION_ENABLED=false` ist kein neues Konto erstellbar (Oberfläche, API, SSO); `create-user` funktioniert.
2. Nutzer A kann keine Daten von Nutzer B abrufen (UI und API); ein API-Token wirkt nur auf eigene Daten.
3. Durchführung „Ausflug Füssen“ aus vier Vorlagen anlegen, später eine fünfte ergänzen; Änderung einer Vorlage ändert die Durchführung nicht.
4. Verschachtelte Punkte (mindestens 5 Ebenen) anlegen, verschieben, abhaken.
5. „Abschließen“ verschiebt die Durchführung in den Papierkorb; „Archivieren“ ins Archiv (Freigabelink wird widerrufen, Teilen nicht möglich); „Wieder öffnen“ aus dem Archiv möglich; das Archiv wird nie automatisch geleert.
6. Löschen oder Abschließen von Vorlage/Durchführung (auch archivierte) landet im Papierkorb, Wiederherstellen stellt den früheren Status (`aktiv`/`archiviert`) her; nach Ablauf der Aufbewahrungsdauer verschwinden Einträge automatisch.
7. Neue Tags erhalten automatisch eine Farbe, die sich von den vorhandenen am stärksten unterscheidet (Test mit 1, 5 und 20 Tags); Farbe ist änderbar.
8. Durchführungen haben keine Tags.
9. Geteilte Durchführungen sind in der Übersicht erkennbar und filterbar; im Profil lassen sich Einstellungen ändern und Freigaben zurückziehen (einzeln und alle).
10. Freigabelink: ohne Passwort, mit Passwort, widerrufen; nur ansehen vs. ansehen und bearbeiten; kein Link für archivierte Durchführungen.
11. Passwort-Reset per E-Mail; schwache/bekannte Passwörter werden abgelehnt.
12. Export und erneuter Import einer Vorlage mit Unterpunkten und Tags ergibt identische Struktur.
13. Offline abhaken und nach Wiederverbindung synchronisieren.
14. Sprache im Profil umstellen wirkt sofort und nach erneutem Login.
15. Ein MCP-Client (z. B. Claude) kann sich mit einem API-Token verbinden, Vorlagen und Durchführungen lesen, erstellen und bearbeiten; ein Lese-Token sieht keine schreibenden Werkzeuge; Löschen, Archivieren und Teilen sind nicht möglich; Cookie-Sitzungen und fremde Origins werden abgewiesen; fremde Daten sind unsichtbar.
16. `docker compose logs` zeigt Login-, Statuswechsel- und Löschereignisse als JSON-Zeilen ohne sensible Daten.

---

## TEIL B – Optionale Erweiterungen (nicht im Pflichtumfang)

| ID | Erweiterung | Nutzen |
|---|---|---|
| **O-05** | **Pflichtpunkte:** Abschließen erst möglich, wenn alle als Pflicht markierten Punkte erledigt sind. | Verbindlichkeit |
| **O-06** | **Notizen & Zeitstempel je Punkt** (wer, wann, Kommentar). | Nachvollziehbarkeit |
| **O-09** | **Zuweisung & Fälligkeit** von Durchführungen/Punkten, E-Mail-Erinnerung (SMTP). | Teamarbeit |
| **O-10** | **Wiederkehrende Durchführungen** (täglich/wöchentlich/monatlich automatisch aus Vorlagen starten). | Routineprozesse |
| **O-11** | **Anhänge/Fotos** an Punkten (Datei-Upload im Volume oder S3). | Nachweis vor Ort |
| **O-12** | **Massenimport** von Punkten durch Einfügen von Zeilen (eingerückter Text → Unterpunkte). | Schnelleres Erstellen |
| **O-18** | **Vorlagen mit anderen Nutzern teilen** (Lesen/Kopieren, Teams). | Zusammenarbeit |
| **O-19** | **Webhooks** bei Ereignissen (z. B. Durchführung archiviert). | Automatisierung |
| **O-20** | **Audit-Log in der App** (einsehbar in der Oberfläche) – bewusst zurückgestellt, bis dahin Docker-Log (F-37). | Nachvollziehbarkeit |

**Aus Version 1.0 in den Pflichtteil übernommen:** O-01 Import/Export (F-50…F-52), O-02 Teilen als Freigabelink (F-40…F-45), O-03 Historie als Archiv (F-28, F-30), O-04 Fortschritt (F-20, F-23), O-07 Unterpunkte (F-14), O-08 Tags (F-17, F-18), O-13 Offline (F-74), O-14 Dark Mode/Barrierefreiheit (F-73), O-15 SSO/2FA (F-08, F-09), O-16 Papierkorb (F-31, F-32), O-17 API-Token (F-60…F-62).

## Bewusst nicht übernommen

Sprintr-Feedback-Widget/`FeedbackModule`, Workflow-/Queue-Infrastruktur, Maps/Charts/Slider/StarRating/Badge-Widgets, native Mobile-Profile, Atlas-UI-Bibliothek, Rollen (Administrator/User) und Benutzerverwaltung durch Admin, Übersicht aktiver Sitzungen, automatisches Leeren des Archivs, Tags für Durchführungen.
