import { afterEach, describe, expect, it, vi } from "vitest";
import { addToTree } from "./tree";
import { newId } from "./id";

afterEach(() => vi.unstubAllGlobals());

describe("newId", () => {
  it("liefert auch ohne crypto.randomUUID (http im Heimnetz, kein sicherer Kontext) eindeutige UUIDs", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } });
    const ids = new Set(Array.from({ length: 50 }, newId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("Punkte lassen sich auch ohne crypto-Objekt anlegen", () => {
    vi.stubGlobal("crypto", undefined);
    const tree = addToTree([], "Zelt", null);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toMatch(/^tmp-/);
  });
});
