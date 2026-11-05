# Betrieb

## Voraussetzungen

- Docker mit Docker Compose
- Eine Domain mit HTTPS über einen Reverse Proxy (empfohlen: Caddy oder Traefik)

## Installation

```bash
cd app
cp .env.example .env
```

In `.env` mindestens setzen:

| Variable | Bedeutung |
|---|---|
| `APP_BASE_URL` | Öffentliche Adresse, z. B. `https://checklisten.example.org`. Wird für Links in E-Mails und Freigabelinks verwendet. |
| `SESSION_SECRET` | Zufälliger Wert, mind. 32 Zeichen (`openssl rand -hex 32`). **Nicht ändern**, sonst werden Freigabelinks in der Verwaltung nicht mehr angezeigt und alle Sitzungen ungültig. |

Starten:

```bash
docker compose up -d --build
docker compose ps          # Status "healthy" abwarten
```

Die App lauscht auf Port 3000 und liefert die **Weboberfläche** (<http://localhost:3000>), die API (`/api/v1`), die API-Doku (`/api/docs`) und den MCP-Server (`/mcp`) aus – alles aus einem Container. Das Image baut die Oberfläche selbst (mehrstufiger Build, Node ist nur dafür nötig). Die Datenbank liegt im Volume `app-data` (`/data/app.db`).

## Konfiguration

Alle Einstellungen erfolgen über Umgebungsvariablen in `.env`.

Die API-Dokumentation (Swagger) ist nach dem Start unter `http://<Adresse>/api/docs` erreichbar. Wer sie nicht öffentlich anbieten möchte, sperrt `/api/docs` und `/api/openapi.json` im Reverse Proxy.

Einstellungen:

| Variable | Bedeutung | Standard |
|---|---|---|
| `REGISTRATION_ENABLED` | `false` = neue Nutzer können sich nicht selbst registrieren (siehe „Nutzer anlegen“) | `true` |
| `DEFAULT_LANGUAGE` | Sprache für neue Nutzer: `de` oder `en` | `de` |
| `TRASH_RETENTION_DAYS` | Papierkorb-Aufbewahrung für neue Nutzer in Tagen, `0` = nie (jeder Nutzer kann das im Profil ändern) | `30` |
| `PASSWORD_BREACH_CHECK` | Prüfung auf bekannte Passwörter: `local`, `hibp` (Online-Abfrage mit k-Anonymität), `off` | `local` |
| `API_RATE_LIMIT_PER_MINUTE` | Anfragen pro Minute und API-Token (danach `429`) | `120` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` | Mailserver. Ohne `SMTP_HOST` und `SMTP_FROM` ist „Passwort vergessen“ ausgeschaltet. | leer |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Anmeldung per OpenID Connect, Einrichtung siehe [anmeldung.md](anmeldung.md) | leer |
| `OIDC_NAME`, `OIDC_SCOPES` | Beschriftung der SSO-Schaltfläche; angeforderte Scopes | `SSO`, `openid email profile` |

Nach Änderungen: `docker compose up -d`.

## Nutzer anlegen

Bei `REGISTRATION_ENABLED=false` legt man Nutzer per Kommandozeile an – das funktioniert immer:

```bash
docker compose exec app create-user anna@example.org "Anna Muster"
```

Wird `CREATE_USER_PASSWORD` mitgegeben, gilt dieses Passwort, sonst wird ein zufälliges erzeugt und einmalig ausgegeben:

```bash
docker compose exec -e CREATE_USER_PASSWORD='mein-langes-passwort' app create-user anna@example.org
```

Passwörter müssen mindestens 12 Zeichen lang sein und dürfen nicht trivial, häufig oder aus E-Mail/Namen abgeleitet sein.

## Offline-Betrieb (PWA)

Installierbarkeit und Offline-Betrieb benötigen **HTTPS** (Ausnahme: `localhost`), denn Browser erlauben Service Worker nur über sichere Verbindungen. Der Server liefert `sw.js` und das Manifest ohne Zwischenspeicher aus; nach einem Update lädt der Browser die neue Version beim nächsten Besuch. Es werden keine Daten serverseitig für Offline-Nutzer vorgehalten – die lokalen Kopien entstehen im Browser des jeweiligen Nutzers.

## HTTPS mit Caddy (Beispiel)

```
checklisten.example.org {
    reverse_proxy localhost:3000
}
```

Die App vertraut den `X-Forwarded-*`-Headern des Proxys. Bei einer `https://`-URL in `APP_BASE_URL` werden Cookies mit `Secure` gesetzt.

## Sicherheits-Header

Der Server setzt für alle Antworten `Content-Security-Policy` (nur eigene Skripte und Stile, keine Einbettung in fremde Seiten), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` und – bei einer `https://`-Adresse in `APP_BASE_URL` – `Strict-Transport-Security`. Ein Reverse Proxy darf diese Header ergänzen, sollte sie aber nicht entfernen. Die Swagger-Seite `/api/docs` hat keine CSP (eigene Skripte).

## Backup und Wiederherstellung

Alle Daten stehen in einer SQLite-Datei im Volume `app-data`.

**Sicherung** (konsistent, auch im laufenden Betrieb):

```bash
docker compose exec app node -e "const D=require('better-sqlite3');new D('/data/app.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp app:/data/backup.db ./backup-$(date +%F).db
docker compose exec app rm /data/backup.db
```

**Wiederherstellung:**

```bash
docker compose down
docker run --rm -v app_app-data:/data -v "$PWD":/in alpine cp /in/backup-2026-11-05.db /data/app.db
docker compose up -d
```

(Der Volume-Name hängt vom Ordnernamen ab; mit `docker volume ls` prüfen.)

**Logische Sicherung einzelner Nutzer:** Jeder Nutzer kann seine Daten per JSON-Export sichern und auf einer anderen Installation wieder importieren ([import-export.md](import-export.md)). Das ersetzt nicht die Sicherung der Datenbank (enthält auch Nutzer, Token, Freigabelinks).

## Update

```bash
git pull            # bzw. neue Version bereitstellen
docker compose up -d --build
```

Datenbankänderungen (Migrationen) werden beim Start automatisch angewendet. Vorher eine Sicherung anlegen.

## Logs

Die App schreibt strukturierte JSON-Zeilen auf stdout:

```bash
docker compose logs -f app
```

Protokolliert werden u. a. Anmeldungen und Fehlversuche, Passwortänderungen, Anlegen/Löschen/Wiederherstellen von Vorlagen und Durchführungen, Archivieren, Freigabelinks (angelegt, geändert, widerrufen, aufgerufen, Änderungen über den Link), API-Token (angelegt, widerrufen, verwendet, abgelehnt), 2FA (aktiviert, deaktiviert, fehlgeschlagen, Wiederherstellungscode verwendet), SSO (Login, Verknüpfung, Konto angelegt, Fehler) und die stündlichen Aufräumläufe. Passwörter, Token und Inhalte werden **nicht** protokolliert.

Beispiel (mit `jq`): alle Fehlversuche beim Login

```bash
docker compose logs app --no-log-prefix | jq -c 'select(.event=="login_failed")'
```

## Hintergrundjobs

Beim Start und danach stündlich werden Papierkorb-Einträge gelöscht, die älter als die Aufbewahrungsdauer des jeweiligen Nutzers sind, sowie abgelaufene Passwort-Reset-Links. Das Archiv wird nie automatisch geleert.

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Container startet nicht, Log zeigt „Ungültige Konfiguration“ | `APP_BASE_URL` fehlt/ungültig oder `SESSION_SECRET` kürzer als 32 Zeichen |
| „Passwort vergessen“ fehlt in der Oberfläche | SMTP ist nicht konfiguriert (`SMTP_HOST`, `SMTP_FROM`) |
| Registrierung nicht möglich (403) | `REGISTRATION_ENABLED=false` – Nutzer per `create-user` anlegen |
| Anmeldung meldet `two_factor_required` | Für das Konto ist 2FA aktiv: Authenticator- oder Wiederherstellungscode mitsenden ([anmeldung.md](anmeldung.md)); Codes stimmen nicht → Uhrzeit von Server und Handy prüfen |
| SSO: `sso_failed` / „invalid issuer“ | `OIDC_ISSUER` muss exakt dem `issuer` der Discovery-Datei entsprechen; Redirect-URI beim Anbieter prüfen; Logzeile `sso_failed` nennt den Grund |
| Nach „zu vielen Versuchen“ kein Login möglich | Vorübergehende Sperre (1–15 Minuten); wird bei Neustart des Containers zurückgesetzt |
| Freigabelink zeigt „nicht gefunden“ | Link wurde widerrufen, die Durchführung ist archiviert oder im Papierkorb |
| Image lässt sich nicht bauen („node-gyp“) | Das `Dockerfile` installiert mit `--ignore-scripts`, weil die Datenbank-Bibliothek fertige Binärdateien mitbringt; ältere Dockerfile-Fassungen kompilierten fälschlich |
