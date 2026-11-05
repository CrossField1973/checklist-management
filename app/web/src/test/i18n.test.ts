import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "../i18n/de.json";
import en from "../i18n/en.json";

type Tree = { [k: string]: string | Tree };
const flatten = (o: Tree, prefix = ""): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
    if (typeof v === "string") acc[prefix + k] = v;
    else Object.assign(acc, flatten(v, `${prefix}${k}.`));
    return acc;
  }, {});

const DE = flatten(de as Tree);
const EN = flatten(en as Tree);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "test" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("Übersetzungen", () => {
  it("Deutsch und Englisch haben genau dieselben Schlüssel", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(DE).sort());
  });

  it("enthalten keine leeren Texte", () => {
    for (const [k, v] of [...Object.entries(DE), ...Object.entries(EN)]) expect(v.trim(), k).not.toBe("");
  });

  it("verwenden in beiden Sprachen dieselben Platzhalter ({{name}} …)", () => {
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
    for (const k of Object.keys(DE)) expect(vars(EN[k]!), k).toEqual(vars(DE[k]!));
  });

  it("decken jeden im Code verwendeten Schlüssel ab (kein Tippfehler, keine fehlende Übersetzung)", () => {
    const files = walk(join(__dirname, ".."));
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:\bt\(|titleKey=|key: )"([a-zA-Z0-9_.]+)"/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(100);
    const missing = [...used].filter((k) => !(k in DE) && !(`${k}_one` in DE && `${k}_other` in DE));
    expect(missing).toEqual([]);
  });

  it("enthalten für jede bekannte Fehlermeldung des Servers einen Text", () => {
    const codes = ["invalid_credentials", "invalid_code", "invalid_current_password", "too_many_attempts", "email_taken", "registration_disabled", "password_policy", "already_enabled", "not_enabled", "setup_required", "password_required", "invalid_expiry", "too_many_tokens", "import_invalid", "invalid_or_expired_token", "not_found", "session_required", "unauthorized", "validation_error", "rate_limited", "run_not_active", "sso_denied", "sso_failed", "sso_flow_expired", "sso_unavailable", "sso_email_missing", "sso_email_not_verified", "sso_already_linked", "network_error"];
    for (const c of codes) expect(DE[`errors.${c}`], c).toBeTruthy();
    for (const p of ["too_short", "too_long", "too_common", "contains_identity", "breached"]) expect(DE[`errors.policy.${p}`], p).toBeTruthy();
  });
});
