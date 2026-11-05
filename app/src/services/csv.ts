/** Minimaler CSV-Leser/-Schreiber (RFC 4180) mit Schutz vor Formel-Injektion beim Export. */

export type Delimiter = "," | ";" | "\t";
export const DELIMITERS: Record<"comma" | "semicolon" | "tab", Delimiter> = { comma: ",", semicolon: ";", tab: "\t" };

export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Erkennt das Trennzeichen anhand der Kopfzeile (außerhalb von Anführungszeichen); Standard: Komma. */
export function detectDelimiter(text: string): Delimiter {
  const first = stripBom(text).split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as Delimiter] += 1;
  }
  const best = (Object.entries(counts) as [Delimiter, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ",";
}

export interface ParsedCsv {
  rows: string[][];
  /** Zeilennummer (1-basiert, inkl. Kopfzeile) je Datensatz – für Fehlermeldungen */
  lines: number[];
}

/** Zerlegt CSV-Text. Leere Zeilen werden übersprungen. Wirft bei nicht geschlossenen Anführungszeichen. */
export function parseCsv(input: string, delimiter: Delimiter): ParsedCsv {
  const text = stripBom(input);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let hadQuote = false;

  const endField = () => { row.push(field); field = ""; hadQuote = false; };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) { rows.push(row); lines.push(startLine); }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"' && field === "" && !hadQuote) {
      quoted = true; hadQuote = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow(); line++; startLine = line;
    } else if (ch === "\n") {
      endRow(); line++; startLine = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error(`Anführungszeichen in Zeile ${startLine} nicht geschlossen`);
  if (field !== "" || row.length > 0) endRow();
  return { rows, lines };
}

/** Zellen, die Tabellenkalkulationen als Formel deuten würden, werden mit ' markiert (OWASP „CSV Injection“). */
const FORMULA_START = /^[=+\-@\t\r]/;
export const guardFormula = (v: string) => (FORMULA_START.test(v) ? `'${v}` : v);
/** Gegenstück beim Import: entfernt nur das von guardFormula gesetzte führende '. */
export const unguardFormula = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

const quote = (v: string, delimiter: Delimiter) =>
  v.includes(delimiter) || /["\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;

/** Erzeugt CSV mit CRLF-Zeilenenden und UTF-8-BOM (damit Excel Umlaute richtig liest). */
export function toCsv(rows: string[][], delimiter: Delimiter = ","): string {
  return "﻿" + rows.map((r) => r.map((c) => quote(guardFormula(c), delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}
