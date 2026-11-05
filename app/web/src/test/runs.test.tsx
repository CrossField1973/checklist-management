import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunItemNode, RunSummary, TemplateSummary, TrashEntry } from "../api/types";
import { apiError, mockApi, renderApp } from "./harness";

const item = (id: string, title: string, isChecked = false, children: RunItemNode[] = []): RunItemNode => ({
  id, title, description: null, position: 0, isChecked, checkedAt: null,
  childProgress: { done: children.filter((c) => c.isChecked).length, total: children.length }, children,
});
const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  id: "r1", title: "Ausflug Füssen", status: "active", createdAt: 1, updatedAt: 1, archivedAt: null, share: null, progress: { done: 1, total: 4 },
  sections: [{
    id: "s1", title: "Tagesausflug", position: 0, sourceTemplateId: "t1", progress: { done: 1, total: 4 },
    items: [item("a", "Rucksack", true), item("b", "Route prüfen"), item("c", "Proviant", false, [item("d", "Brot")])],
  }],
  ...over,
});
const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "r1", title: "Ausflug Füssen", status: "active", createdAt: 1, updatedAt: 1_700_000_000_000, archivedAt: null,
  sectionTitles: ["Tagesausflug", "Therme"], progress: { done: 1, total: 4 }, share: null, ...over,
});
const tpl = (id: string, title: string): TemplateSummary => ({ id, title, description: null, tags: [], itemCount: 1, createdAt: 1, updatedAt: 1 });

function runsApi(list: RunSummary[] = [summary(), summary({ id: "r2", title: "Putzen", sectionTitles: ["Wohnung"], progress: { done: 0, total: 0 }, share: { access: "password", permission: "edit" } })]) {
  const api = mockApi();
  api.on("GET /runs", () => ({ body: { total: list.length, runs: list } }));
  api.on("GET /runs/r1", () => ({ body: { run: detail() } }));
  api.on("GET /templates", () => ({ body: { total: 2, templates: [tpl("t1", "Tagesausflug"), tpl("t2", "Therme")] } }));
  return api;
}

describe("Durchführungen – Startseite (F-20)", () => {
  it("zeigt Fortschritt und kennzeichnet nur geteilte Durchführungen", async () => {
    runsApi();
    renderApp("/");
    const first = (await screen.findByRole("link", { name: "Ausflug Füssen" })).closest("li")!;
    expect(first).toHaveTextContent("1/4");
    expect(first).toHaveTextContent("Tagesausflug · Therme");
    expect(within(first).queryByTestId("share-badge")).not.toBeInTheDocument();
    const second = screen.getByRole("link", { name: "Putzen" }).closest("li")!;
    expect(within(second).getByTestId("share-badge")).toHaveTextContent(/Geteilt/);
    expect(screen.getByText("2 Durchführungen")).toBeInTheDocument();
  });

  it("zeigt bei leerer Liste einen Hinweis mit Schaltfläche zum Anlegen", async () => {
    runsApi([]);
    renderApp("/");
    expect(await screen.findByText(/Noch keine aktive Durchführung/)).toBeInTheDocument();
  });

  it("legt eine Durchführung aus mehreren Vorlagen an – in der Reihenfolge der Auswahl – und öffnet sie", async () => {
    const api = runsApi();
    api.on("POST /runs", () => ({ status: 201, body: { run: detail() } }));
    const { ui } = renderApp("/");
    await screen.findByRole("link", { name: "Putzen" });
    await ui.click(screen.getByRole("button", { name: /Neue Durchführung/ }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText("Titel"), "Ausflug Füssen");
    await ui.click(await within(dialog).findByLabelText("Therme"));
    await ui.click(within(dialog).getByLabelText("Tagesausflug"));
    expect(within(dialog).getByText("2 Vorlagen gewählt")).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(api.callsTo("POST /runs")[0]!.body).toEqual({ title: "Ausflug Füssen", templateIds: ["t2", "t1"] }));
    expect(await screen.findByRole("heading", { name: "Ausflug Füssen", level: 1 })).toBeInTheDocument();
  });

  it("legt ohne Titel nichts an", async () => {
    runsApi();
    const { ui } = renderApp("/");
    await screen.findByRole("link", { name: "Putzen" });
    await ui.click(screen.getByRole("button", { name: /Neue Durchführung/ }));
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Anlegen" })).toBeDisabled();
  });
});

describe("Durchführung bearbeiten (F-23 bis F-26)", () => {
  it("hakt Punkte sofort ab und speichert mit dem Server", async () => {
    const api = runsApi();
    api.on("PUT /run-items/b", () => ({ body: { run: detail({ progress: { done: 2, total: 4 }, sections: [{ ...detail().sections[0]!, items: [item("a", "Rucksack", true), item("b", "Route prüfen", true), item("c", "Proviant", false, [item("d", "Brot")])] }] }) } }));
    const { ui } = renderApp("/runs/r1");
    const box = await screen.findByRole("checkbox", { name: "Route prüfen" });
    expect(box).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rucksack" })).toBeChecked();
    await ui.click(box);
    await waitFor(() => expect(api.callsTo("PUT /run-items/b")[0]!.body).toEqual({ isChecked: true }));
    expect(screen.getByRole("checkbox", { name: "Route prüfen" })).toBeChecked();
    expect(screen.getByRole("progressbar", { name: "Fortschritt von Ausflug Füssen" })).toHaveAttribute("aria-valuenow", "2");
  });

  it("macht das Abhaken rückgängig und zeigt den Fehler, wenn der Server ablehnt", async () => {
    const api = runsApi();
    api.on("PUT /run-items/b", () => apiError(409, "run_not_active"));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("checkbox", { name: "Route prüfen" }));
    expect(await screen.findByText(/archiviert und schreibgeschützt/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Route prüfen" })).not.toBeChecked());
  });

  it("fügt eigene Punkte und Unterpunkte hinzu", async () => {
    const api = runsApi();
    api.on("POST /run-sections/s1/items", () => ({ status: 201, body: { itemId: "x", run: detail() } }));
    const { ui } = renderApp("/runs/r1");
    await ui.type(await screen.findByLabelText("Neuer Punkt in Tagesausflug"), "Sonnenbrille{Enter}");
    await waitFor(() => expect(api.callsTo("POST /run-sections/s1/items")[0]!.body).toEqual({ title: "Sonnenbrille", parentItemId: null }));
    await ui.click(screen.getByRole("button", { name: "Unterpunkt zu Route prüfen hinzufügen" }));
    await ui.type(await screen.findByLabelText("Neuer Unterpunkt von Route prüfen"), "Karte{Enter}");
    await waitFor(() => expect(api.callsTo("POST /run-sections/s1/items")[1]!.body).toEqual({ title: "Karte", parentItemId: "b" }));
  });

  it("löscht einen Punkt erst nach Rückfrage", async () => {
    const api = runsApi();
    api.on("DELETE /run-items/b", () => ({ body: { run: detail() } }));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: "Route prüfen löschen" }));
    expect(api.callsTo("DELETE /run-items/b")).toHaveLength(0);
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /run-items/b")).toHaveLength(1));
  });

  it("ergänzt Vorlagen nachträglich als neue Abschnitte (F-22)", async () => {
    const api = runsApi();
    api.on("POST /runs/r1/sections", () => ({ status: 201, body: { run: detail() } }));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: /Vorlagen hinzufügen/ }));
    const dialog = await screen.findByRole("dialog");
    await ui.click(await within(dialog).findByLabelText("Therme"));
    await ui.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() => expect(api.callsTo("POST /runs/r1/sections")[0]!.body).toEqual({ templateIds: ["t2"] }));
  });

  it("zeigt einen Hinweis, wenn die Durchführung nicht existiert", async () => {
    const api = runsApi();
    api.on("GET /runs/r1", () => apiError(404, "not_found"));
    renderApp("/runs/r1");
    expect(await screen.findByText("Diese Durchführung gibt es nicht (mehr).")).toBeInTheDocument();
  });
});

describe("Abschließen, Archivieren, Archiv (F-27 bis F-30)", () => {
  it("‚Abschließen‘ verschiebt in den Papierkorb und kehrt zur Startseite zurück", async () => {
    const api = runsApi();
    api.on("POST /runs/r1/complete", () => ({ status: 204 }));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: "Beenden …" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Abschließen" }));
    await waitFor(() => expect(api.callsTo("POST /runs/r1/complete")).toHaveLength(1));
    expect(await screen.findByText(/wurde abgeschlossen und liegt im Papierkorb/)).toBeInTheDocument();
  });

  it("‚Archivieren‘ führt ins Archiv", async () => {
    const api = runsApi();
    api.on("POST /runs/r1/archive", () => ({ body: { run: detail({ status: "archived" }) } }));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: "Beenden …" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(api.callsTo("POST /runs/r1/archive")).toHaveLength(1));
    expect(await screen.findByText(/wurde archiviert/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Archiv", level: 1 })).toBeInTheDocument();
  });

  it("archivierte Durchführungen sind schreibgeschützt und lassen sich wieder öffnen", async () => {
    const api = runsApi();
    api.on("GET /runs/r1", () => ({ body: { run: detail({ status: "archived", archivedAt: 5 }) } }));
    api.on("POST /runs/r1/reopen", () => ({ body: { run: detail() } }));
    const { ui } = renderApp("/runs/r1");
    expect(await screen.findByRole("checkbox", { name: "Route prüfen" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Teilen/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Neuer Punkt in Tagesausflug")).not.toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "Wieder öffnen" }));
    await waitFor(() => expect(api.callsTo("POST /runs/r1/reopen")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Route prüfen" })).toBeEnabled());
  });

  it("Archivliste: wieder öffnen und löschen (→ Papierkorb)", async () => {
    const api = runsApi([summary({ status: "archived", archivedAt: 1_700_000_000_000 })]);
    api.on("POST /runs/r1/reopen", () => ({ body: { run: detail() } }));
    api.on("DELETE /runs/r1", () => ({ status: 204 }));
    const { ui } = renderApp("/archive");
    expect(api.callsTo("GET /runs")).toHaveLength(0);
    await ui.click(await screen.findByRole("button", { name: "Ausflug Füssen wieder öffnen" }));
    await waitFor(() => expect(api.callsTo("POST /runs/r1/reopen")).toHaveLength(1));
    expect(new URL(api.callsTo("GET /runs")[0]!.path, "http://x").searchParams.get("status")).toBe("archived");
    await ui.click(await screen.findByRole("button", { name: "Ausflug Füssen löschen" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /runs/r1")).toHaveLength(1));
  });
});

describe("Teilen (F-40 bis F-43)", () => {
  const share = { id: "sh1", access: "anyone", permission: "view", url: "http://localhost:3000/s/abcdefghij", createdAt: 1 };

  it("erstellt einen Link, zeigt ihn an und kann das Teilen beenden", async () => {
    const api = runsApi();
    let current: typeof share | null = null;
    api.on("GET /runs/r1/share", () => ({ body: { share: current } }));
    api.on("PUT /runs/r1/share", (c) => { current = { ...share, ...c.body }; return { status: 201, body: { share: current } }; });
    api.on("DELETE /runs/r1/share", () => { current = null; return { status: 204 }; });
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: "Teilen …" }));
    const dialog = await screen.findByRole("dialog");
    await ui.click(await within(dialog).findByRole("button", { name: "Link erstellen" }));
    await waitFor(() => expect(api.callsTo("PUT /runs/r1/share")[0]!.body).toEqual({ access: "anyone", permission: "view" }));
    expect(await within(dialog).findByLabelText("Freigabelink")).toHaveValue(share.url);
    await ui.click(within(dialog).getByRole("button", { name: "Teilen beenden" }));
    await waitFor(() => expect(api.callsTo("DELETE /runs/r1/share")).toHaveLength(1));
    expect(await within(dialog).findByRole("button", { name: "Link erstellen" })).toBeInTheDocument();
  });

  it("verlangt für den Zugriff mit Passwort ein Passwort", async () => {
    const api = runsApi();
    api.on("GET /runs/r1/share", () => ({ body: { share: null } }));
    api.on("PUT /runs/r1/share", () => apiError(422, "password_required"));
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("button", { name: "Teilen …" }));
    const dialog = await screen.findByRole("dialog");
    await ui.selectOptions(await within(dialog).findByLabelText("Zugriff"), "password");
    await ui.click(within(dialog).getByRole("button", { name: "Link erstellen" }));
    expect(await within(dialog).findByText(/Passwort mit mindestens 8 Zeichen/)).toBeInTheDocument();
  });
});

describe("Papierkorb (F-31)", () => {
  const entries: TrashEntry[] = [
    { type: "run", id: "r1", title: "Ausflug Füssen", deletedAt: 1_700_000_000_000, purgeAt: 1_702_592_000_000, statusBeforeDelete: "active", progress: { done: 3, total: 4 } },
    { type: "template", id: "t1", title: "Tagesausflug", deletedAt: 1_690_000_000_000, purgeAt: null },
  ];
  function trashApi() {
    const api = mockApi();
    api.on("GET /trash", () => ({ body: { retentionDays: 30, items: entries } }));
    return api;
  }

  it("listet Einträge mit Typ und Löschdatum und stellt wieder her", async () => {
    const api = trashApi();
    api.on("POST /trash/run/r1/restore", () => ({ status: 204 }));
    const { ui } = renderApp("/trash");
    const row = (await screen.findByText("Ausflug Füssen")).closest("li")!;
    expect(row).toHaveTextContent("Durchführung");
    expect(row).toHaveTextContent("3/4");
    expect(screen.getByText(/nach 30 Tagen endgültig gelöscht/)).toBeInTheDocument();
    await ui.click(within(row).getByRole("button", { name: "Ausflug Füssen wiederherstellen" }));
    await waitFor(() => expect(api.callsTo("POST /trash/run/r1/restore")).toHaveLength(1));
    expect(await screen.findByText(/wurde wiederhergestellt/)).toBeInTheDocument();
  });

  it("löscht endgültig erst nach Rückfrage – einzeln und alles", async () => {
    const api = trashApi();
    api.on("DELETE /trash/template/t1", () => ({ status: 204 }));
    api.on("DELETE /trash", () => ({ body: { templates: 1, runs: 1 } }));
    const { ui } = renderApp("/trash");
    await ui.click(await screen.findByRole("button", { name: "Tagesausflug endgültig löschen" }));
    expect(api.callsTo("DELETE /trash/template/t1")).toHaveLength(0);
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(api.callsTo("DELETE /trash/template/t1")).toHaveLength(1));
    await ui.click(screen.getByRole("button", { name: "Papierkorb leeren" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Papierkorb leeren" }));
    await waitFor(() => expect(api.callsTo("DELETE /trash")).toHaveLength(1));
  });

  it("zeigt einen leeren Papierkorb", async () => {
    const api = mockApi();
    api.on("GET /trash", () => ({ body: { retentionDays: null, items: [] } }));
    renderApp("/trash");
    expect(await screen.findByText("Der Papierkorb ist leer.")).toBeInTheDocument();
    expect(screen.getByText(/bis du sie löschst/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Papierkorb leeren" })).not.toBeInTheDocument();
  });
});

describe("Öffentliche Ansicht /s/<token>", () => {
  const view = (permission: "view" | "edit") => ({ permission, run: { title: "Ausflug Füssen", updatedAt: 1, progress: { done: 1, total: 4 }, sections: detail().sections } });
  const TOKEN = "abcdefghij123";

  it("funktioniert ohne Anmeldung; nur ansehen sperrt alle Eingaben", async () => {
    const api = mockApi({ user: null });
    api.on(`GET /public/runs/${TOKEN}`, () => ({ body: view("view") }));
    renderApp(`/s/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "Ausflug Füssen", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Route prüfen" })).toBeDisabled();
    expect(screen.queryByLabelText("Neuer Punkt in Tagesausflug")).not.toBeInTheDocument();
    expect(screen.getByText(/Du kannst diese Durchführung ansehen/)).toBeInTheDocument();
  });

  it("verlangt bei passwortgeschützten Links das Passwort und sendet es als Header", async () => {
    const api = mockApi({ user: null });
    api.on(`GET /public/runs/${TOKEN}`, (c) => {
      const pw = c.headers["x-share-password"];
      if (!pw) return apiError(401, "password_required");
      return pw === "geheim-geheim" ? { body: view("view") } : apiError(401, "invalid_password");
    });
    const { ui } = renderApp(`/s/${TOKEN}`);
    await ui.type(await screen.findByLabelText("Passwort"), "falsch-falsch{Enter}");
    expect(await screen.findByText("Das Passwort ist falsch.")).toBeInTheDocument();
    await ui.clear(screen.getByLabelText("Passwort"));
    await ui.type(screen.getByLabelText("Passwort"), "geheim-geheim{Enter}");
    expect(await screen.findByRole("heading", { name: "Ausflug Füssen", level: 1 })).toBeInTheDocument();
    expect(JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage)).not.toContain("geheim");
  });

  it("mit Bearbeiten-Recht lassen sich Punkte abhaken", async () => {
    const api = mockApi({ user: null });
    api.on(`GET /public/runs/${TOKEN}`, () => ({ body: view("edit") }));
    api.on(`PUT /public/runs/${TOKEN}/items/b`, () => ({ body: view("edit") }));
    const { ui } = renderApp(`/s/${TOKEN}`);
    await ui.click(await screen.findByRole("checkbox", { name: "Route prüfen" }));
    await waitFor(() => expect(api.callsTo(`PUT /public/runs/${TOKEN}/items/b`)[0]!.body).toEqual({ isChecked: true }));
  });

  it("meldet ungültige oder beendete Links", async () => {
    const api = mockApi({ user: null });
    api.on(`GET /public/runs/${TOKEN}`, () => apiError(404, "not_found"));
    renderApp(`/s/${TOKEN}`);
    expect(await screen.findByText("Dieser Link ist ungültig oder wurde beendet.")).toBeInTheDocument();
  });
});
