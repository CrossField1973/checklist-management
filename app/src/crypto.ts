import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Symmetrische Verschlüsselung (AES-256-GCM) für Werte, die später wieder lesbar sein müssen,
 * z. B. Freigabe-Token (damit „Link kopieren“ funktioniert) und später das TOTP-Secret.
 * Der Schlüssel wird je Verwendungszweck aus SESSION_SECRET abgeleitet.
 */
const key = (secret: string, purpose: string) => createHash("sha256").update(`${purpose}:${secret}`).digest();

export function encrypt(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** Liefert null, wenn der Wert manipuliert wurde oder mit einem anderen Schlüssel verschlüsselt ist. */
export function decrypt(value: string, secret: string, purpose: string): string | null {
  try {
    const [iv, tag, data] = value.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(secret, purpose), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
