# Import und Export

Daten lassen sich als **JSON** (vollständig), **CSV** (tabellarisch) und **Markdown** (lesbar/druckbar) exportieren; importiert werden **JSON** und **CSV**. Alle Funktionen stehen in der REST-API ([api.md](api.md), `/api/docs`); die Oberfläche folgt in Schritt 12.

Grundregeln:
- **Import legt immer neue Datensätze an.** Nichts wird überschrieben oder zusammengeführt. Wer dieselbe Datei zweimal importiert, erhält die Daten doppelt.
- **Alles oder nichts:** Enthält die Datei Fehler, wird nichts angelegt.
- **Vorschau zuerst:** Mit `"dryRun": true` wird nur geprüft; die Antwort nennt Fehler je Zeile bzw. Pfad und zeigt, was importiert würde.
- Export und Import betreffen nur die eigenen Daten. Freigabelinks, Passwörter, API-Token und IDs sind nie enthalten.
- Der MCP-Server bietet weder Import noch Export an.

## Export

| Was | Aufruf | Formate |
|---|---|---|
| Alle eigenen Daten (ohne Papierkorb) | `GET /api/v1/export` (`?scope=templates` = nur Vorlagen, so nutzt es das Profil) | JSON |
| Eine Vorlage | `GET /api/v1/templates/{id}/export?format=…` | `json`, `csv`, `md` |
| Eine Checkliste | `GET /api/v1/runs/{id}/export?format=…` | `json`, `csv`, `md` |

Bei CSV wählt `delimiter=comma|semicolon|tab` das Trennzeichen (**Excel in Deutschland: `semicolon`**). Die Dateien sind UTF-8 mit BOM, damit Umlaute richtig erscheinen. Die Antwort ist ein Download (`Content-Disposition`), der Dateiname wird aus dem Titel gebildet (nur `a–z`, `0–9`, `-`).

Einen eigenen Konto-Export gibt es nicht mehr. Das Löschen des Kontos entfernt alle Daten endgültig (`DELETE /api/v1/me`).

**Import:** `POST /api/v1/import` mit `templatesOnly: true` ignoriert Checklisten in der Datei (mit Warnung) und legt nur Vorlagen an – so importiert das Profil. Ohne das Flag werden auch Checklisten importiert.

### Vorlagen als CSV

```
Vorlage;Ebene;Titel
Tagesausflug;1;Rucksack
Tagesausflug;2;Sonnencreme
Tagesausflug;2;Regenjacke
Tagesausflug;1;Route prüfen
```

### Checklisten als CSV

`Abschnitt;Ebene;Titel;Erledigt;Erledigt am` – „Erledigt“ ist `ja`/`nein`, „Erledigt am“ ein ISO-Zeitpunkt. (Eine Checkliste hat intern einen Abschnitt, dessen Titel die Spalte „Abschnitt“ füllt. Checklisten lassen sich als CSV nur exportieren, nicht importieren; dafür gibt es JSON.)

### Markdown

```markdown
# Tagesausflug

Für unterwegs

Tags: Outdoor, Reisen

- Rucksack – Wetterfest, 30 l
  - Sonnencreme
  - Regenjacke
- Route prüfen
```

Checklisten erscheinen als verschachtelte Liste mit Kontrollkästchen (Überschriften nur bei mehreren Abschnitten, z. B. importierten) (`- [x]` erledigt, `- [ ]` offen).

### Schutz vor Formel-Injektion

Beginnt eine CSV-Zelle mit `=`, `+`, `-`, `@` oder einem Tabulator, setzt der Export ein `'` davor, damit Excel & Co. sie nicht als Formel ausführen. Der Import entfernt dieses `'` wieder (nur in diesen Fällen), der Round-Trip bleibt also verlustfrei.

## Import

`POST /api/v1/import` (Anmeldung per Sitzung oder API-Token mit Recht *lesen+schreiben*)

```json
{ "format": "json", "content": { … }, "dryRun": true }
{ "format": "csv",  "content": "Vorlage;Ebene;Titel\n…", "title": "Optional", "dryRun": false }
```

| Feld | Bedeutung |
|---|---|
| `format` | `json` oder `csv` |
| `content` | JSON: Text oder Objekt im Export-Format · CSV: Text |
| `title` | nur CSV ohne Spalte „Vorlage“: Name der Vorlage, in die alle Zeilen kommen |
| `dryRun` | `true` = nur prüfen, nichts anlegen |

**Antworten:**
- `dryRun: true` → `200 { valid, issues, warnings, counts, preview }`. Bei Fehlern `valid: false` mit `issues`, ohne `preview`.
- Import erfolgreich → `201 { result: { templates, runs, items, tagsCreated, tagsReused }, warnings }`.
- Fehler → `422 { error: "import_invalid", issues: [{ path, message }] }`, es wurde nichts angelegt.
- Zu groß (über 12 MB) → `413`.

`preview` enthält je Vorlage Titel, Punktezahl, Tags und die obersten Punkte, je Checkliste Titel, Status, Abschnitte und Fortschritt sowie, welche Tags neu angelegt und welche wiederverwendet werden.

**Grenzen:** 2000 Vorlagen, 2000 Checklisten, 500 Tags, 50 000 Punkte pro Import, Verschachtelung bis 50 Ebenen, Titel bis 200 Zeichen.

### JSON (Round-Trip)

Das Format ist das des Exports (`format: "checklisten-export"`, `version: 1`). Alle Teile sind optional; mindestens eine Vorlage oder Checkliste muss enthalten sein.

```json
{
  "format": "checklisten-export",
  "version": 1,
  "tags": [{ "name": "Reisen", "color": "#2563eb" }],
  "templates": [
    {
      "title": "Tagesausflug",
      "tags": ["Reisen"],
      "items": [
        { "title": "Rucksack", "children": [{ "title": "Sonnencreme" }] },
        { "title": "Route prüfen" }
      ]
    }
  ],
  "runs": [
    {
      "title": "Ausflug Füssen",
      "status": "active",
      "sections": [
        { "title": "Tagesausflug", "items": [{ "title": "Rucksack", "isChecked": true, "checkedAt": "2026-11-05T09:30:00Z" }] }
      ]
    }
  ]
}
```

- **Tags:** Namen werden ohne Beachtung der Groß-/Kleinschreibung mit vorhandenen Tags abgeglichen (vorhandene bleiben unverändert). Unbekannte Tags werden angelegt – mit der angegebenen Farbe (`#RRGGBB`) oder automatisch gewählter, gut unterscheidbarer Farbe.
- **Checklisten:** `status` ist `active` (Standard) oder `archived`. Abgehakte Punkte ohne `checkedAt` erhalten den Importzeitpunkt. Der Bezug auf die Quellvorlage geht verloren (der Abschnitt bleibt eine eigenständige Kopie).

### CSV

Erwartet werden die Spalten **Vorlage**, **Ebene**, **Titel** (Kopfzeile nötig, Reihenfolge beliebig). Trennzeichen (Komma, Semikolon, Tab), BOM, Anführungszeichen und Zeilenumbrüche in Feldern werden erkannt. Zusätzliche Spalten werden ignoriert (Hinweis in `warnings`).

- **Ebene** (1, 2, 3 …) bestimmt zusammen mit der Zeilenreihenfolge die Verschachtelung: Ebene 2 gehört zum letzten Punkt der Ebene 1 derselben Vorlage. Fehlt die Spalte, ist alles Ebene 1.
- Zeilen mit demselben **Vorlage**-Namen bilden eine Vorlage; unterschiedliche Namen erzeugen mehrere Vorlagen in einer Datei.
- Fehlt die Spalte *Vorlage*, geben Sie `title` an.
- Alternative Spaltennamen werden erkannt, u. a.: Vorlage = `Template`, `Checkliste`, `Checklist`, `Liste`; Titel = `Title`, `Name`, `Aufgabe`, `Task`; Ebene = `Level`, `Stufe`.

**Fehlermeldungen** nennen die Zeile der Datei (Kopfzeile = Zeile 1), z. B. `Zeile 4: Ebene springt von 1 auf 3 (es fehlt ein übergeordneter Punkt in „Packliste“)`, `Zeile 7: Titel fehlt`, `Zeile 9: Ebene „x“ ist keine ganze Zahl ≥ 1`.

## Migration aus der Mendix-App

Die Mendix-App kennt je Aufgabe *Name*, *Beschreibung* und „abgehakt“; importiert wird nur der Name (weitere Spalten werden ignoriert). Ein Weg ohne Zugriff auf die Mendix-Datenbank:

1. In der Mendix-App die Checkliste öffnen (*Edit Checklist*) und die Tabelle der Aufgaben über „Export“ als Excel-Datei exportieren.
2. In Excel nur die Spalte **Name** behalten und als *CSV (UTF-8)* speichern. Mehrere Checklisten können in einer Datei stehen, wenn eine Spalte **Checkliste** (Name der Checkliste) ergänzt wird.
3. **Vorschau** mit `dryRun: true` ausführen, Fehler beheben, dann importieren. Bei einer Datei ohne Checklisten-Spalte den Vorlagennamen als `title` angeben.
4. In der Mendix-App sind Vorlagen und laufende „Checks“ (Kopien) nicht unterschieden: Kopien nicht mit importieren oder danach als Checklisten/Vorlagen aufräumen.

Der Abhak-Status der Mendix-Aufgaben wird bewusst nicht übernommen (Vorlagen werden nicht abgehakt).

## Datensicherung

Der JSON-Export (`GET /api/v1/export`) ist eine **logische Sicherung** der eigenen Daten und eignet sich zum Umziehen auf eine andere Installation. Für eine vollständige Sicherung der gesamten Installation (alle Nutzer, Token, Freigabelinks) siehe [betrieb.md](betrieb.md#backup-und-wiederherstellung).
