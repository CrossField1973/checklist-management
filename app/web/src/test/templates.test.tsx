import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tag, TemplateDetail, TemplateSummary } from "../api/types";
import type { ItemNode } from "../lib/tree";
import { apiError, mockApi, renderApp } from "./harness";

const TAG_A: Tag = { id: "g1", name: "Reisen", color: "#2563eb", textColor: "#ffffff", templateCount: 2 };
const TAG_B: Tag = { id: "g2", name: "Outdoor", color: "#facc15", textColor: "#000000", templateCount: 1 };
const summary = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({ id: "t1", title: "Tagesausflug", description: null, tags: [TAG_A], itemCount: 3, createdAt: 1, updatedAt: 1_700_000_000_000, ...over });
const n = (id: string, title: string, children: ItemNode[] = [], description: string | null = null, position = 0): ItemNode => ({ id, title, description, position, children });
/** Rucksack[Sonnencreme, Regenjacke], Route prüfen */
const tree = (): ItemNode[] => [n("i1", "Rucksack", [n("i11", "Sonnencreme", [], null, 0), n("i12", "Regenjacke", [], null, 1)], "Wetterfest", 0), n("i2", "Route prüfen", [], null, 1)];
const detail = (over: Partial<TemplateDetail> = {}): TemplateDetail => ({ ...summary(), description: "Für unterwegs", items: tree(), ...over });

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

  it("legt eine Vorlage an und öffnet sofort den Editor", async () => {
    const api = templatesApi();
    api.on("POST /templates", ({ body }) => ({ status: 201, body: { template: detail({ id: "t1", title: body.title, items: [] }) } }));
    api.on("GET /templates/t1", () => ({ body: { template: detail({ title: "Packliste", items: [] }) } }));
    const { ui } = renderApp("/templates");
    await ui.click(await screen.findByRole("button", { name: "Neue Vorlage" }));
    const dialog = await screen.findByRole("dialog", { name: "Neue Vorlage" });
    expect(within(dialog).getByRole("button", { name: "Anlegen" })).toBeDisabled(); // ohne Titel nicht möglich
    await ui.type(within(dialog).getByLabelText("Titel"), "Packliste");
    await ui.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(api.callsTo("POST /templates")[0]!.body).toEqual({ title: "Packliste" });
    expect(await screen.findByRole("heading", { name: "Packliste", level: 1 })).toBeInTheDocument();
  });

  it("dupliziert und öffnet die Kopie mit Hinweis", async () => {
    const api = templatesApi();
    api.on("POST /templates/t1/duplicate", () => ({ status: 201, body: { template: detail({ id: "t9", title: "Tagesausflug (Kopie)" }) } }));
    api.on("GET /templates/t9", () => ({ body: { template: detail({ id: "t9", title: "Tagesausflug (Kopie)" }) } }));
    const { ui } = renderApp("/templates");
    await ui.click(await screen.findByRole("button", { name: "Vorlage Tagesausflug duplizieren" }));
    expect(await screen.findByRole("heading", { name: "Tagesausflug (Kopie)", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Die Kopie wurde angelegt.")).toBeInTheDocument();
  });

  it("löscht erst nach Rückfrage in den Papierkorb und meldet es", async () => {
    const api = templatesApi();
    api.on("DELETE /templates/t1", () => ({ status: 204 }));
    const { ui } = renderApp("/templates");
    await ui.click(await screen.findByRole("button", { name: "Vorlage Tagesausflug löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage löschen?" });
    expect(dialog).toHaveTextContent("Papierkorb");
    expect(api.callsTo("DELETE /templates/t1")).toHaveLength(0);
    await ui.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /templates/t1")).toHaveLength(1));
    expect(await screen.findByText("„Tagesausflug“ wurde in den Papierkorb verschoben.")).toBeInTheDocument();
  });

  it("Abbrechen im Löschdialog löscht nichts", async () => {
    const api = templatesApi();
    const { ui } = renderApp("/templates");
    await ui.click(await screen.findByRole("button", { name: "Vorlage Tagesausflug löschen" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("DELETE /templates/t1")).toHaveLength(0);
  });
});

describe("Tags verwalten (F-17, F-18)", () => {
  async function openTags() {
    const api = templatesApi();
    const r = renderApp("/templates");
    await r.ui.click(await screen.findByRole("button", { name: "Tags verwalten" }));
    const dialog = await screen.findByRole("dialog", { name: "Tags verwalten" });
    await within(dialog).findByLabelText("Name von Reisen");
    return { api, dialog, ...r };
  }

  it("legt Tags nur mit Namen an – die Farbe vergibt der Server automatisch", async () => {
    const { api, dialog, ui } = await openTags();
    api.on("POST /tags", ({ body }) => ({ status: 201, body: { tag: { id: "g3", name: body.name, color: "#9333ea", textColor: "#ffffff" } } }));
    const create = within(dialog).getByRole("button", { name: "Tag anlegen" });
    expect(create).toBeDisabled();
    expect(within(dialog).getByText(/automatisch so gewählt/)).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText("Neuer Tag"), "Wandern");
    await ui.click(create);
    await waitFor(() => expect(api.callsTo("POST /tags")).toHaveLength(1));
    expect(api.callsTo("POST /tags")[0]!.body).toEqual({ name: "Wandern" }); // keine Farbe gesendet
  });

  it("benennt um und ändert die Farbe beim Verlassen des Felds", async () => {
    const { api, dialog, ui } = await openTags();
    api.on("PUT /tags/g1", ({ body }) => ({ body: { tag: { ...TAG_A, ...body } } }));
    const name = within(dialog).getByLabelText("Name von Reisen");
    await ui.clear(name);
    await ui.type(name, "Urlaub");
    await ui.tab();
    await waitFor(() => expect(api.callsTo("PUT /tags/g1")).toHaveLength(1));
    expect(api.callsTo("PUT /tags/g1")[0]!.body).toEqual({ name: "Urlaub" });
    const color = within(dialog).getByLabelText("Farbe von Reisen") as HTMLInputElement;
    expect(color).toHaveValue("#2563eb");
    expect(color.type).toBe("color");
  });

  it("meldet doppelte Namen und stellt den alten Namen wieder her", async () => {
    const { api, dialog, ui } = await openTags();
    api.on("PUT /tags/g1", () => apiError(409, "tag_name_taken"));
    const name = within(dialog).getByLabelText("Name von Reisen");
    await ui.clear(name);
    await ui.type(name, "Outdoor");
    await ui.tab();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("existiert bereits");
    await waitFor(() => expect(within(dialog).getByLabelText("Name von Reisen")).toHaveValue("Reisen"));
  });

  it("löscht nach Rückfrage und zeigt, wie viele Vorlagen den Tag nutzen", async () => {
    const { api, dialog, ui } = await openTags();
    api.on("DELETE /tags/g1", () => ({ status: 204 }));
    expect(within(dialog).getByText("2 Vorlagen")).toBeInTheDocument();
    expect(within(dialog).getByText("1 Vorlage")).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Tag Reisen löschen" }));
    expect(api.callsTo("DELETE /tags/g1")).toHaveLength(0);
    const group = within(dialog).getByRole("group", { name: "Tag „Reisen“ löschen?" });
    await ui.click(within(group).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /tags/g1")).toHaveLength(1));
  });
});

describe("Vorlagen-Editor: Details und Tags (F-12)", () => {
  it("zeigt Titel, Beschreibung, gewählte Tags und die Punkte als Baum", async () => {
    await openEditor();
    expect(screen.getByLabelText("Titel")).toHaveValue("Tagesausflug");
    expect(screen.getByLabelText("Beschreibung (optional)")).toHaveValue("Für unterwegs");
    expect(await screen.findByRole("button", { name: /Reisen/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Outdoor/ })).toHaveAttribute("aria-pressed", "false");
    const list = screen.getByRole("list", { name: "Punkte der Vorlage" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.match(/Rucksack|Sonnencreme|Regenjacke|Route prüfen/)?.[0])).toEqual(["Rucksack", "Sonnencreme", "Regenjacke", "Route prüfen"]);
    expect(screen.getByText("Wetterfest")).toBeInTheDocument(); // Beschreibung des Punkts
    expect(screen.getByText(/4 Punkte insgesamt/)).toBeInTheDocument();
  });

  it("speichert erst bei Änderungen und sendet Titel, Beschreibung und Tags", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /templates/t1", ({ body }) => ({ body: { template: detail({ title: body.title, description: body.description, tags: [TAG_A, TAG_B] }) } }));
    const save = screen.getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await ui.clear(screen.getByLabelText("Titel"));
    await ui.type(screen.getByLabelText("Titel"), "Ausflug");
    expect(screen.getByText("Ungespeicherte Änderungen")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /Outdoor/ }));
    await ui.click(save);
    await waitFor(() => expect(api.callsTo("PUT /templates/t1")).toHaveLength(1));
    expect(api.callsTo("PUT /templates/t1")[0]!.body).toEqual({ title: "Ausflug", description: "Für unterwegs", tagIds: ["g1", "g2"] });
    expect(await screen.findByText("Gespeichert.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("leere Beschreibung wird als null gesendet", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /templates/t1", () => ({ body: { template: detail({ description: null }) } }));
    await ui.clear(screen.getByLabelText("Beschreibung (optional)"));
    await ui.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /templates/t1")).toHaveLength(1));
    expect(api.callsTo("PUT /templates/t1")[0]!.body.description).toBeNull();
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

describe("Vorlagen-Editor: Punkte (F-13, F-14)", () => {
  it("fügt Punkte per Enter hinzu, leert das Feld und behält den Fokus", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /templates/t1/items", ({ body }) => ({ status: 201, body: { itemId: "i3", items: [...tree(), n("i3", body.title, [], null, 2)] } }));
    const input = screen.getByLabelText("Neuen Punkt hinzufügen");
    await ui.type(input, "Proviant{Enter}");
    expect(await screen.findByText("Proviant")).toBeInTheDocument();
    expect(api.callsTo("POST /templates/t1/items")[0]!.body).toEqual({ title: "Proviant" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus(); // sofort der nächste Punkt möglich
    expect(screen.getByText(/5 Punkte insgesamt/)).toBeInTheDocument();
  });

  it("ignoriert leere Eingaben", async () => {
    const { api, ui } = await openEditor();
    await ui.type(screen.getByLabelText("Neuen Punkt hinzufügen"), "   {Enter}");
    expect(api.callsTo("POST /templates/t1/items")).toHaveLength(0);
  });

  it("legt Unterpunkte unter einem Punkt an", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /templates/t1/items", ({ body }) => ({ status: 201, body: { itemId: "i13", items: [n("i1", "Rucksack", [...tree()[0]!.children, n("i13", body.title, [], null, 2)], "Wetterfest", 0), tree()[1]!] } }));
    await ui.click(screen.getByRole("button", { name: "Unterpunkt zu Rucksack hinzufügen" }));
    await ui.type(await screen.findByLabelText("Neuer Unterpunkt von Rucksack"), "Mütze{Enter}");
    expect(await screen.findByText("Mütze")).toBeInTheDocument();
    expect(api.callsTo("POST /templates/t1/items")[0]!.body).toEqual({ title: "Mütze", parentItemId: "i1" });
  });

  it("bearbeitet Titel und Beschreibung eines Punkts im Dialog", async () => {
    const { api, ui } = await openEditor();
    api.on("PUT /template-items/i2", ({ body }) => ({ body: { items: [tree()[0]!, n("i2", body.title, [], body.description, 1)] } }));
    await ui.click(screen.getByRole("button", { name: "Route prüfen bearbeiten" }));
    const dialog = await screen.findByRole("dialog", { name: "Punkt bearbeiten" });
    expect(within(dialog).getByLabelText("Titel")).toHaveValue("Route prüfen");
    await ui.clear(within(dialog).getByLabelText("Titel"));
    await ui.type(within(dialog).getByLabelText("Titel"), "Route und Wetter prüfen");
    await ui.type(within(dialog).getByLabelText("Beschreibung (optional)"), "Komoot");
    await ui.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /template-items/i2")).toHaveLength(1));
    expect(api.callsTo("PUT /template-items/i2")[0]!.body).toEqual({ title: "Route und Wetter prüfen", description: "Komoot" });
    expect(await screen.findByText("Route und Wetter prüfen")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("löscht Punkte nach Rückfrage und nennt die Zahl der betroffenen Unterpunkte", async () => {
    const { api, ui } = await openEditor();
    api.on("DELETE /template-items/i1", () => ({ body: { items: [n("i2", "Route prüfen", [], null, 0)] } }));
    await ui.click(screen.getByRole("button", { name: "Rucksack löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Punkt löschen?" });
    expect(dialog).toHaveTextContent("samt 2 Unterpunkten");
    expect(api.callsTo("DELETE /template-items/i1")).toHaveLength(0);
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

  it("sendet für ↓, → und ← die richtigen Ziele an den Server", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /template-items/i1/move", () => ({ body: { items: tree() } })); // Antwort lässt den Baum unverändert, damit die weiteren Schritte gelten
    await ui.click(moveBtn("Rucksack nach unten"));
    await waitFor(() => expect(api.callsTo("POST /template-items/i1/move")).toHaveLength(1));
    expect(api.callsTo("POST /template-items/i1/move")[0]!.body).toEqual({ parentItemId: null, position: 1 });

    api.on("POST /template-items/i2/move", () => ({ body: { items: tree() } }));
    await ui.click(moveBtn("Route prüfen eine Ebene nach rechts (einrücken)"));
    await waitFor(() => expect(api.callsTo("POST /template-items/i2/move")).toHaveLength(1));
    expect(api.callsTo("POST /template-items/i2/move")[0]!.body).toEqual({ parentItemId: "i1", position: 2 });

    api.on("POST /template-items/i11/move", () => ({ body: { items: tree() } }));
    await ui.click(moveBtn("Sonnencreme eine Ebene nach links (ausrücken)"));
    await waitFor(() => expect(api.callsTo("POST /template-items/i11/move")).toHaveLength(1));
    expect(api.callsTo("POST /template-items/i11/move")[0]!.body).toEqual({ parentItemId: null, position: 1 });
  });

  it("zeigt das Ergebnis sofort (optimistisch) und übernimmt danach die Antwort des Servers", async () => {
    const { api, ui } = await openEditor();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    api.on("POST /template-items/i1/move", async () => {
      await gate;
      return { body: { items: [n("i2", "Route prüfen", [], null, 0), n("i1", "Rucksack", tree()[0]!.children, "Wetterfest", 1)] } };
    });
    await ui.click(moveBtn("Rucksack nach unten"));
    await waitFor(() => expect(titlesInOrder()).toEqual(["Route prüfen", "Rucksack", "Sonnencreme", "Regenjacke"])); // vor der Antwort
    release();
    await waitFor(() => expect(api.callsTo("POST /template-items/i1/move")).toHaveLength(1));
    expect(titlesInOrder()).toEqual(["Route prüfen", "Rucksack", "Sonnencreme", "Regenjacke"]);
  });

  it("macht eine abgelehnte Verschiebung rückgängig und erklärt den Grund", async () => {
    const { api, ui } = await openEditor();
    api.on("POST /template-items/i1/move", () => apiError(422, "cycle"));
    await ui.click(moveBtn("Rucksack nach unten"));
    expect(await screen.findByRole("alert")).toHaveTextContent("nicht in sich selbst");
    await waitFor(() => expect(titlesInOrder()).toEqual(["Rucksack", "Sonnencreme", "Regenjacke", "Route prüfen"])); // Zustand vom Server
  });

  it("bietet an jedem Punkt Griff, Aktionen und sprechende Namen", async () => {
    await openEditor();
    const rowEl = within(screen.getByTestId("item-i2"));
    expect(rowEl.getByRole("button", { name: /Route prüfen verschieben/ })).toBeInTheDocument();
    expect(rowEl.getByRole("group", { name: "Aktionen für Route prüfen" })).toBeInTheDocument();
    for (const name of ["Route prüfen nach oben", "Route prüfen nach unten", "Route prüfen bearbeiten", "Route prüfen löschen"]) expect(rowEl.getByRole("button", { name })).toBeInTheDocument();
  });
});

describe("Vorlagen-Editor: Export, Duplizieren, Löschen", () => {
  it("lädt JSON, CSV, Excel-CSV und Markdown über die Export-Schnittstelle", async () => {
    const { api, ui } = await openEditor();
    api.on("GET /templates/t1/export", () => ({ body: {} }));
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const box = within(screen.getByRole("group", { name: "Exportieren" }));
    for (const name of ["JSON", "CSV", "CSV für Excel (Semikolon)", "Markdown"]) await ui.click(box.getByRole("button", { name }));
    await waitFor(() => expect(api.callsTo("GET /templates/t1/export")).toHaveLength(4));
    expect(api.callsTo("GET /templates/t1/export").map((c) => c.path.split("?")[1])).toEqual(["format=json", "format=csv&delimiter=comma", "format=csv&delimiter=semicolon", "format=md"]);
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
