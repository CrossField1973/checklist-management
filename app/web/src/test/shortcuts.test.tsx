import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp } from "./harness";

const lists = () => {
  const api = mockApi();
  api.on("GET /runs", () => ({ body: { runs: [], total: 0, page: 1, pageSize: 20 } }));
  api.on("GET /templates", () => ({ body: { templates: [], total: 0, page: 1, pageSize: 20 } }));
  api.on("GET /tags", () => ({ body: { tags: [] } }));
  return api;
};

describe("Tastenkürzel", () => {
  it("? öffnet die Hilfe", async () => {
    lists();
    const { ui } = renderApp("/");
    await screen.findByRole("heading", { name: "Meine Checklisten", level: 1 });
    await ui.keyboard("?");
    const help = await screen.findByRole("dialog", { name: "Tastenkürzel" });
    await ui.click(within(help).getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("N öffnet auf der Vorlagenliste den Dialog zum Anlegen", async () => {
    lists();
    const { ui } = renderApp("/templates");
    await screen.findByRole("heading", { name: "Vorlagen", level: 1 });
    await ui.keyboard("n");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("Einzeltasten wirken nicht beim Tippen in einem Textfeld", async () => {
    lists();
    const { ui } = renderApp("/templates");
    await screen.findByRole("heading", { name: "Vorlagen", level: 1 });
    await ui.keyboard("/");
    const search = await screen.findByRole("searchbox");
    expect(search).toHaveFocus();
    await ui.keyboard("n?");
    expect(search).toHaveValue("n?");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
