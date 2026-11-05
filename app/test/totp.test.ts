import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, stepOf, totpCode, verifyTotp } from "../src/auth/totp.js";
import { generateRecoveryCodes, normalizeRecoveryCode } from "../src/auth/two-factor.js";

// Testvektoren aus RFC 6238, Anhang B (SHA-1, Geheimnis „12345678901234567890“); 6 Stellen = letzte 6 der 8-stelligen Werte
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [number, string, string][] = [
  [59, "94287082", "287082"],
  [1111111109, "07081804", "081804"],
  [1111111111, "14050471", "050471"],
  [1234567890, "89005924", "005924"],
  [2000000000, "69279037", "279037"],
  [20000000000, "65353130", "353130"],
];

describe("TOTP (RFC 6238)", () => {
  it("erzeugt die Codes der RFC-Testvektoren (8 und 6 Stellen)", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    for (const [t, eight, six] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, t * 1000, 8), `t=${t}`).toBe(eight);
      expect(totpCode(RFC_SECRET, t * 1000), `t=${t}`).toBe(six);
    }
  });

  it("Base32 ist umkehrbar und tolerant gegenüber Leerzeichen, Bindestrichen und Kleinschreibung", () => {
    for (const len of [0, 1, 4, 5, 10, 20, 33]) {
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(base32Decode("gezd gnbv-gy3t").equals(base32Decode("GEZDGNBVGY3T"))).toBe(true);
    expect(() => base32Decode("ABC1")).toThrow();
  });

  it("erzeugt zufällige 160-Bit-Geheimnisse (32 Base32-Zeichen)", () => {
    const secrets = new Set(Array.from({ length: 20 }, generateTotpSecret));
    expect(secrets.size).toBe(20);
    for (const s of secrets) expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("akzeptiert den aktuellen sowie den vorigen und nächsten Zeitschritt, aber keinen weiter entfernten", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const at = (offsetSteps: number) => totpCode(secret, now + offsetSteps * 30_000);
    expect(verifyTotp(secret, at(0), now)).toBe(stepOf(now));
    expect(verifyTotp(secret, at(-1), now)).toBe(stepOf(now) - 1);
    expect(verifyTotp(secret, at(1), now)).toBe(stepOf(now) + 1);
    expect(verifyTotp(secret, at(-2), now)).toBeNull();
    expect(verifyTotp(secret, at(2), now)).toBeNull();
  });

  it("verhindert Wiederverwendung: Schritte bis zum zuletzt akzeptierten werden abgelehnt (Replay-Schutz)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, now, step - 1)).toBe(step);
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, code, now, step + 1)).toBeNull();
    // ein neuerer Schritt bleibt erlaubt
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now, step)).toBe(step + 1);
  });

  it("lehnt falsche Formate und falsche Geheimnisse ab", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345", "１２３４５６"]) expect(verifyTotp(secret, bad, now), bad).toBeNull();
    expect(verifyTotp(generateTotpSecret(), totpCode(secret, now), now)).toBeNull();
  });

  it("baut die otpauth-URL für Authenticator-Apps", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "anna@example.org", "Checklisten"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/Checklisten:anna@example.org");
    expect(Object.fromEntries(url.searchParams)).toEqual({ secret: "JBSWY3DPEHPK3PXP", issuer: "Checklisten", algorithm: "SHA1", digits: "6", period: "30" });
  });
});

describe("Wiederherstellungscodes", () => {
  it("erzeugt 10 eindeutige Codes im Format XXXXX-XXXXX ohne verwechselbare Zeichen", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
  });

  it("normalisiert Eingaben (Groß-/Kleinschreibung, Bindestrich, Leerzeichen)", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode(" abcde fghjk ")).toBe("ABCDEFGHJK");
  });
});
