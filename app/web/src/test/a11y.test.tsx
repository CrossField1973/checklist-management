import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { apiError, mockApi, renderApp } from "./harness";

/** Automatische Stichprobe (axe-core, WCAG 2.x A/AA). Farbkontraste prüft jsdom nicht – dafür der Test darunter. */
async function violations() {
  const res = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return res.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const expectClean = async () => expect(await violations()).toEqual([]);

const tree = [{ id: "i1", title: "Rucksack", position: 0, children: [{ id: "i2", title: "Regenjacke", position: 0, children: [] }] }];
const runItem = (id: string, title: string, checked = false, children: any[] = []) => ({ id, title, position: 0, isChecked: checked, checkedAt: null, childProgress: { done: 0, total: children.length }, children });
const run = { id: "r1", title: "Ausflug", status: "active", createdAt: 1, updatedAt: 1, archivedAt: null, share: { access: "password", permission: "edit" }, progress: { done: 1, total: 2 },
  sections: [{ id: "s1", title: "Ausflug", position: 0, sourceTemplateId: null, progress: { done: 1, total: 2 }, items: [runItem("a", "Rucksack", true), runItem("b", "Proviant", false, [runItem("c", "Brot")])] }] };
const tags = [{ id: "g1", name: "Reisen", color: "#2563eb", textColor: "#ffffff", templateCount: 1 }];
const tpl = { id: "t1", title: "Tagesausflug", tags, itemCount: 2, createdAt: 1, updatedAt: 1 };

function api() {
  const a = mockApi();
  a.on("GET /runs", () => ({ body: { total: 1, runs: [{ ...run, itemTitles: ["Tagesausflug"] }] } }));
  a.on("GET /runs/r1", () => ({ body: { run } }));
  a.on("GET /runs/r1/share", () => ({ body: { share: null } }));
  a.on("GET /templates", () => ({ body: { total: 1, templates: [tpl] } }));
  a.on("GET /templates/t1", () => ({ body: { template: { ...tpl, items: tree } } }));
  a.on("GET /tags", () => ({ body: { tags } }));
  a.on("GET /trash", () => ({ body: { retentionDays: 30, items: [{ type: "run", id: "r1", title: "Ausflug", deletedAt: 1, purgeAt: 2, statusBeforeDelete: "active", progress: { done: 1, total: 3 } }] } }));
  a.on("GET /me/shares", () => ({ body: { shares: [] } }));
  a.on("GET /me/tokens", () => ({ body: { tokens: [] } }));
  a.on("GET /me/2fa", () => ({ body: { enabled: false, enabledAt: null, pendingSetup: false, recoveryCodesRemaining: 0 } }));
  a.on("GET /me/sso", () => ({ body: { enabled: false, name: null, linked: false } }));
  a.on("GET /public/runs/tok1234567890", () => ({ body: { permission: "edit", run: { title: "Ausflug", updatedAt: 1, progress: run.progress, sections: run.sections } } }));
  return a;
}

describe("Barrierefreiheit (axe-core, WCAG 2.2 AA)", () => {
  it("Prüfung ist wirksam: erkennt unbeschriftete Felder und Bilder ohne Alternativtext", async () => {
    document.body.innerHTML = '<main><input type="text"><img src="x.png"><button></button></main>';
    const found = await violations();
    expect(found.map((f) => f.split(":")[0])).toEqual(expect.arrayContaining(["label", "image-alt", "button-name"]));
    document.body.innerHTML = "";
  });

  it.each([
    ["Anmeldung", "/login", "Anmelden"],
    ["Registrierung", "/register", "Registrieren"],
    ["Startseite", "/", "Ausflug"],
    ["Checkliste", "/runs/r1", "Rucksack"],
    ["Archiv", "/archive", "Archiv"],
    ["Vorlagenliste", "/templates", "Tagesausflug"],
    ["Vorlageneditor", "/templates/t1", "Regenjacke"],
    ["Papierkorb", "/trash", "Ausflug"],
    ["Profil", "/profile", "Profil"],
    ["Öffentliche Ansicht", "/s/tok1234567890", "Rucksack"],
  ])("%s hat keine Verstöße", async (_name, path, waitFor_) => {
    const a = api();
    if (path === "/login" || path === "/register" || path.startsWith("/s/")) a.setUser(null);
    renderApp(path);
    await screen.findAllByText(waitFor_);
    await new Promise((r) => setTimeout(r, 100));
    await expectClean();
  });

  it("geöffnete Dialoge (Neue Checkliste, Teilen, Beenden) haben keine Verstöße", async () => {
    api();
    const { ui } = renderApp("/");
    await ui.click(await screen.findByRole("button", { name: /Neue Checkliste/ }));
    await screen.findByRole("dialog");
    await waitFor(async () => expect(screen.getByText(/1 Vorlage|Vorlagen gewählt/)).toBeInTheDocument());
    await expectClean();
  });

  it("Fehlermeldungen sind als Hinweise für Screenreader ausgezeichnet", async () => {
    const a = api();
    a.on("GET /runs/r1", () => apiError(404, "not_found"));
    renderApp("/runs/r1");
    expect(await screen.findByRole("alert")).toHaveTextContent("nicht");
    await expectClean();
  });
});

/* ---------- Farbkontraste (WCAG 1.4.3: Text 4,5:1; 1.4.11: Bedienelemente 3:1) ---------- */
const css = readFileSync(resolve(__dirname, "../styles.css"), "utf-8");
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
const light = tokens(css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="dark"]')));
const dark = tokens(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf("@media (prefers-color-scheme: dark)")));
const systemDark = tokens(css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("@theme inline")));

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("Farbkontraste", () => {
  it("Dunkelmodus per Betriebssystem entspricht dem erzwungenen Dunkelmodus", () => {
    expect(systemDark).toEqual(dark);
  });

  for (const [name, t] of [["hell", light], ["dunkel", dark]] as const) {
    it(`Text ≥ 4,5:1 im ${name}en Design`, () => {
      const pairs: [string, string, string][] = [
        ["text", "bg", "Text auf Hintergrund"], ["text", "surface", "Text auf Fläche"], ["text", "soft", "Text auf weicher Fläche"],
        ["text", "danger-soft", "Text auf Fehlerfläche"], ["muted", "bg", "Hinweistext auf Hintergrund"], ["muted", "surface", "Hinweistext auf Fläche"],
        ["primary-text", "primary", "Text auf Primärschaltfläche"], ["primary", "surface", "Primärfarbe (Links) auf Fläche"], ["primary", "bg", "Primärfarbe auf Hintergrund"],
        ["danger", "surface", "Fehlertext auf Fläche"], ["ok", "surface", "Erfolgsfarbe auf Fläche"], ["warn", "surface", "Warnfarbe auf Fläche"],
      ];
      const bad = pairs.filter(([f, b]) => ratio(t[f]!, t[b]!) < 4.5).map(([f, b, n]) => `${n}: ${ratio(t[f]!, t[b]!).toFixed(2)}`);
      expect(bad).toEqual([]);
    });
    it(`Fokus und Rahmen von Bedienelementen ≥ 3:1 im ${name}en Design`, () => {
      expect(ratio(t["focus"]!, t["surface"]!)).toBeGreaterThanOrEqual(3);
      expect(ratio(t["focus"]!, t["bg"]!)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("Farbkontraste der Akzentfarben", () => {
  const accents = [...css.matchAll(/:root\[data-accent="([a-z]+)"\]\s*\{([^}]*)\}/g)].map((m) => ({ name: m[1]!, t: Object.fromEntries([...m[2]!.matchAll(/--ac-([a-z]+):\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1]!, x[2]!])) }));
  it("enthält alle wählbaren Farben außer dem Standard", () => {
    expect(accents.map((a) => a.name)).toEqual(["indigo", "violet", "rose", "orange", "green", "teal", "slate"]);
  });
  for (const { name, t } of accents) {
    it(`${name}: hell und dunkel erfüllen 4,5:1 (Text) bzw. 3:1 (Fokus)`, () => {
      const L = light, D = dark;
      const bad = [
        ["hell: weiß auf Primär", ratio(L["primary-text"]!, t["p"]!), 4.5], ["hell: Primär auf Fläche", ratio(t["p"]!, L["surface"]!), 4.5],
        ["hell: Primär auf Hintergrund", ratio(t["p"]!, L["bg"]!), 4.5], ["hell: Primär auf weicher Fläche", ratio(t["p"]!, t["s"]!), 4.5],
        ["hell: Text auf weicher Fläche", ratio(L["text"]!, t["s"]!), 4.5], ["hell: Fokus", ratio(t["f"]!, L["bg"]!), 3],
        ["dunkel: Text auf Primär", ratio(D["primary-text"]!, t["dp"]!), 4.5], ["dunkel: Primär auf Fläche", ratio(t["dp"]!, D["surface"]!), 4.5],
        ["dunkel: Primär auf Hintergrund", ratio(t["dp"]!, D["bg"]!), 4.5], ["dunkel: Primär auf weicher Fläche", ratio(t["dp"]!, t["ds"]!), 4.5],
        ["dunkel: Text auf weicher Fläche", ratio(D["text"]!, t["ds"]!), 4.5], ["dunkel: Fokus", ratio(t["df"]!, D["bg"]!), 3],
      ].filter(([, r, min]) => (r as number) < (min as number)).map(([n, r]) => `${n}: ${(r as number).toFixed(2)}`);
      expect(bad).toEqual([]);
    });
  }
});
