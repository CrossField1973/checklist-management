import { describe, expect, it } from "vitest";
import { detectDelimiter, guardFormula, parseCsv, toCsv, unguardFormula } from "../src/services/csv.js";

describe("CSV lesen", () => {
  it("zerlegt einfache Zeilen mit Komma, Semikolon und Tab", () => {
    expect(parseCsv("a,b,c\n1,2,3", ",").rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a;b\n1;2", ";").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("versteht Anführungszeichen: Trennzeichen, Zeilenumbrüche und verdoppelte Anführungszeichen in Feldern", () => {
    const { rows } = parseCsv('Titel,Text\n"a, b","Zeile 1\nZeile 2"\n"sagt ""hallo""",x', ",");
    expect(rows).toEqual([["Titel", "Text"], ["a, b", "Zeile 1\nZeile 2"], ['sagt "hallo"', "x"]]);
  });

  it("akzeptiert CRLF, CR, BOM, leere Zeilen und fehlendes Zeilenende", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4", ",").rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("a,b\r1,2\r", ",").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("behält leere Felder und leere letzte Spalten", () => {
    expect(parseCsv("a,,c\n,,\n1,2,", ",").rows).toEqual([["a", "", "c"], ["", "", ""], ["1", "2", ""]]);
  });

  it("liefert Zeilennummern je Datensatz, auch nach mehrzeiligen Feldern", () => {
    const { lines } = parseCsv('h1,h2\n"a\nb",x\n\n3,4', ",");
    expect(lines).toEqual([1, 2, 5]);
  });

  it("meldet nicht geschlossene Anführungszeichen mit Zeilennummer", () => {
    expect(() => parseCsv('a,b\n1,"offen\n2,3', ",")).toThrow(/Zeile 2/);
  });

  it("erkennt das Trennzeichen an der Kopfzeile (Anführungszeichen zählen nicht mit)", () => {
    expect(detectDelimiter("Vorlage;Ebene;Titel")).toBe(";");
    expect(detectDelimiter("Vorlage\tEbene\tTitel")).toBe("\t");
    expect(detectDelimiter("Vorlage,Ebene,Titel")).toBe(",");
    expect(detectDelimiter('"A,B";C;D')).toBe(";");
    expect(detectDelimiter("Titel")).toBe(",");
    expect(detectDelimiter("﻿a;b;c,d")).toBe(";");
  });
});

describe("CSV schreiben", () => {
  it("setzt BOM und CRLF und setzt Felder nur bei Bedarf in Anführungszeichen", () => {
    const out = toCsv([["a", "b,c", 'd"e', "x\ny", " f"]], ",");
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe('﻿a,"b,c","d""e","x\ny"," f"\r\n');
  });

  it("ist umkehrbar: Schreiben und Lesen ergibt dieselben Zellen (auch bei Sonderzeichen)", () => {
    const rows = [["Vorlage", "Ebene", "Titel"], ["Ü,ß;\"x\"", "1", "Zeile\nUmbruch"], ["a", "2", " mit Leerzeichen "], ["", "", ""]];
    for (const d of [",", ";", "\t"] as const) {
      const parsed = parseCsv(toCsv(rows, d), d).rows;
      expect(parsed.slice(0, 3)).toEqual(rows.slice(0, 3));
    }
  });

  it("schützt vor Formel-Injektion und stellt Originale beim Lesen wieder her", () => {
    for (const bad of ["=1+1", "+49 170", "-5 Grad", "@SUM(A1)", "\tTab"]) {
      expect(guardFormula(bad)).toBe(`'${bad}`);
      expect(unguardFormula(guardFormula(bad))).toBe(bad);
    }
    expect(guardFormula("normal")).toBe("normal");
    expect(unguardFormula("'normal")).toBe("'normal"); // fremdes Apostroph bleibt erhalten
    expect(unguardFormula("'=x")).toBe("=x");
    const csv = toCsv([["=HYPERLINK(\"http://evil\")", "ok"]], ",");
    expect(csv).toContain("'=HYPERLINK");
    expect(parseCsv(csv, ",").rows[0]![0]!.startsWith("'=")).toBe(true);
  });
});
