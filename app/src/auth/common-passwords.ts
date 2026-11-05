/**
 * Kleine lokale Liste häufiger Passwörter (normalisiert: Kleinschreibung, ohne Leerzeichen und . _ -).
 * Wegen der Mindestlänge von 12 Zeichen sind nur lange, häufige Muster relevant.
 * Für stärkeren Schutz PASSWORD_BREACH_CHECK=hibp verwenden.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password1234", "password12345", "password123456", "passwort1234", "passwort12345", "passwort123456",
  "passwordpassword", "passwortpasswort", "123456789012", "1234567890123", "12345678901234", "123456789123",
  "111111111111", "000000000000", "qwertyuiop12", "qwertzuiop12", "qwertyuiopas", "qwertzuiopue",
  "qwerty123456", "qwertz123456", "iloveyou1234", "ichliebedich", "ichliebedich1", "welcome12345",
  "willkommen123", "administrator", "administrator1", "administrator123", "changeme1234", "changemenow",
  "letmein12345", "letmeinletmein", "trustno1trustno1", "abc123abc123", "abcdefghijkl", "monkey123456",
  "football12345", "fussball12345", "sunshine1234", "princess1234", "dragon123456", "master123456",
  "superman1234", "baseball1234", "whatever1234", "starwars1234", "pokemon12345", "internet1234",
  "computer1234", "hallo123456", "hallowelt1234", "geheim123456", "geheimgeheim", "sommer123456",
  "winter123456", "frühling2024", "sommer2024", "winter2024", "passw0rd1234", "p@ssw0rd1234",
  "p@ssword1234", "password!123", "secretsecret", "mysecretpassword", "meinpasswort", "meinpasswort1",
  "meinpasswort123", "correcthorsebatterystaple",
]);
