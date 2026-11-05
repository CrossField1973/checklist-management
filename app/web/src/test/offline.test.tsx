import "fake-indexeddb/auto";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { RunDetail, RunItemNode } from "../api/types";
import { kvGet } from "../offline/idb";
import { clearOfflineData, restoreCache, startPersisting } from "../offline/persist";
import { enqueue, flushQueue, getOps, resetQueue } from "../offline/queue";
import { apiError, mockApi, renderApp } from "./harness";

const item = (id: string, title: string): RunItemNode => ({ id, title, description: null, position: 0, isChecked: false, checkedAt: null, childProgress: { done: 0, total: 0 }, children: [] });
const run = (): RunDetail => ({
  id: "r1", title: "Ausflug", status: "active", createdAt: 1, updatedAt: 1, archivedAt: null, share: null, progress: { done: 0, total: 2 },
  sections: [{ id: "s1", title: "Tagesausflug", position: 0, sourceTemplateId: null, progress: { done: 0, total: 2 }, items: [item("a", "Rucksack"), item("b", "Route prüfen")] }],
});

let online = true;
const setOnline = (value: boolean) => {
  online = value;
  act(() => void window.dispatchEvent(new Event(value ? "online" : "offline")));
};
vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
afterEach(() => { resetQueue(); online = true; });

function runApi() {
  const api = mockApi();
  api.on("GET /runs/r1", () => ({ body: { run: run() } }));
  return api;
}

describe("Änderungswarteschlange (F-74)", () => {
  const op = (itemId: string, checked: boolean) => ({ kind: "check" as const, runId: "r1", label: itemId, itemId, checked });

  it("fasst mehrfaches Umschalten desselben Punkts zusammen – es zählt der letzte Wert", () => {
    enqueue(op("a", true)); enqueue(op("b", true)); enqueue(op("a", false));
    expect(getOps().map((o) => o.kind === "check" && `${o.itemId}:${o.checked}`)).toEqual(["b:true", "a:false"]);
  });

  it("überträgt in Reihenfolge und leert die Warteschlange", async () => {
    enqueue(op("a", true)); enqueue({ kind: "add", runId: "r1", label: "Brot", sectionId: "s1", parentItemId: null, title: "Brot", tempId: "tmp-1" });
    const sent: string[] = [];
    const res = await flushQueue(async (o) => { sent.push(o.kind); });
    expect(sent).toEqual(["check", "add"]);
    expect(res.done).toHaveLength(2);
    expect(getOps()).toEqual([]);
  });

  it("bricht ohne Verbindung oder bei Serverfehlern ab und behält den Rest", async () => {
    enqueue(op("a", true)); enqueue(op("b", true)); enqueue(op("c", true));
    let n = 0;
    await flushQueue(async () => { if (++n === 2) throw new ApiError(0, "network_error"); });
    expect(getOps().map((o) => o.kind === "check" && o.itemId)).toEqual(["b", "c"]);
    await flushQueue(async () => { throw new ApiError(503, "http_503"); });
    expect(getOps()).toHaveLength(2);
  });

  it("meldet Löschkonflikte (404) und archivierte Durchführungen (409), verwirft sie und macht weiter", async () => {
    enqueue(op("a", true)); enqueue(op("b", true)); enqueue(op("c", true));
    const res = await flushQueue(async (o) => {
      if (o.kind === "check" && o.itemId === "a") throw new ApiError(404, "not_found");
      if (o.kind === "check" && o.itemId === "b") throw new ApiError(409, "run_not_active");
    });
    expect(res.conflicts.map((c) => c.error)).toEqual(["not_found", "run_not_active"]);
    expect(res.done).toHaveLength(1);
    expect(getOps()).toEqual([]);
  });
});

describe("Offline in der Oberfläche", () => {
  it("hakt offline ab, merkt die Änderung vor und überträgt sie bei Verbindung", async () => {
    const api = runApi();
    api.on("PUT /run-items/b", () => ({ body: { run: run() } }));
    const { ui } = renderApp("/runs/r1");
    const box = await screen.findByRole("checkbox", { name: "Route prüfen" });
    setOnline(false);
    await ui.click(box);
    expect(screen.getByRole("checkbox", { name: "Route prüfen" })).toBeChecked(); // sofort sichtbar
    expect(api.callsTo("PUT /run-items/b")).toHaveLength(0);
    expect(await screen.findByText(/Du bist offline/)).toHaveTextContent("1 Änderung wartet auf die Übertragung");

    setOnline(true);
    await waitFor(() => expect(api.callsTo("PUT /run-items/b")).toHaveLength(1));
    expect(api.callsTo("PUT /run-items/b")[0]!.body).toEqual({ isChecked: true });
    expect(await screen.findByText(/1 Änderung wurde übertragen/)).toBeInTheDocument();
    expect(screen.queryByText(/Du bist offline/)).not.toBeInTheDocument();
  });

  it("legt offline Punkte an (gekennzeichnet, nicht abhakbar) und überträgt sie später", async () => {
    const api = runApi();
    api.on("POST /run-sections/s1/items", () => ({ status: 201, body: { itemId: "n", run: run() } }));
    const { ui } = renderApp("/runs/r1");
    await screen.findByRole("checkbox", { name: "Rucksack" });
    setOnline(false);
    await ui.type(screen.getByLabelText("Neuer Punkt in Tagesausflug"), "Sonnenbrille{Enter}");
    const box = await screen.findByRole("checkbox", { name: "Sonnenbrille" });
    expect(box).toBeDisabled();
    expect(box.closest("li")).toHaveTextContent("wartet auf Übertragung");
    expect(api.callsTo("POST /run-sections/s1/items")).toHaveLength(0);

    setOnline(true);
    await waitFor(() => expect(api.callsTo("POST /run-sections/s1/items")[0]!.body).toEqual({ title: "Sonnenbrille", parentItemId: null }));
  });

  it("merkt Änderungen auch vor, wenn das Gerät online ist, der Server aber nicht antwortet", async () => {
    const api = runApi();
    let reachable = false;
    api.on("PUT /run-items/b", () => { if (!reachable) throw new TypeError("Failed to fetch"); return { body: { run: run() } }; });
    const { ui } = renderApp("/runs/r1");
    await ui.click(await screen.findByRole("checkbox", { name: "Route prüfen" }));
    expect(await screen.findByText(/1 Änderung wird übertragen/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // kein Fehler, nur vorgemerkt
    reachable = true;
    setOnline(false); setOnline(true); // Verbindungswechsel löst die Übertragung aus
    await waitFor(() => expect(getOps()).toHaveLength(0));
  });

  it("meldet verworfene Änderungen mit Namen und Grund", async () => {
    const api = runApi();
    api.on("PUT /run-items/b", () => apiError(404, "not_found"));
    const { ui } = renderApp("/runs/r1");
    const box = await screen.findByRole("checkbox", { name: "Route prüfen" });
    setOnline(false);
    await ui.click(box);
    setOnline(true);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 Änderung konnte nicht übertragen werden und wurde verworfen");
    expect(within(alert).getByText(/Route prüfen – Der Punkt, der Abschnitt oder die Durchführung existiert nicht mehr/)).toBeInTheDocument();
  });

  it("meldet sich der Nutzer ab, wird der lokale Datenbestand entfernt", async () => {
    const api = runApi();
    api.on("POST /auth/logout", () => ({ status: 204 }));
    const { ui } = renderApp("/runs/r1");
    await screen.findByRole("checkbox", { name: "Rucksack" });
    await waitFor(async () => expect(await kvGet("cache")).toBeTruthy(), { timeout: 4000 });
    setOnline(false);
    await ui.click(screen.getByRole("checkbox", { name: "Route prüfen" }));
    await waitFor(async () => expect(await kvGet("queue")).toBeTruthy());
    setOnline(true);
    api.on("PUT /run-items/b", () => ({ status: 500, body: {} })); // Übertragung scheitert → Warteschlange bleibt bis zur Abmeldung
    await ui.click(screen.getByRole("button", { name: "Abmelden" }));
    await waitFor(async () => expect(await kvGet("cache")).toBeUndefined());
    expect(await kvGet("queue")).toBeUndefined();
    expect(getOps()).toEqual([]);
  });
});

describe("Lokaler Zwischenspeicher (IndexedDB)", () => {
  const filled = () => {
    const qc = new QueryClient();
    qc.setQueryData(["run", "r1"], run());
    qc.setQueryData(["runs", { status: "active" }], { total: 1, runs: [] });
    qc.setQueryData(["run-share", "r1"], { share: { url: "http://x/s/geheimer-token" } }); // darf nie lokal gespeichert werden
    qc.setQueryData(["me"], { id: "u1" });
    return qc;
  };

  it("speichert nur Durchführungen, Vorlagen und Tags – nicht Freigabelinks oder Kontodaten – und stellt sie für denselben Nutzer wieder her", async () => {
    const stop = startPersisting(filled(), "u1");
    await waitFor(async () => expect(await kvGet("cache")).toBeTruthy(), { timeout: 4000 });
    stop();
    const raw = JSON.stringify(await kvGet("cache"));
    expect(raw).not.toContain("geheimer-token");
    expect(raw).not.toContain('"me"');

    const fresh = new QueryClient();
    await restoreCache(fresh, "u1");
    expect((fresh.getQueryData(["run", "r1"]) as RunDetail).title).toBe("Ausflug");
    expect(fresh.getQueryData(["run-share", "r1"])).toBeUndefined();
  });

  it("stellt Daten eines anderen Nutzers nie wieder her und löscht sie", async () => {
    const stop = startPersisting(filled(), "u1");
    await waitFor(async () => expect(await kvGet("cache")).toBeTruthy(), { timeout: 4000 });
    stop();
    const other = new QueryClient();
    await restoreCache(other, "u2");
    expect(other.getQueryData(["run", "r1"])).toBeUndefined();
    expect(await kvGet("cache")).toBeUndefined();
  });

  it("clearOfflineData entfernt Zwischenspeicher, Warteschlange und Nutzer", async () => {
    startPersisting(filled(), "u1");
    enqueue({ kind: "check", runId: "r1", label: "x", itemId: "a", checked: true });
    await waitFor(async () => expect(await kvGet("cache")).toBeTruthy(), { timeout: 4000 });
    await clearOfflineData();
    expect(await kvGet("cache")).toBeUndefined();
    expect(await kvGet("queue")).toBeUndefined();
    expect(getOps()).toEqual([]);
  });
});
