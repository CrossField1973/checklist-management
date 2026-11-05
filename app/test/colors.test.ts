import { describe, expect, it } from "vitest";
import {
  CANDIDATE_COLORS, DEFAULT_FIRST_COLOR, colorDistance, contrastRatio, pickDistinctColor, readableTextColor,
} from "../src/colors.js";

describe("Tag-Farben (F-18)", () => {
  it("liefert ohne vorhandene Tags die Standardfarbe", () => {
    expect(pickDistinctColor([])).toBe(DEFAULT_FIRST_COLOR);
  });

  it("wählt eine Farbe mit großem Abstand zur vorhandenen", () => {
    const next = pickDistinctColor(["#2563eb"]);
    expect(next).not.toBe("#2563eb");
    expect(colorDistance(next, "#2563eb")).toBeGreaterThan(0.25);
  });

  it("ist deterministisch und liefert nie eine bereits vergebene Farbe (1, 5 und 20 Tags)", () => {
    for (const n of [1, 5, 20]) {
      const colors: string[] = [];
      for (let i = 0; i < n; i++) colors.push(pickDistinctColor(colors));
      expect(new Set(colors).size).toBe(n);
      expect(pickDistinctColor(colors.slice(0, 1))).toBe(pickDistinctColor(colors.slice(0, 1)));
    }
  });

  it("hält den Mindestabstand deutlich über der Unterscheidbarkeitsgrenze (JND ≈ 0,02 in OKLab)", () => {
    const minDistance = (n: number) => {
      const colors: string[] = [];
      for (let i = 0; i < n; i++) colors.push(pickDistinctColor(colors));
      let min = Infinity;
      for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) min = Math.min(min, colorDistance(colors[i]!, colors[j]!));
      return min;
    };
    expect(minDistance(5)).toBeGreaterThan(0.15);
    expect(minDistance(12)).toBeGreaterThan(0.08);
    expect(minDistance(20)).toBeGreaterThan(0.06);
  });

  it("bevorzugt eine Farbe, die weit von mehreren dichten Nachbarn entfernt ist", () => {
    const existing = ["#dc2626", "#d97706", "#ca8a04"]; // rot/orange/gelb
    const next = pickDistinctColor(existing);
    const min = Math.min(...existing.map((e) => colorDistance(next, e)));
    // Besser als jede beliebig herausgegriffene Rot-/Orange-Variante
    expect(min).toBeGreaterThan(colorDistance("#b91c1c", "#dc2626"));
  });

  it("alle Kandidaten sind mit der automatisch gewählten Schriftfarbe AA-lesbar (≥ 4,5)", () => {
    for (const c of CANDIDATE_COLORS) expect(contrastRatio(c, readableTextColor(c))).toBeGreaterThanOrEqual(4.5);
  });

  it("wählt für beliebige Hintergründe die kontrastreichere Schriftfarbe", () => {
    expect(readableTextColor("#ffeb3b")).toBe("#000000");
    expect(readableTextColor("#1e3a8a")).toBe("#ffffff");
  });
});
