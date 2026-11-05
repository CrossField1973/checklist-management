# Anmeldung: Zwei-Faktor (2FA) und Single Sign-on (SSO)

Neben E-Mail und Passwort bietet die App zwei zusätzliche Wege: **Zwei-Faktor-Authentifizierung** per Authenticator-App und **Anmeldung über einen Identitätsanbieter** (OpenID Connect). Beides ist optional. Die Oberfläche folgt in Schritt 12; die Abläufe unten gelten für die REST-API.

## Zwei-Faktor-Authentifizierung (TOTP)

Kompatibel mit gängigen Authenticator-Apps (Google Authenticator, Microsoft Authenticator, Aegis, 2FAS, Bitwarden, 1Password …): zeitbasierte 6-stellige Codes nach RFC 6238 (SHA-1, 30 Sekunden). Die Umsetzung wurde mit den Testvektoren der RFC und gegen eine unabhängige Implementierung geprüft.

### Einrichten (nur mit Browser-Sitzung)

1. `POST /api/v1/me/2fa/setup` mit `{ "password": "…" }` (das Passwort ist nötig, falls das Konto eines hat) → Antwort `secret` und `otpauthUrl`. Die URL wird als **QR-Code** in der Authenticator-App gescannt, alternativ das `secret` von Hand eingeben. 2FA ist jetzt noch **nicht** aktiv.
2. `POST /api/v1/me/2fa/enable` mit `{ "code": "123456" }` (Code aus der App) → 2FA ist aktiv. Die Antwort enthält **einmalig 10 Wiederherstellungscodes** (Format `ABCDE-FGHJK`). Alle anderen Sitzungen des Kontos werden beendet.

Die Wiederherstellungscodes gehören an einen sicheren Ort (Passwortmanager, Ausdruck). Jeder Code funktioniert **einmal**.

### Anmelden mit 2FA

`POST /api/v1/auth/login` mit E-Mail, Passwort und `code`:

```json
{ "email": "anna@example.org", "password": "…", "code": "123456" }
```

- Ohne `code` antwortet der Server `401 two_factor_required` (das Passwort war richtig) – der Client fragt den Code ab und sendet die Anfrage erneut. Es wird dann **keine** Sitzung angelegt.
- Falscher Code: `401 invalid_code`. Nach 5 Fehlversuchen wird die Anmeldung für dieses Konto zeitweise gesperrt (`429`, `Retry-After`).
- `code` ist entweder der 6-stellige Authenticator-Code oder ein Wiederherstellungscode (Groß-/Kleinschreibung, Bindestrich und Leerzeichen sind egal). Bei Verwendung eines Wiederherstellungscodes nennt die Antwort `recoveryCodesRemaining`.
- Ein Authenticator-Code ist **nur einmal** verwendbar (Schutz vor Mitlesen und Wiederverwenden). Zwei Anmeldungen innerhalb derselben 30 Sekunden brauchen daher zwei verschiedene Codes – die zweite wartet auf den nächsten Code.
- Das Zeitfenster toleriert ±30 Sekunden Uhrabweichung. Ist die Uhr des Servers oder Handys weiter daneben, schlagen Codes fehl.

### Verwalten

| Aufruf | Zweck |
|---|---|
| `GET /api/v1/me/2fa` | Status: aktiv, Einrichtung offen, verbleibende Wiederherstellungscodes |
| `POST /api/v1/me/2fa/disable` | Deaktivieren: `{ password, code }` (Code: Authenticator oder Wiederherstellungscode) |
| `POST /api/v1/me/2fa/recovery-codes` | Neue Codes erzeugen: `{ password, code }`; die alten werden ungültig |

### Gut zu wissen

- **Gerät verloren:** Mit einem Wiederherstellungscode anmelden, 2FA deaktivieren (oder neu einrichten). Sind weder Gerät noch Codes verfügbar, kann ein Betreiber mit Datenbankzugriff 2FA zurücksetzen: `UPDATE users SET totp_secret=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE email='…'; DELETE FROM recovery_codes WHERE user_id=(SELECT id FROM users WHERE email='…');` (vorher sichern, [betrieb.md](betrieb.md)).
- **Passwort vergessen** setzt 2FA nicht zurück: Nach dem Zurücksetzen wird weiterhin der zweite Faktor verlangt.
- **API-Token** (Skripte, MCP) sind von 2FA nicht betroffen, sie sind eigene, widerrufbare Zugangsdaten. Token verwalten kann man nur mit Browser-Sitzung (und damit mit 2FA).
- Das Geheimnis liegt verschlüsselt (AES-256-GCM, Schlüssel aus `SESSION_SECRET`), die Wiederherstellungscodes nur als HMAC. **`SESSION_SECRET` nicht ändern** – sonst sind gespeicherte 2FA-Geheimnisse unlesbar und Wiederherstellungscodes ungültig.
- Bei SSO-Anmeldung gilt die 2FA der App nicht; dort entscheidet der Identitätsanbieter (siehe unten).

## Single Sign-on (OpenID Connect)

Die App unterstützt den Authorization-Code-Flow mit **PKCE (S256)**, `state` und `nonce`. Getestet wurde gegen einen Testanbieter und gegen **Dex**; gängige Anbieter wie Authentik, Keycloak, Authelia, Zitadel, Microsoft Entra ID oder Google funktionieren nach dem gleichen Muster.

### Einrichten

1. Beim Anbieter eine **OIDC-Anwendung** (Client, Typ „vertraulich“ / mit Client-Secret) anlegen. Als **Redirect-URI** eintragen:

   ```
   https://checklisten.example.org/api/v1/auth/oidc/callback
   ```

   (= `APP_BASE_URL` + `/api/v1/auth/oidc/callback`; muss exakt stimmen).
2. Der Anbieter muss die Scopes `openid email profile` und die Claims `email` und `email_verified` liefern.
3. In `.env` setzen und neu starten (`docker compose up -d`):

   | Variable | Bedeutung |
   |---|---|
   | `OIDC_ISSUER` | Aussteller-URL, z. B. `https://auth.example.org/application/o/checklisten/` – unter `<issuer>/.well-known/openid-configuration` muss die Discovery-Datei liegen. Der Wert muss **genau** dem `issuer` darin entsprechen. |
   | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Zugangsdaten des Clients |
   | `OIDC_NAME` | Beschriftung der Anmelde-Schaltfläche (Standard `SSO`) |
   | `OIDC_SCOPES` | Standard `openid email profile` |

   Ob SSO aktiv ist, steht in `GET /api/v1/config` (`oidcEnabled`, `oidcName`, `oidcLoginUrl`).

`http://`-Aussteller werden nur für lokale Entwicklung und interne Netze akzeptiert; im Betrieb bitte HTTPS verwenden.

### Ablauf

Die Oberfläche leitet auf `GET /api/v1/auth/oidc/login` weiter; nach der Anmeldung beim Anbieter kehrt der Browser zu `/api/v1/auth/oidc/callback` zurück, die App legt eine Sitzung an und leitet nach `/`. Bei Fehlern geht es nach `/login?error=<code>`:

| Code | Bedeutung |
|---|---|
| `sso_denied` | Anmeldung beim Anbieter abgebrochen/abgelehnt |
| `sso_failed` | Prüfung fehlgeschlagen (state, nonce, Signatur, Zielgruppe, Ablauf, Code verbraucht) |
| `sso_flow_expired` | Ablauf zu alt (über 10 Minuten) oder Cookie fehlt – bitte neu starten |
| `sso_unavailable` | Anbieter nicht erreichbar |
| `sso_email_missing` | Anbieter liefert keine E-Mail-Adresse |
| `sso_email_not_verified` | Konto mit dieser E-Mail existiert, der Anbieter bestätigt die Adresse aber nicht |
| `registration_disabled` | Neues Konto nötig, aber `REGISTRATION_ENABLED=false` |
| `sso_already_linked` | Diese Identität gehört schon zu einem anderen Konto |

### Wie Konten zugeordnet werden

1. **Bekannte Identität** (Anbieter + `sub`) → Anmeldung an dem verknüpften Konto, auch wenn sich E-Mail oder Name beim Anbieter ändern.
2. **Sonst Konto mit gleicher E-Mail:** Nur wenn der Anbieter die Adresse als **bestätigt** meldet (`email_verified: true`), wird verknüpft und angemeldet. Das verhindert, dass jemand mit einer unbestätigten Fremdadresse ein bestehendes Konto übernimmt.
3. **Sonst neues Konto** (ohne Passwort), Name aus `name`, `preferred_username` oder der E-Mail – **nur wenn `REGISTRATION_ENABLED=true`**. Bei `false` können sich ausschließlich vorhandene Nutzer per SSO anmelden (Konten legt man mit `create-user` an, siehe [betrieb.md](betrieb.md)).

### Im Profil

| Aufruf | Zweck |
|---|---|
| `GET /api/v1/me/sso` | Ist SSO aktiv, ist das Konto verknüpft? |
| `GET /api/v1/auth/oidc/login?link=1` (angemeldet) | Aktuelles Konto bewusst mit dem SSO-Konto verknüpfen, unabhängig von der E-Mail beim Anbieter |
| `POST /api/v1/me/sso/unlink` mit `{ password }` | Verknüpfung lösen – nur möglich, wenn das Konto ein Passwort hat (sonst wäre man ausgesperrt) |

### Sicherheitshinweise

- Zustand des Ablaufs (state, nonce, PKCE-Verifier) liegt verschlüsselt in einem 10-Minuten-Cookie (`HttpOnly`, `SameSite=Lax`, nur für den SSO-Pfad); Codes sind nur einmal verwendbar.
- Autorisierungscode und `state` stehen nicht im Log (die URL wird maskiert).
- Die Redirect-URI wird aus `APP_BASE_URL` gebildet, nie aus dem Host-Header der Anfrage.
- Wer SSO nutzt, vertraut dem Anbieter: Er bestimmt, wer sich anmelden darf. Für geschlossene Gruppen die Anwendung beim Anbieter auf bestimmte Nutzer/Gruppen beschränken oder `REGISTRATION_ENABLED=false` setzen.
