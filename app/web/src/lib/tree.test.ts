import { describe, expect, it } from "vitest";
import {
  countNodes, descendantIds, findNode, findParentId, flatten, getProjection, indentTarget, isSamePlace, moveDownTarget, moveInTree,
  moveUpTarget, outdentTarget, getBoardProjection, moveBetweenSections, withProgress, type BoardRow, type ItemNode,
} from "./tree";

const n = (id: string, children: ItemNode[] = [], position = 0): ItemNode => ({ id, title: id, description: null, position, children });
/** A[A1,A2], B, C – wie in den Server-Tests */
const sample = (): ItemNode[] => [n("A", [n("A1", [], 0), n("A2", [], 1)], 0), n("B", [], 1), n("C", [], 2)];
const shape = (tree: ItemNode[]): unknown[] => tree.map((x) => (x.children.length ? [x.id, shape(x.children)] : x.id));
const positionsOk = (tree: ItemNode[]): boolean => tree.every((x, i) => x.position === i && positionsOk(x.children));

describe("Baum-Hilfen", () => {
  it("flacht in Pre-Order ab, mit Ebene und Index, und lässt Nachfahren eingeklappter Punkte weg", () => {
    const flat = flatten(sample());
    expect(flat.map((f) => [f.id, f.depth, f.index, f.parentId])).toEqual([["A", 0, 0, null], ["A1", 1, 0, "A"], ["A2", 1, 1, "A"], ["B", 0, 1, null], ["C", 0, 2, null]]);
    expect(flatten(sample(), new Set(["A"])).map((f) => f.id)).toEqual(["A", "B", "C"]);
  });

  it("findet Punkte, Eltern und Nachfahren", () => {
    const t = sample();
    expect(findNode(t, "A2")?.id).toBe("A2");
    expect(findNode(t, "X")).toBeNull();
    expect([findParentId(t, "A2"), findParentId(t, "A"), findParentId(t, "X")]).toEqual(["A", null, undefined]);
    expect(descendantIds(t[0]!)).toEqual(["A1", "A2"]);
    expect(countNodes(t)).toBe(5);
  });
});

describe("moveInTree entspricht dem Verhalten des Servers", () => {
  it("sortiert innerhalb einer Ebene um und nummeriert neu", () => {
    const r = moveInTree(sample(), "C", null, 0)!;
    expect(shape(r)).toEqual(["C", ["A", ["A1", "A2"]], "B"]);
    expect(positionsOk(r)).toBe(true);
  });

  it("verschiebt zwischen Ebenen (rein und raus) und nummeriert beide Ebenen", () => {
    let r = moveInTree(sample(), "B", "A", 1)!;
    expect(shape(r)).toEqual([["A", ["A1", "B", "A2"]], "C"]);
    r = moveInTree(r, "A1", null, 2)!;
    expect(shape(r)).toEqual([["A", ["B", "A2"]], "C", "A1"]);
    expect(positionsOk(r)).toBe(true);
  });

  it("nimmt Unterpunkte mit", () => {
    expect(shape(moveInTree(sample(), "A", "C", 0)!)).toEqual(["B", ["C", [["A", ["A1", "A2"]]]]]);
  });

  it("begrenzt zu große und negative Positionen", () => {
    expect(shape(moveInTree(sample(), "A", null, 999)!)).toEqual(["B", "C", ["A", ["A1", "A2"]]]);
    expect(shape(moveInTree(sample(), "C", null, -5)!)).toEqual(["C", ["A", ["A1", "A2"]], "B"]);
  });

  it("lehnt Zyklen, unbekannte Punkte und unbekannte Eltern ab", () => {
    expect(moveInTree(sample(), "A", "A", 0)).toBeNull();
    expect(moveInTree(sample(), "A", "A1", 0)).toBeNull();
    expect(moveInTree(sample(), "X", null, 0)).toBeNull();
    expect(moveInTree(sample(), "B", "X", 0)).toBeNull();
  });

  it("verändert den ursprünglichen Baum nicht", () => {
    const t = sample();
    const before = JSON.stringify(t);
    moveInTree(t, "B", "A", 0);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe("Schaltflächen statt Ziehen", () => {
  it("nach oben/unten nur unter Geschwistern", () => {
    const t = sample();
    expect(moveUpTarget(t, "B")).toEqual({ parentItemId: null, position: 0 });
    expect(moveUpTarget(t, "A")).toBeNull();
    expect(moveDownTarget(t, "A")).toEqual({ parentItemId: null, position: 1 });
    expect(moveDownTarget(t, "C")).toBeNull();
    expect(moveDownTarget(t, "A1")).toEqual({ parentItemId: "A", position: 1 });
    expect(moveUpTarget(t, "A1")).toBeNull();
  });

  it("Einrücken macht den Punkt zum letzten Unterpunkt des vorherigen Geschwisterpunkts", () => {
    const t = sample();
    expect(indentTarget(t, "B")).toEqual({ parentItemId: "A", position: 2 });
    expect(indentTarget(t, "A")).toBeNull();
    expect(shape(moveInTree(t, "B", "A", 2)!)).toEqual([["A", ["A1", "A2", "B"]], "C"]);
  });

  it("Ausrücken setzt den Punkt direkt hinter seinen bisherigen Elternpunkt", () => {
    const t = sample();
    expect(outdentTarget(t, "A1")).toEqual({ parentItemId: null, position: 1 });
    expect(outdentTarget(t, "A")).toBeNull();
    expect(shape(moveInTree(t, "A1", null, 1)!)).toEqual([["A", ["A2"]], "A1", "B", "C"].slice(0, 4).map((x, i) => (i === 0 ? ["A", ["A2"]] : x)));
  });

  it("Aus- und Einrücken sind zueinander umkehrbar", () => {
    const t = moveInTree(sample(), "A2", null, 1)!; // A[A1], A2, B, C
    const back = indentTarget(t, "A2")!;
    expect(back).toEqual({ parentItemId: "A", position: 1 });
    expect(shape(moveInTree(t, "A2", back.parentItemId, back.position)!)).toEqual(shape(sample()));
  });

  it("erkennt Ziele, die dem aktuellen Ort entsprechen", () => {
    const t = sample();
    expect(isSamePlace(t, "B", { parentItemId: null, position: 1 })).toBe(true);
    expect(isSamePlace(t, "B", { parentItemId: null, position: 99 })).toBe(false); // an anderer Stelle? C ist letzter, B nicht
    expect(isSamePlace(t, "C", { parentItemId: null, position: 99 })).toBe(true); // zu große Position = Ende
    expect(isSamePlace(t, "B", { parentItemId: "A", position: 0 })).toBe(false);
  });
});

describe("Ziel beim Ziehen (getProjection)", () => {
  const W = 24;
  const proj = (activeId: string, overId: string, offsetX = 0, collapsed: string[] = [], tree = sample()) =>
    getProjection(flatten(tree, new Set(collapsed)), activeId, overId, offsetX, W, new Set(collapsed));

  it("setzt einen Punkt zwischen zwei Unterpunkte (Ebene vom Nachbarn)", () => {
    expect(proj("B", "A2")).toEqual({ depth: 1, parentId: "A", position: 1 });
  });

  it("rückt bei Zug nach rechts ein (letzter Unterpunkt bzw. tiefer)", () => {
    expect(proj("C", "B", 30)).toEqual({ depth: 1, parentId: "A", position: 2 });
    expect(proj("C", "B", 60)).toEqual({ depth: 2, parentId: "A2", position: 0 });
  });

  it("begrenzt die Ebene: nicht tiefer als vorheriger Punkt + 1, nicht flacher als der nächste", () => {
    expect(proj("C", "B", 500)?.depth).toBe(2);
    expect(proj("B", "A2", -500)?.depth).toBe(1); // der folgende Punkt A2 liegt auf Ebene 1
  });

  it("rückt bei Zug nach links aus", () => {
    expect(proj("A2", "A2", -30)).toEqual({ depth: 0, parentId: null, position: 1 });
  });

  it("zieht einen Elternpunkt samt Unterpunkten (Nachfahren zählen nicht als Ziel)", () => {
    expect(proj("A", "B")).toEqual({ depth: 0, parentId: null, position: 1 });
    expect(proj("A", "A1")).toBeNull(); // A1 gehört zu A selbst und ist beim Ziehen ausgeblendet
  });

  it("hängt unter einem eingeklappten Elternpunkt ans Ende", () => {
    expect(proj("C", "B", 30, ["A"])).toEqual({ depth: 1, parentId: "A", position: 2 });
  });

  it("liefert null bei unbekannten Punkten", () => {
    expect(proj("X", "A")).toBeNull();
    expect(proj("A", "X")).toBeNull();
  });

  it("an den Anfang ziehen ergibt Ebene 0, Position 0", () => {
    expect(proj("C", "A", 100)).toEqual({ depth: 0, parentId: null, position: 0 });
  });

  it("ergibt Ziele, die mit moveInTree zusammen den erwarteten Baum liefern", () => {
    const p = proj("C", "B", 30)!;
    expect(shape(moveInTree(sample(), "C", p.parentId, p.position)!)).toEqual([["A", ["A1", "A2", "C"]], "B"]);
  });
});

describe("Mehrere Abschnitte: moveBetweenSections", () => {
  const sections = () => [{ id: "S1", items: sample() }, { id: "S2", items: [n("X", [n("X1")], 0), n("Y", [], 1)] }];
  const shapes = (secs: { id: string; items: ItemNode[] }[]) => secs.map((x) => shape(x.items));

  it("verschiebt zwischen Abschnitten an die oberste Ebene (mit Unterpunkten) und nummeriert neu", () => {
    const res = moveBetweenSections(sections(), "A", { sectionId: "S2", parentItemId: null, position: 1 })!;
    expect(shapes(res)).toEqual([["B", "C"], [["X", ["X1"]], ["A", ["A1", "A2"]], "Y"]]);
    expect(positionsOk(res[0]!.items) && positionsOk(res[1]!.items)).toBe(true);
  });

  it("verschiebt unter einen Elternpunkt des anderen Abschnitts", () => {
    const res = moveBetweenSections(sections(), "B", { sectionId: "S2", parentItemId: "X", position: 0 })!;
    expect(shapes(res)).toEqual([[["A", ["A1", "A2"]], "C"], [["X", ["B", "X1"]], "Y"]]);
  });

  it("innerhalb eines Abschnitts wie moveInTree; unbekannte Ziele und Zyklen ergeben null", () => {
    expect(shapes(moveBetweenSections(sections(), "C", { sectionId: "S1", parentItemId: null, position: 0 })!)[0]).toEqual(["C", ["A", ["A1", "A2"]], "B"]);
    expect(moveBetweenSections(sections(), "A", { sectionId: "S1", parentItemId: "A1", position: 0 })).toBeNull();
    expect(moveBetweenSections(sections(), "A", { sectionId: "S9", parentItemId: null, position: 0 })).toBeNull();
    expect(moveBetweenSections(sections(), "A", { sectionId: "S2", parentItemId: "nix", position: 0 })).toBeNull();
    expect(moveBetweenSections(sections(), "nix", { sectionId: "S2", parentItemId: null, position: 0 })).toBeNull();
  });
});

describe("Mehrere Abschnitte: getBoardProjection", () => {
  // S1: A[A1], B | S2: X, Y[Y1] | S3 (leer)
  const rows: BoardRow[] = [
    { id: "A", sectionId: "S1", parentId: null, depth: 0, isEnd: false }, { id: "A1", sectionId: "S1", parentId: "A", depth: 1, isEnd: false },
    { id: "B", sectionId: "S1", parentId: null, depth: 0, isEnd: false }, { id: "end-S1", sectionId: "S1", parentId: null, depth: 0, isEnd: true },
    { id: "X", sectionId: "S2", parentId: null, depth: 0, isEnd: false }, { id: "Y", sectionId: "S2", parentId: null, depth: 0, isEnd: false },
    { id: "Y1", sectionId: "S2", parentId: "Y", depth: 1, isEnd: false }, { id: "end-S2", sectionId: "S2", parentId: null, depth: 0, isEnd: true },
    { id: "end-S3", sectionId: "S3", parentId: null, depth: 0, isEnd: true },
  ];
  const proj = (active: string, over: string, dx = 0, desc: string[] = []) => getBoardProjection(rows, active, over, dx, 28, new Set(desc));

  it("über sich selbst bleibt der Punkt an seinem Platz", () => {
    expect(proj("B", "B")).toEqual({ sectionId: "S1", depth: 0, parentId: null, position: 1 });
  });
  it("auf einen Punkt eines anderen Abschnitts: Zielabschnitt ist der der Zeile unter dem Zeiger; nach unten gezogen hinter, nach oben vor die Zeile", () => {
    expect(proj("B", "X")).toMatchObject({ sectionId: "S2", parentId: null, position: 1 }); // B steht vor X → nach unten → hinter X
    expect(proj("Y", "A")).toMatchObject({ sectionId: "S1", parentId: null, position: 0 }); // Y steht hinter A → nach oben → vor A
  });
  it("auf das Ende eines leeren Abschnitts", () => {
    expect(proj("B", "end-S3")).toEqual({ sectionId: "S3", depth: 0, parentId: null, position: 0 });
  });
  it("auf das Ende eines Abschnitts: hinten anhängen; nach rechts gezogen wird er Unterpunkt des letzten Punkts", () => {
    expect(proj("X", "end-S1")).toMatchObject({ sectionId: "S1", depth: 0, parentId: null, position: 2 });
    expect(proj("X", "end-S1", 30)).toMatchObject({ sectionId: "S1", depth: 1, parentId: "B", position: 0 });
  });
  it("in einem leeren Abschnitt kann man nicht einrücken", () => {
    expect(proj("B", "end-S3", 90)).toMatchObject({ sectionId: "S3", depth: 0, parentId: null });
  });
  it("Unterpunkte wandern mit und zählen nicht als Ziel", () => {
    expect(proj("A", "end-S2", 0, ["A1"])).toMatchObject({ sectionId: "S2", depth: 0, parentId: null, position: 2 });
  });
  it("ein Punkt unter einem Punkt eines anderen Abschnitts wird dort Unterpunkt", () => {
    expect(proj("B", "Y", 30)).toMatchObject({ sectionId: "S2", parentId: "Y", depth: 1 });
  });
  it("unbekannte Ziele ergeben null", () => {
    expect(proj("B", "nix")).toBeNull();
    expect(proj("end-S1", "B")).toBeNull();
  });
});

describe("withProgress", () => {
  const leaf = (id: string, isChecked: boolean, children: any[] = []) => ({ id, isChecked, childProgress: { done: 9, total: 9 }, children });

  it("zählt alle Ebenen je Unterpunkt-Gruppe, Abschnitt und gesamt neu", () => {
    const sections = [
      { id: "s1", progress: { done: 0, total: 0 }, items: [leaf("a", true, [leaf("b", false), leaf("c", true)]), leaf("d", false)] },
      { id: "s2", progress: { done: 5, total: 5 }, items: [] },
    ];
    const r = withProgress(sections);
    expect(r.sections[0]!.items[0]!.childProgress).toEqual({ done: 1, total: 2 });
    expect(r.sections[0]!.items[1]!.childProgress).toEqual({ done: 0, total: 0 });
    expect(r.sections.map((s) => s.progress)).toEqual([{ done: 2, total: 4 }, { done: 0, total: 0 }]);
    expect(r.progress).toEqual({ done: 2, total: 4 });
  });
});
