# MCP-Server: KI-Assistenten anbinden

Die App enthält einen **MCP-Server** (Model Context Protocol). Damit können KI-Assistenten wie Claude Vorlagen und Durchführungen **lesen, erstellen und bearbeiten** – zum Beispiel: „Lege aus meinen Vorlagen *Tagesausflug* und *Wandern* eine Durchführung ‚Ausflug Füssen‘ an und hake ‚Wanderschuhe‘ ab.“

- Adresse: `{APP_BASE_URL}/mcp` (Streamable HTTP, nur `POST`)
- Anmeldung: ausschließlich mit einem **API-Token** (`Authorization: Bearer ck_…`), kein Cookie
- Der Assistent handelt als der Token-Besitzer und sieht nur dessen Daten

## 1. Token anlegen

Im Profil unter *API-Token* (oder per API, siehe [api.md](api.md#api-token)):

| Recht | Wofür |
|---|---|
| **lesen** | Der Assistent darf nur nachschauen (Vorlagen, Durchführungen, Tags). Schreibende Werkzeuge werden ihm gar nicht erst angeboten. |
| **lesen+schreiben** | Zusätzlich Erstellen und Bearbeiten. |

Empfehlung: ein eigener Token pro Assistent/Gerät, so wenig Recht wie nötig, möglichst mit Ablaufdatum. Ein verlorener Token wird im Profil widerrufen.

## 2. Client einrichten

Die genaue Syntax kann je nach Client und Version abweichen; maßgeblich sind Adresse, Transport (*HTTP / Streamable HTTP*) und der Header `Authorization`.

**Claude Code (Kommandozeile)**

```bash
claude mcp add --transport http checklisten https://checklisten.example.org/mcp \
  --header "Authorization: Bearer ck_IHR_TOKEN"
```

**Konfigurationsdatei (z. B. `.mcp.json`)**

```json
{
  "mcpServers": {
    "checklisten": {
      "type": "http",
      "url": "https://checklisten.example.org/mcp",
      "headers": { "Authorization": "Bearer ck_IHR_TOKEN" }
    }
  }
}
```

**Clients, die nur lokale (stdio-)Server starten können** (z. B. manche Desktop-Anwendungen) verbinden sich über eine Brücke:

```json
{
  "mcpServers": {
    "checklisten": {
      "command": "npx",
      "args": ["mcp-remote", "https://checklisten.example.org/mcp", "--header", "Authorization: Bearer ck_IHR_TOKEN"]
    }
  }
}
```

**Testen ohne Assistent:** Der offizielle MCP Inspector (`npx @modelcontextprotocol/inspector`) verbindet sich mit Transport *Streamable HTTP*, der Adresse oben und dem Header.

## 3. Werkzeuge

### Lesen (mit jedem Token)

| Werkzeug | Zweck |
|---|---|
| `list_templates` | Vorlagen auflisten (Suche, Tag-Filter, Sortierung, Blättern) |
| `get_template` | Vorlage mit vollständigem Punktebaum und IDs |
| `list_runs` | Durchführungen auflisten (aktiv oder archiviert; Fortschritt, geteilt ja/nein) |
| `get_run` | Durchführung mit Punktebaum (`sections` enthält intern genau einen Eintrag), Abhak-Status, Fortschritt |
| `list_tags` | Tags mit Farbe und Anzahl verwendeter Vorlagen |

### Erstellen und Bearbeiten (nur Token mit Recht *lesen+schreiben*)

| Werkzeug | Zweck |
|---|---|
| `create_template` | Vorlage anlegen (Titel, Tags) – auf Wunsch gleich mit dem **ganzen Punktebaum** (`items`, bis 5 Ebenen) |
| `update_template` | Titel, Tags ändern; mit `items` wird der **gesamte Punktebaum ersetzt** (Punkt-IDs ändern sich) |
| `add_template_item` | Punkt oder Unterpunkt zu einer Vorlage hinzufügen |
| `update_template_item` | Titel eines Vorlagenpunkts ändern |
| `move_template_item` | Vorlagenpunkt verschieben (auch zwischen Ebenen) |
| `create_run` | Durchführung aus keiner, einer oder mehreren Vorlagen anlegen |
| `add_templates_to_run` | Weitere Vorlagen als Überpunkte an eine aktive Durchführung anhängen |
| `add_run_item` | Eigenen Punkt/Unterpunkt in eine Durchführung einfügen |
| `add_run_items` | Mehrere Punkte samt Unterpunkten in einem Aufruf an eine Durchführung (oder unter einen Punkt) hängen |
| `update_run` | Durchführung umbenennen |
| `update_run_item` | Punkt **abhaken** oder zurücknehmen, Titel ändern |
| `move_run_item` | Durchführungspunkt verschieben (auch auf andere Ebenen) |
| `create_tag` | Tag anlegen (Farbe wird automatisch gewählt) |
| `update_tag` | Tag umbenennen und/oder Farbe ändern |
| `delete_tag` | Tag löschen (nur die Zuordnung zu Vorlagen verschwindet; als *destruktiv* gekennzeichnet) |

### Bewusst nicht verfügbar

**Löschen von Vorlagen, Durchführungen und Punkten (nur Tags dürfen gelöscht werden), Abschließen, Archivieren, Wieder öffnen, Teilen/Freigabelinks, Import/Export sowie Konto-, Passwort- und Token-Verwaltung.** Ein Assistent kann also nichts unwiederbringlich entfernen und keine Daten nach außen freigeben. Diese Aktionen bleiben der Oberfläche vorbehalten.

## 4. Regeln und Verhalten

- **Überpunkte statt Abschnitte:** Jede Vorlage wird in einer Durchführung ein Überpunkt mit ihren Punkten darunter. Abhaken wirkt auf alle Unterpunkte; sind alle Unterpunkte erledigt, gilt der Überpunkt als erledigt (und umgekehrt). Der Fortschritt zählt nur die direkte Ebene.
- **Vorlage in Vorlage:** In `create_template`/`update_template` kann ein Punkt statt `title` ein `refTemplateId` haben (Verweis auf eine andere eigene Vorlage); Kreise werden abgelehnt (`ref_cycle`). `get_template` liefert dazu `ref` mit Name und Punktezahl.
- **Schlanke Antworten:** Schreibwerkzeuge liefern nur das Geänderte – bei Punkten den Punkt (mit `parentItemId`), bei Durchführungen Kopfdaten, Fortschritt und die Überpunkte, bei Vorlagen Kopfdaten und Punktezahl. Den vollständigen Stand liefern `get_template` und `get_run`.

- **Gleiche Regeln wie in der Oberfläche:** Jedes Werkzeug ruft intern die REST-API auf. Validierung, Mandantentrennung, Verschachtelungstiefe (max. 50), Zyklenprüfung und der Schreibschutz archivierter Durchführungen gelten unverändert.
- **Fehler** erhalten einen Fehlercode und einen Hinweis, z. B. `Fehler 409 (run_not_active). Die Durchführung ist archiviert und damit schreibgeschützt.` – der Assistent kann darauf reagieren.
- **Zustandslos:** Jede Anfrage ist unabhängig; es gibt keine Sitzungen und keinen Server-Push (`GET`/`DELETE` auf `/mcp` → `405`).
- **IDs:** Änderungen brauchen IDs. Der Assistent liest zuerst (`get_template`, `get_run`) und verwendet die dort genannten IDs.
- **Rate-Limit:** Jede MCP-Anfrage zählt einmal gegen das Limit des Tokens (`API_RATE_LIMIT_PER_MINUTE`, Standard 120); danach `429`.
- **Protokoll:** Im Docker-Log steht je Aufruf `event: "mcp_tool_call"` mit Werkzeugname, Ergebnis (ok/Fehler) und Token-ID – **ohne Inhalte** und ohne den Token.

## 5. Sicherheitshinweise

- **HTTPS verwenden:** Der Token gleicht einem Passwort. Betreiben Sie die App hinter einem Reverse Proxy mit TLS ([betrieb.md](betrieb.md)).
- **Nur mit Token:** Cookie-Sitzungen werden für `/mcp` abgelehnt. Anfragen aus Browsern mit fremdem `Origin` werden abgewiesen (Schutz vor DNS-Rebinding). Rein browserbasierte MCP-Clients von anderen Adressen funktionieren deshalb nicht.
- **Prompt-Injection:** Texte in Vorlagen und Durchführungen (auch aus geteilten Links und Importen) sind für den Assistenten Daten, können aber Anweisungen enthalten. Für Assistenten, die fremde Inhalte lesen, daher bevorzugt einen Token mit Recht *lesen* verwenden und Änderungen kontrollieren.
- **Schaden begrenzen:** Selbst ein Token mit Schreibrecht kann keine Vorlagen, Durchführungen oder Punkte löschen und nichts teilen (nur Tags lassen sich löschen). Versehentliche Änderungen lassen sich in der Oberfläche korrigieren.
