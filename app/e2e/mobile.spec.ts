import { expect, test, type Locator } from "@playwright/test";

const PASSWORD = "Kaffeetasse-Wolke-42";

// Handy-Bildschirm: Aufgabentitel dürfen nicht unter den Schaltflächen der Zeile liegen.
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

const overlaps = async (a: Locator, b: Locator) => {
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  if (!x || !y) throw new Error("Element nicht sichtbar");
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
};

test("Handy: Aufgabentitel werden nicht von den Schaltflächen überlagert", async ({ page }) => {
  const items = ["Brot", "Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterung", "Rucksack packen und die Wanderkarte für morgen nicht vergessen"];

  await page.goto("/register");
  await page.getByLabel("Name", { exact: false }).first().fill("Anna Muster");
  await page.getByLabel("E-Mail").fill(`anna-${Date.now()}@example.org`);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  const repeat = page.getByLabel(/wiederholen|bestätigen/i);
  if (await repeat.count()) await repeat.first().fill(PASSWORD);
  await page.getByRole("button", { name: "Registrieren" }).click();
  await expect(page.getByRole("heading", { name: "Meine Checklisten" })).toBeVisible();

  await page.getByRole("button", { name: /Neue Checkliste/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel").fill("Handy");
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Handy", level: 1 })).toBeVisible();

  const add = page.getByLabel("Neuen Punkt hinzufügen", { exact: true });
  for (const item of items) {
    await add.fill(item);
    await add.press("Enter");
    await expect(page.getByText(item, { exact: true })).toBeVisible();
  }

  for (const item of items) {
    const title = page.getByText(item, { exact: true });
    // Am Handy wie bei Todoist: kein Griff und keine Schaltflächenleiste, nur „⋯“ mit einem Menü
    await expect(page.getByRole("button", { name: new RegExp(`${item} verschieben`) })).toBeHidden();
    const toggle = page.getByRole("button", { name: `Aktionen für ${item} anzeigen` });
    expect(await overlaps(title, toggle), item).toBe(false);
    await toggle.click();
    const menu = page.getByRole("menu", { name: `Aktionen für ${item}` });
    await expect(menu.getByRole("menuitem", { name: `${item} löschen` })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: `${item} eine Ebene nach rechts (einrücken)` })).toBeHidden(); // Ebene am Handy per Ziehen
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
  // Kein waagrechtes Scrollen der Seite
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("Handy: langer Druck auf eine Zeile zieht sie (ohne sie abzuhaken)", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Name", { exact: false }).first().fill("Anna Muster");
  await page.getByLabel("E-Mail").fill(`anna-${Date.now()}@example.org`);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  const repeat = page.getByLabel(/wiederholen|bestätigen/i);
  if (await repeat.count()) await repeat.first().fill(PASSWORD);
  await page.getByRole("button", { name: "Registrieren" }).click();
  await page.getByRole("button", { name: /Neue Checkliste/ }).first().click();
  await page.getByRole("dialog").getByLabel("Titel").fill("Ziehen");
  await page.getByRole("dialog").getByRole("button", { name: "Anlegen" }).click();
  const add = page.getByLabel("Neuen Punkt hinzufügen", { exact: true });
  for (const item of ["Eins", "Zwei", "Drei"]) { await add.fill(item); await add.press("Enter"); await expect(page.getByText(item, { exact: true })).toBeVisible(); }

  // „Drei“ lange drücken und über „Eins“ ziehen (Touch-Ereignisse über das Chrome-DevTools-Protokoll)
  const from = (await page.getByText("Drei", { exact: true }).boundingBox())!;
  const to = (await page.getByText("Eins", { exact: true }).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const [x, y] = [from.x + 10, from.y + from.height / 2];
  await touch("touchStart", x, y);
  await page.waitForTimeout(450);
  for (let i = 1; i <= 10; i++) { await touch("touchMove", x, y + ((to.y - 8 - y) * i) / 10); await page.waitForTimeout(30); }
  await touch("touchEnd", x, to.y);

  await expect.poll(() => page.getByRole("checkbox").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.closest("label")?.textContent))).toEqual(["Drei", "Eins", "Zwei"]);
  await expect(page.getByRole("checkbox", { name: "Drei" })).not.toBeChecked();
});
