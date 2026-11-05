/** Farblogik für Tags (F-18): maximal unterscheidbare Farbe wählen, lesbare Textfarbe bestimmen. */

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_FIRST_COLOR = "#2563eb";

type Rgb = [number, number, number];
type Lab = [number, number, number];

const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB-Hexfarbe → OKLab (wahrnehmungsnaher Farbraum, Abstand = Unterschied fürs Auge). */
export function toOklab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function colorDistance(a: string, b: string): number {
  const x = toOklab(a);
  const y = toOklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Kandidaten: alle 10° ein Farbton in vier Helligkeitsstufen (Gamut-bedingt unterschiedlich viele wirken verschieden).
 * Die Beschriftung wählt automatisch Schwarz oder Weiß (readableTextColor), AA-Kontrast ≥ 4,5 ist für jede Farbe gegeben.
 */
export const CANDIDATE_COLORS: readonly string[] = (() => {
  const list: string[] = [];
  for (let h = 0; h < 360; h += 10) {
    for (const [s, l] of [[70, 32], [65, 42], [70, 55], [75, 68]] as const) list.push(hslToHex(h, s, l));
  }
  return list;
})();

/**
 * Wählt die Kandidatenfarbe mit dem größten Mindestabstand (OKLab) zu allen vorhandenen Tag-Farben.
 * Ohne vorhandene Tags: Standardblau. Bei Gleichstand gewinnt die zuerst gelistete Farbe (deterministisch).
 */
export function pickDistinctColor(existing: readonly string[]): string {
  if (existing.length === 0) return DEFAULT_FIRST_COLOR;
  const labs = existing.map(toOklab);
  let best = CANDIDATE_COLORS[0]!;
  let bestMin = -1;
  for (const candidate of CANDIDATE_COLORS) {
    const c = toOklab(candidate);
    let min = Infinity;
    for (const e of labs) min = Math.min(min, Math.hypot(c[0] - e[0], c[1] - e[1], c[2] - e[2]));
    if (min > bestMin + 1e-9) {
      bestMin = min;
      best = candidate;
    }
  }
  return best;
}

/** Schwarz oder Weiß – je nachdem, was auf der Tag-Farbe den besseren Kontrast ergibt (WCAG AA ≥ 4,5 für eine der beiden gegeben). */
export function readableTextColor(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000") ? "#ffffff" : "#000000";
}
