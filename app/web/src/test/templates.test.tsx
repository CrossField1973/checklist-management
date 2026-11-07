import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tag, TemplateDetail, TemplateSummary } from "../api/types";
import type { ItemNode } from "../lib/tree";
import { apiError, mockApi, renderApp } from "./harness";

const TAG_A: Tag = { id: "g1", name: "Reisen", color: "#2563eb", textColor: "#ffffff", templateCount: 2 };
const TAG_B: Tag = { id: "g2", name: "Outdoor", color: "#facc15", textColor: "#000000", templateCount: 1 };
const summary = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({ id: "t1", title: "Tagesausflug", tags: [TAG_A], itemCount: 3, createdAt: 1, updatedAt: 1_700_000_000_000, ...over });
const n = (id: string, title: string, children: ItemNode[] = [], position = 0): ItemNode => ({ id, title, position, children });
/** Rucksack[Sonnencreme, Regenjacke], Route prüfen */
const tree = (): ItemNode[] => [n("i1", "Rucksack", [n("i11", "Sonnencreme", [], 0), n("i12", "Regenjacke", [], 1)], 0), n("i2", "Route prüfen", [], 1)];
const detail = (over: Partial<TemplateDetail> = {}): TemplateDetail => ({ ...summary(), items: tree(), ...over });

/** Fake-API mit Vorlagenliste, Tags und einer Vorlage im Editor */
function templatesApi(opts: { templates?: TemplateSummary[]; total?: number; tags?: Tag[] } = {}) {
  const api = mockApi();
  const templates = opts.templates ?? [summary(), summary({ id: "t2", title: "Wohnung putzen", tags: [], itemCount: 0, updatedAt: 1_650_000_000_000 })];
  api.on("GET /templates", () => ({ body: { total: opts.total ?? templates.length, templates } }));
  api.on("GET /tags", () => ({ body: { tags: opts.tags ?? [TAG_A, TAG_B] } }));
  api.on("GET /templates/t1", () => ({ body: { template: detail() } }));
  return api;
}
const query = (path: string) => new URL(path, "http://x").searchParams;
const listCalls = (api: ReturnType<typeof mockApi>) => api.callsTo("GET /templates");
const openEditor = async (api = templatesApi()) => {
  const r = renderApp("/templates/t1");
  await screen.findByRole("heading", { name: "Tagesausflug", level: 1 });
  return { api, ...r };
};
const row = (title: string) => screen.getByText(title).closest("li")!;

describe("Vorlagenliste (F-11)", () => {
  it("zeigt Vorlagen mit Anzahl, Änderungsdatum und farbigen Tags (Schriftfarbe vom Server)", async () => {
    templatesApi();
    renderApp("/templates");
    const first = (await screen.findByRole("link", { name: "Tagesausflug" })).closest("li")!;
    expect(first).toHaveTextContent("3 Punkte");
    expect(first).toHaveTextContent("geändert am");
    const chip = within(first).getByText("Reisen");
    expect(chip).toHaveStyle({ backgroundColor: "#2563eb", color: "#ffffff" });
    expect(screen.getByText("2 Vorlagen")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tagesausflug" })).toHaveAttribute("href", "/templates/t1");
    expect(within(row("Wohnung putzen")).queryByText("Reisen")).not.toBeInTheDocument();
  });

  it("sucht mit kurzer Verzögerung beim Tippen und merkt sich die Suche in der Adresse", async () => {
    const api = templatesApi();
    const { ui } = renderApp("/templates");
    await screen.findByRole("link", { name: "Tagesausflug" });
    await ui.type(screen.getByLabelText("Suche"), "Über");
    await waitFor(() => expect(query(listCalls(api).at(-1)!.path).get("search")).toBe("Über"));
    expect(listCalls(api).filter((c) => query(c.path).has("search"))).toHaveLength(1); // nicht pro Tastendruck
  });

  it("filtert per Tag (umschaltbar, mit aria-pressed) und sortiert nach Titel", async () => {
    const api = templatesApi();
    const { ui } = renderApp("/templates");
    const group = await screen.findByRole("group", { name: "Nach Tag filtern" });
    expect(within(group).getByRole("button", { name: "Alle" })).toHaveAttribute("aria-pressed", "true");
    await ui.click(within(group).getByRole("button", { name: /Outdoor/ }));
    await waitFor(() => expect(query(listCalls(api).at(-1)!.path).get("tagId")).toBe("g2"));
    expect(within(group).getByRole("button", { name: /Outdoor/ })).toHaveAttribute("aria-pressed", "true");
    await ui.click(within(group).getByRole("button", { name: /Outdoor/ })); // erneut: Filter aus
    await waitFor(() => expect(query(listCalls(api).at(-1)!.path).has("tagId")).toBe(false));
    await ui.selectOptions(screen.getByLabelText("Sortierung"), "title");
    await waitFor(() => expect(query(listCalls(api).at(-1)!.path).get("sort")).toBe("title"));
  });

  it("blättert in Seiten zu je 20 Vorlagen", async () => {
    const api = templatesApi({ total: 45 });
    const { ui } = renderApp("/templates");
    expect(await screen.findByText("Seite 1 von 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zurück" })).toBeDisabled();
    await ui.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(query(listCalls(api).at(-1)!.path).get("offset")).toBe("20"));
    expect(await screen.findByText("Seite 2 von 3")).toBeInTheDocument();
  });

  it("unterscheidet leere Liste und leeres Suchergebnis", async () => {
    templatesApi({ templates: [], tags: [] });
    const first = renderApp("/templates");
    expect(await screen.findByText(/noch keine Vorlagen/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Neue Vorlage" }).length).toBeGreaterThan(1);
    first.unmount();
    renderApp("/templates?q=nichts");
    expect(await screen.findByText("Keine Vorlage gefunden.")).toBeInTheDocument();
  });

  it("zeigt in der Liste weder Duplizieren noch Löschen", async () => {
    templatesApi();
    renderApp("/templates");
    await screen.findByText("Tagesausflug");
    expect(screen.queryByRole("button", { name: /duplizieren|löschen/i })).not.toBeInTheDocument();
  });

  it("öffnet die Vorlage bei Klick irgendwo in die Zeile", async () => {
    templatesApi();
    const { ui } = renderApp("/templates");
    await ui.click((await screen.findByText(/3 Punkte/)).closest("li")!);
    expect(await screen.findByRole("heading", { name: "Tagesausflug", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeInTheDocument();
  });
});

describe("Tags verwalten (F-17, F-18) – direkt im Profil", () => {
  async function openTags() {
    const api = templatesApi();
    const r = renderApp("/profile?section=tags");
    const box = within(await screen.findByRole("region", { name: "Tags" }));
    await box.findByLabelText("Name von Reisen");
    return { api, box, ...r };
  }

  it("zeigt die Verwaltung ohne Zwischenschritt und ohne Zahl der Vorlagen", async () => {
    const { box } = await openTags();
    expect(screen.queryByRole("button", { name: "Tags verwalten" })).not.toBeInTheDocument();
    expect(box.queryByText(/\d+ Vorlage/)).not.toBeInTheDocument();
  });

  it("legt Tags nur mit Namen an – die Farbe vergibt der Server automatisch", async () => {
    const { api, box, ui } = await openTags();
    api.on("POST /tags", ({ body }) => ({ status: 201, body: { tag: { id: "g3", name: body.name, color: "#9333ea", textColor: "#ffffff" } } }));
    const create = box.getByRole("button", { name: "Tag anlegen" });
    expect(create).toBeDisabled();
    expect(box.getByText(/automatisch so gewählt/)).toBeInTheDocument();
    await ui.type(box.getByLabelText("Neuer Tag"), "Wandern");
    await ui.click(create);
    await waitFor(() => expect(api.callsTo("POST /tags")).toHaveLength(1));
    expect(api.callsTo("POST /tags")[0]!.body).toEqual({ name: "Wandern" }); // keine Farbe gesendet
  });

  it("benennt beim Verlassen des Felds um", async () => {
    const { api, box, ui } = await openTags();
    api.on("PUT /tags/g1", ({ body }) => ({ body: { tag: { ...TAG_A, ...body } } }));
    const name = box.getByLabelText("Name von Reisen");
    await ui.clear(name);
    await ui.type(name, "Urlaub");
    await ui.tab();
    await waitFor(() => expect(api.callsTo("PUT /tags/g1")).toHaveLength(1));
    expect(api.callsTo("PUT /tags/g1")[0]!.body).toEqual({ name: "Urlaub" });
  });

  it("wählt die Farbe über eigene Farbfelder oder einen Hex-Wert statt des Systemdialogs", async () => {
    const { api, box, ui } = await openTags();
    api.on("PUT /tags/g1", ({ body }) => ({ body: { tag: { ...TAG_A, ...body } } }));
    expect(box.queryByLabelText("Farbe von Reisen", { selector: "input" })).not.toBeInTheDocument(); // kein <input type=color>
    await ui.click(box.getByRole("button", { name: "Farbe von Reisen" }));
    const panel = within(box.getByRole("group", { name: "Farbe von Reisen" }));
    await ui.click(panel.getByRole("button", { name: "#16a34a" }));
    await waitFor(() => expect(api.callsTo("PUT /tags/g1")).toHaveLength(1));
    expect(api.callsTo("PUT /tags/g1")[0]!.body).toEqual({ color: "#16a34a" });

    await ui.click(box.getByRole("button", { name: "Farbe von Reisen" }));
    const hex = within(box.getByRole("group", { name: "Farbe von Reisen" })).getByLabelText("Hex-Farbwert");
    await ui.clear(hex);
    await ui.type(hex, "#ABCDEF{Enter}");
    await waitFor(() => expect(api.callsTo("PUT /tags/g1")).toHaveLength(2));
    expect(api.callsTo("PUT /tags/g1")[1]!.body).toEqual({ color: "#abcdef" });
  });

  it("ignoriert ungültige Hex-Werte", async () => {
    const { api, box, ui } = await openTags();
    await ui.click(box.getByRole("button", { name: "Farbe von Reisen" }));
    const hex = within(box.getByRole("group", { name: "Farbe von Reisen" })).getByLabelText("Hex-Farbwert");
    await ui.clear(hex);
    await ui.type(hex, "#12{Enter}");
    expect(api.callsTo("PUT /tags/g1")).toHaveLength(0);
    expect(hex).toHaveValue("#2563eb");
  });

  it("meldet doppelte Namen und stellt den alten Namen wieder her", async () => {
    const { api, box, ui } = await openTags();
    api.on("PUT /tags/g1", () => apiError(409, "tag_name_taken"));
    const name = box.getByLabelText("Name von Reisen");
    await ui.clear(name);
    await ui.type(name, "Outdoor");
    await ui.tab();
    expect(await box.findByRole("alert")).toHaveTextContent("existiert bereits");
    await waitFor(() => expect(box.getByLabelText("Name von Reisen")).toHaveValue("Reisen"));
  });

  it("fragt vor dem Löschen nach und nennt, in wie vielen Vorlagen der Tag verwendet wird", async () => {
    const { api, box, ui } = await openTags();
    api.on("DELETE /tags/g1", () => ({ status: 204 }));
    await ui.click(box.getByRole("button", { name: "Tag Reisen löschen" }));
    expect(api.callsTo("DELETE /tags/g1")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog", { name: "Tag „Reisen“ löschen?" });
    expect(dialog).toHaveTextContent("in 2 Vorlagen verwendet");
    expect(dialog).toHaveTextContent("wirklich löschen");
    await ui.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(api.callsTo("DELETE /tags/g1")).toHaveLength(0);

    await ui.click(box.getByRole("button", { name: "Tag Reisen löschen" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /tags/g1")).toHaveLength(1));
  });

  it("nennt bei genau einer Vorlage die Einzahl", async () => {
    const { box, ui } = await openTags();
    await ui.click(box.getByRole("button", { name: "Tag Outdoor löschen" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("in 1 Vorlage verwendet");
  });
});

describe("Vorlagen-Editor: Details und Tags (F-12)", () => {
  it("zeigt Punkte zuerst, darunter Details mit Titel und gewählten Tags", async () => {
    await openEditor();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Punkte")).toBeLessThan(headings.indexOf("Details"));
    expect(screen.getByLabelText("Titel")).toHaveValue("Tagesausflug");
    expect(screen.queryByLabelText("Beschreibung (optional)")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Reisen/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Outdoor/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Tags verwalten" })).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Punkte der Vorlage" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.match(/Rucksack|Sonnencreme|Regenjacke|Route prüfen/)?.[0])).toEqual(["Rucksack", "Sonnencreme", "Regenjacke", "Route prüfen"]);
    expect(screen.getByText(/4 Punkte insgesamt/)).toBeInTheDocument();
  });

  it("speichert erst bei Änderungen und sendet Titel, Tags und den ganzen Punktebaum", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /templates/t1", ({ body }) => ({ body: { template: detail({ title: body.title, tags: [TAG_A, TAG_B] }) } }));
    const save = screen.getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await ui.clear(screen.getByLabelText("Titel"));
    await ui.type(screen.getByLabelText("Titel"), "Ausflug");
    expect(screen.getByText("Ungespeicherte Änderungen")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /Outdoor/ }));
    await ui.click(save);
    await waitFor(() => expect(api.callsTo("PUT /templates/t1")).toHaveLength(1));
    expect(api.callsTo("PUT /templates/t1")[0]!.body).toEqual({
      title: "Ausflug", tagIds: ["g1", "g2"],
      items: [
        { title: "Rucksack", children: [{ title: "Sonnencreme" }, { title: "Regenjacke" }] },
        { title: "Route prüfen" },
      ],
    });
    expect(await screen.findByText("Gespeichert.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("legt einen neuen Tag direkt im Editor an (Farbe vom Server) und wählt ihn aus", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /tags", ({ body }) => ({ status: 201, body: { tag: { id: "g3", name: body.name, color: "#9333ea", textColor: "#ffffff" } } }));
    api.on("GET /tags", () => ({ body: { tags: [TAG_A, TAG_B, { id: "g3", name: "Wandern", color: "#9333ea", textColor: "#ffffff" }] } }));
    await ui.type(screen.getByLabelText("Neuer Tag"), "Wandern{Enter}");
    expect(await screen.findByRole("button", { name: /Wandern/ })).toHaveAttribute("aria-pressed", "true");
    expect(api.callsTo("POST /tags")[0]!.body).toEqual({ name: "Wandern" });
    expect(screen.getByText("Ungespeicherte Änderungen")).toBeInTheDocument(); // zugeordnet wird erst beim Speichern
  });

  it("zeigt eine verständliche Meldung, wenn die Vorlage nicht existiert", async () => {
    const api = templatesApi();
    api.on("GET /templates/t1", () => apiError(404, "not_found"));
    renderApp("/templates/t1");
    expect(await screen.findByRole("alert")).toHaveTextContent("gibt es nicht");
    expect(screen.getByRole("link", { name: "Alle Vorlagen" })).toHaveAttribute("href", "/templates");
  });
});

describe("Vorlagen-Editor: Punkte werden lokal geändert und mit Speichern übertragen (F-13, F-14)", () => {
  it("fügt Punkte per Enter hinzu, leert das Feld und behält den Fokus – ohne Serveraufruf", async () => {
    const { api, ui } = await openEditor();
    const input = screen.getByLabelText("Neuen Punkt hinzufügen");
    await ui.type(input, "Proviant{Enter}");
    expect(await screen.findByText("Proviant")).toBeInTheDocument();
    expect(api.callsTo("POST /templates/t1/items")).toHaveLength(0);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus(); // sofort der nächste Punkt möglich
    expect(screen.getByText(/5 Punkte insgesamt/)).toBeInTheDocument();
    expect(screen.getByText("Ungespeicherte Änderungen")).toBeInTheDocument();
  });

  it("ignoriert leere Eingaben", async () => {
    const { ui } = await openEditor();
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "   {Enter}");
    expect(screen.queryByText("Ungespeicherte Änderungen")).not.toBeInTheDocument();
  });

  it("legt Unterpunkte unter einem Punkt an", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /templates/t1", () => ({ body: { template: detail() } }));
    await ui.click(screen.getByRole("button", { name: "Unterpunkt zu Rucksack hinzufügen" }));
    await ui.type(await screen.findByLabelText("Neuer Unterpunkt von Rucksack"), "Mütze{Enter}");
    expect(await screen.findByText("Mütze")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /templates/t1")).toHaveLength(1));
    expect(api.callsTo("PUT /templates/t1")[0]!.body.items[0].children.map((c: { title: string }) => c.title)).toEqual(["Sonnencreme", "Regenjacke", "Mütze"]);
  });

  it("bearbeitet den Titel eines Punkts im Dialog", async () => {
    const { api, ui } = await openEditor();
    await ui.click(screen.getByRole("button", { name: "Route prüfen bearbeiten" }));
    const dialog = await screen.findByRole("dialog", { name: "Punkt bearbeiten" });
    expect(within(dialog).getByLabelText("Titel")).toHaveValue("Route prüfen");
    await ui.clear(within(dialog).getByLabelText("Titel"));
    await ui.type(within(dialog).getByLabelText("Titel"), "Route und Wetter prüfen");
    await ui.click(within(dialog).getByRole("button", { name: "Übernehmen" }));
    expect(await screen.findByText("Route und Wetter prüfen")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("PUT /template-items/i2")).toHaveLength(0);
  });

  it("löscht Punkte nach Rückfrage und nennt die Zahl der betroffenen Unterpunkte", async () => {
    const { ui } = await openEditor();
    await ui.click(screen.getByRole("button", { name: "Rucksack löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Punkt löschen?" });
    expect(dialog).toHaveTextContent("samt 2 Unterpunkten");
    expect(screen.getByText("Rucksack")).toBeInTheDocument(); // noch nicht gelöscht
    await ui.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByText("Rucksack")).not.toBeInTheDocument());
    expect(screen.queryByText("Sonnencreme")).not.toBeInTheDocument();
    expect(screen.getByText(/1 Punkte insgesamt/)).toBeInTheDocument();
  });

  it("klappt Unterpunkte ein und aus und zeigt, wie viele verborgen sind", async () => {
    const { ui } = await openEditor();
    await ui.click(screen.getByRole("button", { name: "Unterpunkte von Rucksack ausblenden" }));
    expect(screen.queryByText("Sonnencreme")).not.toBeInTheDocument();
    expect(screen.getByText("2 Unterpunkte")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Unterpunkte von Rucksack einblenden" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await ui.click(toggle);
    expect(screen.getByText("Sonnencreme")).toBeInTheDocument();
  });
});

describe("Vorlagen-Editor: Verschieben ohne Ziehen (WCAG 2.5.7)", () => {
  const moveBtn = (name: string) => screen.getByRole("button", { name });
  const titlesInOrder = () => within(screen.getByRole("list", { name: "Punkte der Vorlage" })).getAllByRole("listitem")
    .map((li) => li.textContent?.match(/Rucksack|Sonnencreme|Regenjacke|Route prüfen/)?.[0]).filter(Boolean);

  it("deaktiviert unmögliche Schritte (erster Punkt nicht nach oben/einrücken, oberste Ebene nicht ausrücken)", async () => {
    await openEditor();
    expect(moveBtn("Rucksack nach oben")).toBeDisabled();
    expect(moveBtn("Rucksack eine Ebene nach rechts (einrücken)")).toBeDisabled();
    expect(moveBtn("Rucksack eine Ebene nach links (ausrücken)")).toBeDisabled();
    expect(moveBtn("Route prüfen nach unten")).toBeDisabled();
    expect(moveBtn("Rucksack nach unten")).toBeEnabled();
    expect(moveBtn("Sonnencreme eine Ebene nach links (ausrücken)")).toBeEnabled();
  });

  it("verschiebt mit ↓ und ← sofort lokal, ohne Serveraufruf", async () => {
    const { api, ui } = await openEditor();
    await ui.click(moveBtn("Rucksack nach unten"));
    expect(titlesInOrder()).toEqual(["Route prüfen", "Rucksack", "Sonnencreme", "Regenjacke"]);
    await ui.click(moveBtn("Sonnencreme eine Ebene nach links (ausrücken)"));
    expect(titlesInOrder()).toEqual(["Route prüfen", "Rucksack", "Regenjacke", "Sonnencreme"]);
    await ui.click(moveBtn("Sonnencreme eine Ebene nach rechts (einrücken)"));
    expect(titlesInOrder()).toEqual(["Route prüfen", "Rucksack", "Regenjacke", "Sonnencreme"]);
    expect(api.callsTo("POST /template-items/i1/move")).toHaveLength(0);
    expect(screen.getByText("Ungespeicherte Änderungen")).toBeInTheDocument();
  });

  it("bietet an jedem Punkt Griff, Aktionen und sprechende Namen", async () => {
    await openEditor();
    const rowEl = within(screen.getByTestId("item-i2"));
    expect(rowEl.getByRole("button", { name: /Route prüfen verschieben/ })).toBeInTheDocument();
    expect(rowEl.getByRole("group", { name: "Aktionen für Route prüfen" })).toBeInTheDocument();
    for (const name of ["Route prüfen nach oben", "Route prüfen nach unten", "Route prüfen bearbeiten", "Route prüfen löschen"]) expect(rowEl.getByRole("button", { name })).toBeInTheDocument();
  });
});

describe("Vorlage bearbeiten: Verlassen mit ungespeicherten Änderungen", () => {
  it("fragt nach, bleibt auf Wunsch und verwirft beim Verlassen", async () => {
    const { ui } = await openEditor();
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "Proviant{Enter}");
    await ui.click(screen.getByRole("link", { name: "← Alle Vorlagen" }));
    const dialog = await screen.findByRole("dialog", { name: "Seite verlassen?" });
    expect(dialog).toHaveTextContent("verworfen");
    await ui.click(within(dialog).getByRole("button", { name: "Auf der Seite bleiben" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Proviant")).toBeInTheDocument();

    await ui.click(screen.getByRole("link", { name: "← Alle Vorlagen" }));
    await ui.click(within(await screen.findByRole("dialog", { name: "Seite verlassen?" })).getByRole("button", { name: "Verlassen und verwerfen" }));
    expect(await screen.findByRole("heading", { name: "Vorlagen", level: 1 })).toBeInTheDocument();
  });

  it("verlässt ohne Rückfrage, wenn alles gespeichert ist", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /templates/t1", () => ({ body: { template: detail() } }));
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "Proviant{Enter}");
    await ui.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByText("Gespeichert.");
    await ui.click(screen.getByRole("link", { name: "← Alle Vorlagen" }));
    expect(await screen.findByRole("heading", { name: "Vorlagen", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Vorlage erstellen", () => {
  async function startCreate(title = "Packliste") {
    const api = templatesApi();
    const r = renderApp("/templates");
    await r.ui.click(await screen.findByRole("button", { name: "Neue Vorlage" }));
    const dialog = await screen.findByRole("dialog", { name: "Neue Vorlage" });
    await r.ui.type(within(dialog).getByLabelText("Titel"), title);
    return { api, dialog, ...r };
  }

  it("fragt im Dialog nach Titel und Tags und legt noch nichts an", async () => {
    const { api, dialog, ui } = await startCreate();
    expect(await within(dialog).findByRole("button", { name: /Reisen/ })).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Weiter zu den Punkten" }));
    expect(await screen.findByRole("heading", { name: "Neue Vorlage: Packliste", level: 1 })).toBeInTheDocument();
    expect(api.callsTo("POST /templates")).toHaveLength(0);
  });

  it("verlangt einen Titel", async () => {
    templatesApi();
    const { ui } = renderApp("/templates");
    await ui.click(await screen.findByRole("button", { name: "Neue Vorlage" }));
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Weiter zu den Punkten" })).toBeDisabled();
  });

  it("zeigt Punkte vor den Details, aber weder Duplizieren noch Löschen; speichert alles mit Erstellen", async () => {
    const { api, dialog, ui } = await startCreate();
    await ui.click(await within(dialog).findByRole("button", { name: /Reisen/ }));
    await ui.click(within(dialog).getByRole("button", { name: "Weiter zu den Punkten" }));
    await screen.findByRole("heading", { name: "Neue Vorlage: Packliste", level: 1 });

    expect(screen.queryByRole("button", { name: /Duplizieren/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Löschen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Exportieren/ })).not.toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Punkte")).toBeLessThan(headings.indexOf("Details"));
    expect(screen.getByLabelText("Titel")).toHaveValue("Packliste");

    api.on("POST /templates", ({ body }) => ({ status: 201, body: { template: detail({ id: "t1", title: body.title, items: [] }) } }));
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "Zelt{Enter}");
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "Schlafsack{Enter}");
    await ui.click(screen.getByRole("button", { name: "Erstellen" }));
    await waitFor(() => expect(api.callsTo("POST /templates")).toHaveLength(1));
    expect(api.callsTo("POST /templates")[0]!.body).toEqual({
      title: "Packliste", tagIds: ["g1"],
      items: [{ title: "Zelt" }, { title: "Schlafsack" }],
    });
    // danach im normalen Bearbeiten-Modus (ohne Rückfrage)
    expect(await screen.findByText("Die Vorlage wurde erstellt.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Seite verlassen?" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeInTheDocument();
  });

  it("fragt beim Verlassen ohne Erstellen nach und verwirft sonst alles", async () => {
    const { api, dialog, ui } = await startCreate();
    await ui.click(within(dialog).getByRole("button", { name: "Weiter zu den Punkten" }));
    await screen.findByRole("heading", { name: "Neue Vorlage: Packliste", level: 1 });
    await ui.click(screen.getByRole("link", { name: "← Alle Vorlagen" }));
    const leave = await screen.findByRole("dialog", { name: "Seite verlassen?" });
    await ui.click(within(leave).getByRole("button", { name: "Auf der Seite bleiben" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await ui.click(screen.getByRole("link", { name: "← Alle Vorlagen" }));
    await ui.click(within(await screen.findByRole("dialog", { name: "Seite verlassen?" })).getByRole("button", { name: "Verlassen und verwerfen" }));
    expect(await screen.findByRole("heading", { name: "Vorlagen", level: 1 })).toBeInTheDocument();
    expect(api.callsTo("POST /templates")).toHaveLength(0);
  });

  it("ohne Startwerte (z. B. nach Neuladen) geht es zurück zur Liste", async () => {
    templatesApi();
    renderApp("/templates/new");
    expect(await screen.findByRole("heading", { name: "Vorlagen", level: 1 })).toBeInTheDocument();
  });
});

describe("Vorlagen-Editor: Export, Duplizieren, Löschen", () => {
  it("bietet den Export als Button mit Auswahl-Dialog an (JSON und CSV)", async () => {
    const { api, ui } = await openEditor();
    api.on("GET /templates/t1/export", () => ({ body: {} }));
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await ui.click(screen.getByRole("button", { name: /Exportieren/ }));
    const dlg = await screen.findByRole("dialog", { name: "Exportieren" });
    expect(within(dlg).getAllByRole("button").map((b) => b.textContent)).toEqual(["JSON", "CSV", "Abbrechen"]);
    await ui.click(within(dlg).getByRole("button", { name: "CSV" }));
    await ui.click(screen.getByRole("button", { name: /Exportieren/ }));
    await ui.click(within(await screen.findByRole("dialog", { name: "Exportieren" })).getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(api.callsTo("GET /templates/t1/export")).toHaveLength(2));
    expect(api.callsTo("GET /templates/t1/export").map((c) => c.path.split("?")[1])).toEqual(["format=csv&delimiter=semicolon", "format=json"]);
    click.mockRestore();
  });

  it("löscht die Vorlage nach Rückfrage und kehrt zur Liste zurück", async () => {
    const { api, ui } = await openEditor();
    api.on("DELETE /templates/t1", () => ({ status: 204 }));
    await ui.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage löschen?" });
    await ui.click(within(dialog).getByRole("button", { name: "Löschen" }));
    expect(await screen.findByRole("heading", { name: "Vorlagen", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("„Tagesausflug“ wurde in den Papierkorb verschoben.")).toBeInTheDocument();
  });

  it("dupliziert aus dem Editor und wechselt zur Kopie", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /templates/t1/duplicate", () => ({ status: 201, body: { template: detail({ id: "t9", title: "Tagesausflug (Kopie)" }) } }));
    api.on("GET /templates/t9", () => ({ body: { template: detail({ id: "t9", title: "Tagesausflug (Kopie)" }) } }));
    await ui.click(screen.getByRole("button", { name: "Duplizieren" }));
    expect(await screen.findByRole("heading", { name: "Tagesausflug (Kopie)", level: 1 })).toBeInTheDocument();
  });
});

describe("Vorlage in Vorlage (Verweise)", () => {
  const ref: ItemNode = { id: "i3", title: "Hygiene", position: 2, children: [], ref: { templateId: "t3", title: "Hygiene", itemCount: 3, missing: false } };
  const withRef = (api: ReturnType<typeof mockApi>, usedInCount = 0) =>
    api.on("GET /templates/t1", () => ({ body: { template: detail({ items: [...tree(), ref], usedInCount }) } }));

  it("zeigt verwiesene Vorlagen als Eintrag mit Link und Anzahl, ohne Bearbeiten und Unterpunkte", async () => {
    const api = templatesApi();
    withRef(api);
    renderApp("/templates/t1");
    const link = await screen.findByRole("link", { name: "Hygiene" });
    expect(link).toHaveAttribute("href", "/templates/t3");
    const li = link.closest("li")!;
    expect(li).toHaveTextContent("3 Punkte");
    expect(within(li).queryByRole("button", { name: /Unterpunkt zu Hygiene/ })).not.toBeInTheDocument();
    expect(within(li).queryByRole("button", { name: /Hygiene bearbeiten/ })).not.toBeInTheDocument();
    expect(within(li).getByRole("button", { name: /Hygiene löschen/ })).toBeInTheDocument();
  });

  it("fügt eine Vorlage ein und speichert sie als Verweis", async () => {
    const api = templatesApi({ templates: [summary(), summary({ id: "t3", title: "Hygiene", itemCount: 3, tags: [] })] });
    api.on("PUT /templates/t1", ({ body }) => ({ body: { template: detail({ items: [...tree(), ref] }) } }));
    const { ui } = await openEditor(api);
    await ui.click(screen.getByRole("button", { name: "Vorlage einfügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage einfügen" });
    expect(within(dialog).queryByLabelText("Tagesausflug")).not.toBeInTheDocument(); // die Vorlage selbst steht nicht zur Wahl
    await ui.click(await within(dialog).findByLabelText("Hygiene"));
    await ui.click(within(dialog).getByRole("button", { name: "Einfügen" }));
    expect(await screen.findByRole("link", { name: "Hygiene" })).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /templates/t1")).toHaveLength(1));
    expect(api.callsTo("PUT /templates/t1")[0]!.body.items.at(-1)).toEqual({ refTemplateId: "t3" });
  });

  it("warnt im Editor mit der Anzahl (Einzahl)", async () => {
    const api = templatesApi();
    withRef(api, 1);
    api.on("GET /templates/t1", () => ({ body: { template: detail({ usedInCount: 1 }) } }));
    const { ui } = renderApp("/templates/t1");
    await ui.click(await screen.findByRole("button", { name: "Löschen" }));
    expect(await within(await screen.findByRole("dialog")).findByText(/in 1 Vorlage verwendet/)).toBeInTheDocument();
  });
});
