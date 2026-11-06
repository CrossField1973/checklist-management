# Benutzerhandbuch

Stand: vollständige Oberfläche (Anmeldung, Profil, Vorlagen, Checklisten, Archiv, Papierkorb, Teilen, Offline-Betrieb). Alles lässt sich auch über die [API](api.md) und den [MCP-Server](mcp.md) nutzen.

## Anmelden und Registrieren

- **Anmelden:** E-Mail und Passwort eingeben. Wurde für dein Konto die Zwei-Faktor-Anmeldung eingerichtet, erscheint danach ein zusätzliches Feld: Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen Wiederherstellungscode, falls du dein Gerät nicht hast.
- **Mit SSO anmelden:** Ist beim Betreiber ein Identitätsanbieter eingerichtet, erscheint unter dem Formular eine Schaltfläche „Mit … anmelden“.
- **Registrieren:** Nur sichtbar, wenn der Betreiber neue Konten erlaubt. Das Passwort braucht mindestens 12 Zeichen; Sonderzeichen sind nicht nötig. Ein Satz oder eine Wortfolge ist ideal. Sehr einfache oder häufige Passwörter und solche mit deiner E-Mail oder deinem Namen werden abgelehnt.
- **Passwort vergessen:** Nur sichtbar, wenn der Server E-Mails versenden kann. Du erhältst einen Link, der eine Stunde gilt und einmal verwendbar ist. Nach dem Zurücksetzen sind alle Geräte abgemeldet; eine eingerichtete Zwei-Faktor-Anmeldung bleibt bestehen.
- **Abmelden:** Schaltfläche links unten.

Wiederholte Fehlversuche sperren die Anmeldung zeitweise (die Meldung nennt die Wartezeit).

## Oberfläche

Links die Navigation (auf dem Smartphone hinter „Menü“): *Meine Checklisten*, *Vorlagen*, *Archiv*, *Papierkorb*, *Profil*. Die Seite ist für Smartphone, Tablet und Desktop ausgelegt, per Tastatur bedienbar (Sprunglink „Zum Inhalt springen“, sichtbarer Fokus) und passt sich dem hellen oder dunklen Design an.

## Vorlagen

Eine **Vorlage** ist eine wiederverwendbare Liste von Punkten (z. B. „Tagesausflug“, „Therme“, „Wohnung putzen“), die später in Checklisten kopiert wird.

### Liste
- **Suche** nach dem Titel (die Liste aktualisiert sich beim Tippen), **Filter** nach Tag (Schaltfläche erneut klicken hebt den Filter auf) und **Sortierung** (zuletzt geändert oder A–Z). Suche, Filter und Seite stehen in der Adresse und lassen sich als Lesezeichen speichern.
- Bei mehr als 20 Vorlagen wird in Seiten geblättert.
- Je Vorlage: **Bearbeiten**, **Duplizieren** (öffnet die Kopie) und **Löschen**. Gelöschte Vorlagen landen im **Papierkorb** und lassen sich dort wiederherstellen; bereits gestartete Checklisten bleiben unverändert.
- **Neue Vorlage:** Titel eingeben, die Vorlage öffnet sich sofort zum Befüllen.

### Bearbeiten
- **Details:** Titel, Beschreibung und Tags. Änderungen werden erst mit **Speichern** übernommen (ein Hinweis zeigt ungespeicherte Änderungen).
- **Punkte hinzufügen:** In das Feld unter der Liste tippen und Enter drücken – das Feld bleibt aktiv, sodass du viele Punkte hintereinander eingeben kannst. Mit **＋** an einem Punkt legst du einen **Unterpunkt** an (beliebig tief).
- **Punkt bearbeiten** (Titel, Beschreibung) und **löschen** (samt Unterpunkten, mit Rückfrage). **▾/▸** blendet Unterpunkte aus oder ein.
- **Umsortieren und verschachteln:**
  - **Mit der Maus oder per Touch:** Griff **⋮⋮** ziehen. Beim Ziehen nach rechts oder links ändert sich die Ebene (Einrücken/Ausrücken); Unterpunkte wandern mit.
  - **Mit der Tastatur:** Fokus auf den Griff, **Leertaste** zum Aufnehmen, **Pfeil auf/ab** zum Bewegen, **Leertaste** zum Ablegen, **Esc** zum Abbrechen. Screenreader kündigen jeden Schritt an.
  - **Ohne Ziehen:** an jedem Punkt die Schaltflächen **↑ ↓** (nach oben/unten unter Geschwistern) und **← →** (ausrücken/einrücken: wird letzter Unterpunkt des vorherigen Punkts bzw. rückt hinter den bisherigen Elternpunkt).
- **Exportieren:** JSON (vollständig, wieder importierbar), CSV (Komma) oder CSV für Excel (Semikolon) und Markdown (lesbar, druckbar).

### Tags
Tags markieren Vorlagen farbig (nicht Checklisten). Du legst sie im Editor oder unter **Tags verwalten** an – gib nur den Namen ein: **die Farbe wird automatisch so gewählt, dass sie sich von deinen anderen Tags gut unterscheidet.** Unter *Tags verwalten* änderst du Farbe und Namen (beim Verlassen des Felds gespeichert) oder löschst einen Tag (nur die Zuordnung zu Vorlagen verschwindet).

## Checklisten

> Früher „Durchführungen“ genannt. In API und MCP heißt die Einheit weiterhin `run`.

Eine **Checkliste** ist eine konkrete Abarbeitung, z. B. „Ausflug Füssen“. Die Startseite zeigt alle aktiven Checklisten mit Fortschritt (erledigt/gesamt). **Geteilte** Checklisten tragen ein Kennzeichen „Geteilt · …“ (mit der Berechtigung und ggf. Passwort), nicht geteilte keines.

- **Anlegen:** *Neue Checkliste*, beliebig viele Vorlagen wählen – der Titel wird aus den Vorlagen und dem Datum vorgeschlagen und lässt sich ändern. Jede Vorlage wird ein eigener **Abschnitt**, in der Reihenfolge deiner Auswahl (die Nummer am Eintrag zeigt sie). Ohne Vorlage startest du leer.
- **Abhaken:** Irgendwo auf die Zeile klicken oder tippen – wird sofort gespeichert. Die Schaltflächen ＋ (Unterpunkt) und 🗑 (löschen) erscheinen beim Darüberfahren oder Fokussieren (auf Touchgeräten immer). *Erledigte ausblenden* blendet abgehakte Punkte aus (wird gemerkt). Sind alle Punkte erledigt, erscheint ein Hinweis zum Abschließen. Am Elternpunkt steht der Fortschritt der Unterpunkte; jeder Abschnitt und die ganze Checkliste haben einen Fortschrittsbalken.
- **Ergänzen:** Eigene Punkte und Unterpunkte (＋) hinzufügen, Punkte löschen (mit Rückfrage). *Vorlagen hinzufügen* hängt weitere Vorlagen als Abschnitte an; *Eigener Abschnitt* legt einen leeren Abschnitt für Punkte an, die in keiner Vorlage stehen. Die Checkliste ist eine Kopie: spätere Änderungen an der Vorlage wirken sich nicht auf sie aus.
- **Beenden:** Zwei Wege.
  - **Abschließen:** Die Checkliste ist erledigt und wandert in den **Papierkorb** (wiederherstellbar bis zur automatischen Löschung).
  - **Archivieren:** Sie bleibt dauerhaft erhalten, ist schreibgeschützt und nicht mehr teilbar (ein Link wird beendet). Das **Archiv** wird nie automatisch geleert.

### Archiv
Unter *Archiv* findest du archivierte Checklisten (Suche möglich). **Wieder öffnen** macht sie wieder aktiv, **Löschen** verschiebt sie in den Papierkorb.

### Papierkorb
Enthält gelöschte Vorlagen und Checklisten mit Löschdatum und dem Tag der endgültigen Löschung (Aufbewahrungszeit im Profil). **Wiederherstellen** bringt einen Eintrag zurück (Checklisten in ihren früheren Zustand aktiv/archiviert), **Endgültig löschen** und **Papierkorb leeren** fragen vorher nach.

### Teilen
In einer aktiven Checkliste: **Teilen …**.

1. Zugriff wählen: *Jeder mit dem Link* oder *Link + Passwort* (mindestens 8 Zeichen), und die Berechtigung *Nur ansehen* oder *Ansehen und bearbeiten* → **Link erstellen**, Link kopieren.
2. Empfänger brauchen **kein Konto**. Mit Bearbeiten-Recht können sie Punkte abhaken, hinzufügen und löschen; die Ansicht aktualisiert sich automatisch (alle paar Sekunden).
3. Einstellungen jederzeit ändern (der Link bleibt gleich), **Neuen Link erzeugen** macht den alten sofort ungültig, **Teilen beenden** entfernt den Zugriff.

Alle Links verwaltest du gesammelt im Profil (*Geteilte Checklisten*). Links haben kein Ablaufdatum; Checklisten im Papierkorb oder Archiv sind nicht erreichbar.

## Als App installieren und offline nutzen

- **Installieren:** Im Browser (Chrome, Edge, auf dem Smartphone auch Safari über „Zum Home-Bildschirm“) die Seite als App installieren. Sie startet dann wie eine normale App.
- **Offline arbeiten:** Nach dem ersten Öffnen mit Verbindung merkt sich das Gerät deine Checklisten, Vorlagen und Tags. Ohne Verbindung (Wanderung, Keller, Flugmodus) kannst du die App öffnen, Checklisten ansehen, **Punkte abhaken** und **neue Punkte hinzufügen**. Oben erscheint „Du bist offline“ mit der Zahl der wartenden Änderungen; neue Punkte tragen den Zusatz „wartet auf Übertragung“.
- **Synchronisieren:** Sobald wieder eine Verbindung besteht, werden die Änderungen automatisch übertragen (Meldung „… wurden übertragen“). Wurde ein Punkt inzwischen gelöscht oder die Checkliste archiviert, erscheint eine Meldung mit dem Namen; diese Änderung wird verworfen. Bei gleichzeitigen Änderungen an demselben Punkt gilt die zuletzt übertragene.
- **Nur online möglich:** Löschen, Abschnitte, Vorlagen bearbeiten, Beenden/Archivieren, Teilen sowie geteilte Links (`/s/…`).
- **Datenschutz:** Die lokalen Daten liegen nur auf diesem Gerät und werden beim **Abmelden** gelöscht. Melde dich auf fremden Geräten immer ab. Noch nicht übertragene Änderungen gehen beim Abmelden verloren – vorher mit Verbindung synchronisieren.

## Profil

### Konto
Anzeigename, E-Mail-Adresse, **Sprache** (Deutsch/Englisch), **Design** (hell, dunkel oder wie das Gerät) und die Aufbewahrungszeit des **Papierkorbs** (7, 30, 90, 365 Tage oder nie). Sprache und Design gelten sofort. Zum Ändern der E-Mail-Adresse wird dein Passwort verlangt. Das Archiv wird nie automatisch geleert.

### Passwort ändern
Aktuelles Passwort und zweimal das neue eingeben. Danach werden alle anderen Geräte abgemeldet. Konten ohne Passwort (reine SSO-Konten) können über „Passwort vergessen“ eines festlegen.

### Zwei-Faktor-Anmeldung
Zusätzlicher Schutz mit einer Authenticator-App (z. B. Aegis, Google Authenticator, Microsoft Authenticator, Bitwarden, 2FAS).

1. **Einrichten** klicken und dein Passwort bestätigen.
2. QR-Code mit der App scannen (oder den Schlüssel von Hand eingeben) und den 6-stelligen Code eintragen → **Aktivieren**.
3. Es erscheinen **10 Wiederherstellungscodes**. Sie werden nur jetzt angezeigt: kopieren oder als Datei speichern und sicher aufbewahren (Passwortmanager, Ausdruck). Erst nach dem Bestätigen („Ich habe die Codes gespeichert“) lässt sich der Dialog schließen.

Jeder Wiederherstellungscode funktioniert **einmal**. Unter *Neue Wiederherstellungscodes* erzeugst du neue (die alten werden ungültig). *Deaktivieren* verlangt Passwort und einen gültigen Code. Gerät verloren? Mit einem Wiederherstellungscode anmelden und 2FA neu einrichten.

### Single Sign-on
Nur sichtbar, wenn SSO eingerichtet ist. Hier verknüpfst du dein Konto mit dem Identitätsanbieter oder löst die Verknüpfung wieder (nur möglich, wenn dein Konto ein Passwort hat).

### API-Token
Für Skripte, Automatisierung und KI-Assistenten.

- **Token erstellen:** Name, Rechte (*Nur lesen* oder *Lesen und schreiben*) und optional ein Ablaufdatum. **Der Token wird nur einmal angezeigt** – kopieren und sicher ablegen. Später sind nur Name, Anfang und Nutzung sichtbar.
- **Widerrufen:** Der Token funktioniert danach sofort nicht mehr.
- Unter *KI-Assistenten anbinden (MCP)* stehen Adresse und eine kopierbare Konfiguration. Details: [mcp.md](mcp.md).

Empfehlung: so wenig Recht wie möglich, ein Token je Gerät oder Anwendung, möglichst mit Ablaufdatum.

### Geteilte Checklisten
Alle Links, über die du Checklisten teilst: Link kopieren, Einstellungen ändern (Zugriff mit oder ohne Passwort, nur ansehen oder bearbeiten), einzeln oder alle **zurückziehen**. Zurückgezogene Links funktionieren sofort nicht mehr. Checklisten im Papierkorb sind gekennzeichnet; ihr Link ist solange unwirksam.

### Daten
- **Alle Daten exportieren** (JSON) und **Konto-Export** (DSGVO: zusätzlich Profil und Papierkorb; nie Passwörter oder Token).
- **Import:** JSON-Datei (Export-Format) oder CSV mit den Spalten *Vorlage, Ebene, Titel, Beschreibung* wählen (oder Inhalt einfügen), **Prüfen** klicken. Du siehst, was importiert würde, bzw. alle Fehler mit Zeile oder Pfad. Erst nach **Jetzt importieren** wird etwas angelegt – immer als neue Einträge, nie als Überschreibung. Format-Details: [import-export.md](import-export.md).

### Konto löschen
Löscht dein Konto mit allen Daten **unwiderruflich** (Passwortbestätigung nötig). Exportiere vorher, was du behalten möchtest.

## Fehlerbehebung

| Meldung / Situation | Was tun |
|---|---|
| „E-Mail oder Passwort ist falsch.“ | Eingaben prüfen; nach mehreren Fehlversuchen kurz warten |
| „Der Code ist falsch oder bereits verwendet.“ | Ein Code gilt nur einmal und nur 30 Sekunden: auf den nächsten Code warten; Uhrzeit von Handy und Server prüfen |
| „Zu viele Versuche“ | Die genannte Zeit warten |
| Registrieren oder „Passwort vergessen“ fehlen | Vom Betreiber der Installation abgeschaltet bzw. nicht eingerichtet |
| SSO-Fehlermeldung nach der Anmeldung | Meldungstext beachten; bei „E-Mail nicht bestätigt“ erst mit Passwort anmelden und SSO im Profil verknüpfen |
