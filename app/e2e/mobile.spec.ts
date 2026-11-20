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
    await expect(page.getByRole("group", { name: `Aktionen für ${item}` })).toBeVisible();
  }

  for (const item of items) {
    const title = page.getByText(item, { exact: true });
    const actions = page.getByRole("group", { name: `Aktionen für ${item}` });
    expect(await overlaps(title, actions), item).toBe(false);
    for (const btn of await actions.getByRole("button").all()) expect(await overlaps(title, btn), item).toBe(false);
  }
  // Kein waagrechtes Scrollen der Seite
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
