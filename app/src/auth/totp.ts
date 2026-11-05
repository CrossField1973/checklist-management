import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP nach RFC 6238 (HMAC-SHA1, 30 Sekunden, 6 Stellen) – kompatibel mit gängigen Authenticator-Apps.
 * Bewusst ohne Fremdbibliothek: der Algorithmus ist klein und mit den Testvektoren der RFC abgesichert.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Ungültiges Base32-Zeichen");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Neues Geheimnis (160 Bit, Base32) – wie es Authenticator-Apps erwarten. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (timeMs: number) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export const totpCode = (secretBase32: string, timeMs = Date.now(), digits = DIGITS) =>
  hotp(base32Decode(secretBase32), stepOf(timeMs), digits);

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Prüft einen Code im Fenster ±1 Schritt (Uhrabweichung). Gibt den passenden Zeitschritt zurück oder null.
 * Mit `lastUsedStep` wird die Wiederverwendung eines bereits akzeptierten Codes verhindert (Replay-Schutz).
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now(), lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepOf(now);
  let match: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    // alle drei vergleichen (gleichbleibende Laufzeit); erst danach entscheiden
    if (safeEqual(hotp(secret, step), code) && (lastUsedStep === null || step > lastUsedStep)) match = step;
  }
  return match;
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
