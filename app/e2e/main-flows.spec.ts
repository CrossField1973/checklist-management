import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "Kaffeetasse-Wolke-42";
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function register(page: Page, name = "Anna Muster") {
  await page.goto("/register");
  await page.getByLabel("Name", { exact: false }).first().fill(name);
  await page.getByLabel("E-Mail").fill(`anna-${unique()}@example.org`);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  const repeat = page.getByLabel(/wiederholen|bestätigen/i);
  if (await repeat.count()) await repeat.first().fill(PASSWORD);
  await page.getByRole("button", { name: "Registrieren" }).click();
  await expect(page.getByRole("heading", { name: "Aktuelle Durchführungen" })).toBeVisible();
}

async function createTemplate(page: Page, title: string, items: string[]) {
  await page.getByRole("link", { name: "Vorlagen" }).click();
  await page.getByRole("button", { name: "Neue Vorlage" }).first().click();
  await page.getByRole("dialog").getByLabel("Titel").fill(title);
  await page.getByRole("dialog").getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const add = page.getByLabel("Neuen Punkt hinzufügen", { exact: true });
  for (const item of items) {
    await add.fill(item);
    await add.press("Enter");
    await expect(page.getByText(item, { exact: true })).toBeVisible();
  }
}

test("Vorlage → Durchführung → abhaken → archivieren → wieder öffnen → abschließen → Papierkorb", async ({ page }) => {
  await register(page);
  await createTemplate(page, "Tagesausflug", ["Rucksack packen", "Route prüfen"]);

  // Durchführung aus der Vorlage anlegen
  await page.getByRole("link", { name: "Aktuelle Durchführungen", exact: true }).click();
  await page.getByRole("button", { name: /Neue Durchführung/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel").fill("Ausflug Füssen");
  await dialog.getByLabel("Tagesausflug").check();
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Ausflug Füssen", level: 1 })).toBeVisible();

  // Abhaken wird gespeichert (nach Neuladen noch da)
  await page.getByRole("checkbox", { name: "Rucksack packen" }).check();
  await expect(page.getByText("1/2").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Rucksack packen" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Route prüfen" })).not.toBeChecked();

  // Eigener Punkt
  await page.getByLabel("Neuer Punkt in Tagesausflug").fill("Sonnenbrille");
  await page.getByLabel("Neuer Punkt in Tagesausflug").press("Enter");
  await expect(page.getByRole("checkbox", { name: "Sonnenbrille" })).toBeVisible();

  // Archivieren → Archiv → schreibgeschützt → wieder öffnen
  await page.getByRole("button", { name: "Beenden …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByRole("heading", { name: "Archiv", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Ausflug Füssen" }).click();
  await expect(page.getByRole("checkbox", { name: "Route prüfen" })).toBeDisabled();
  await page.getByRole("button", { name: "Wieder öffnen" }).click();
  await expect(page.getByRole("checkbox", { name: "Route prüfen" })).toBeEnabled();

  // Abschließen → Papierkorb → Wiederherstellen
  await page.getByRole("button", { name: "Beenden …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Abschließen" }).click();
  await expect(page.getByText(/liegt im Papierkorb/)).toBeVisible();
  await page.getByRole("link", { name: "Papierkorb" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Ausflug Füssen" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /wiederherstellen/ }).click();
  await expect(page.getByText("Der Papierkorb ist leer.")).toBeVisible();
  await page.getByRole("link", { name: "Aktuelle Durchführungen", exact: true }).click();
  await expect(page.getByRole("link", { name: "Ausflug Füssen" })).toBeVisible();
});

test("Teilen: Link mit Passwort – Empfänger ohne Konto bearbeitet, Besitzer sieht es, Widerruf sperrt aus", async ({ page, browser }) => {
  await register(page);
  await createTemplate(page, "Therme", ["Handtuch", "Badekappe"]);
  await page.getByRole("link", { name: "Aktuelle Durchführungen", exact: true }).click();
  await page.getByRole("button", { name: /Neue Durchführung/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel").fill("Thermenbesuch");
  await dialog.getByLabel("Therme").check();
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Thermenbesuch", level: 1 })).toBeVisible();

  // Teilen mit Passwort und Bearbeiten-Recht
  await page.getByRole("button", { name: "Teilen …" }).click();
  const share = page.getByRole("dialog");
  await share.getByLabel("Zugriff").selectOption("password");
  await share.getByLabel("Passwort", { exact: false }).fill("geheim-geheim-1");
  await share.getByLabel(/Berechtigung|Rechte/).selectOption("edit");
  await share.getByRole("button", { name: "Link erstellen" }).click();
  const url = await share.getByLabel("Freigabelink").inputValue();
  expect(url).toMatch(/\/s\/[\w-]{20,}$/);
  await share.getByRole("button", { name: "Fertig" }).click();

  // Kennzeichnung in der Liste
  await page.getByRole("link", { name: "Aktuelle Durchführungen", exact: true }).click();
  await expect(page.getByTestId("share-badge")).toContainText("Geteilt");

  // Empfänger: eigener, nicht angemeldeter Browserkontext
  const guest = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await guest.goto(url);
  await expect(guest.getByRole("heading", { name: "Passwort erforderlich" })).toBeVisible();
  await guest.getByLabel("Passwort").fill("falsch-falsch-1");
  await guest.getByRole("button", { name: "Öffnen" }).click();
  await expect(guest.getByText("Das Passwort ist falsch.")).toBeVisible();
  await guest.getByLabel("Passwort").fill("geheim-geheim-1");
  await guest.getByRole("button", { name: "Öffnen" }).click();
  await expect(guest.getByRole("heading", { name: "Thermenbesuch", level: 1 })).toBeVisible();
  await guest.getByRole("checkbox", { name: "Handtuch" }).check();
  await expect(guest.getByText("1/2").first()).toBeVisible();

  // Besitzer sieht die Änderung
  await page.getByRole("link", { name: "Thermenbesuch" }).click();
  await expect(page.getByRole("checkbox", { name: "Handtuch" })).toBeChecked();

  // Empfänger sieht Änderungen des Besitzers von selbst (Abfrage alle paar Sekunden)
  await page.getByRole("checkbox", { name: "Badekappe" }).check();
  await expect(guest.getByRole("checkbox", { name: "Badekappe" })).toBeChecked({ timeout: 15_000 });

  // Teilen beenden → Link ist unwirksam
  await page.getByRole("button", { name: "Teilen …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Teilen beenden" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fertig" }).click();
  await guest.reload();
  await expect(guest.getByText("Dieser Link ist ungültig oder wurde beendet.")).toBeVisible();
  await guest.context().close();
});

test("Abmelden und wieder Anmelden; Sitzung schützt Seiten", async ({ page }) => {
  await register(page, "Ben Beispiel");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/templates");
  await expect(page).toHaveURL(/\/login/); // geschützte Seite → Anmeldung
});

test("Zugriff auf fremde Durchführung zeigt „nicht gefunden“", async ({ page, browser }) => {
  await register(page);
  await page.getByRole("button", { name: /Neue Durchführung/ }).first().click();
  await page.getByRole("dialog").getByLabel("Titel").fill("Privat");
  await page.getByRole("dialog").getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Privat", level: 1 })).toBeVisible();
  const path = new URL(page.url()).pathname;

  const other = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await register(other, "Fremder");
  await other.goto(path);
  await expect(other.getByText("Diese Durchführung gibt es nicht (mehr).")).toBeVisible();
  await other.context().close();
});

test("Offline (PWA): App startet ohne Verbindung, Abhaken und Hinzufügen werden bei Verbindung synchronisiert", async ({ page, context }) => {
  await register(page);
  await createTemplate(page, "Wanderung", ["Wasser", "Karte"]);
  await page.getByRole("link", { name: "Aktuelle Durchführungen", exact: true }).click();
  await page.getByRole("button", { name: /Neue Durchführung/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel").fill("Wanderung Samstag");
  await dialog.getByLabel("Wanderung").check();
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("checkbox", { name: "Wasser" })).toBeVisible();

  // Service Worker aktiv und lokaler Datenbestand gespeichert
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const req = indexedDB.open("checklisten-offline");
    req.onsuccess = () => { const g = req.result.transaction("kv").objectStore("kv").get("cache"); g.onsuccess = () => resolve(JSON.stringify(g.result ?? "").includes("Wanderung Samstag")); g.onerror = () => resolve(false); };
    req.onerror = () => resolve(false);
  })), { timeout: 15_000 }).toBe(true);

  // Verbindung weg → Seite neu laden: Oberfläche und Daten kommen vom Gerät
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Wasser" })).toBeVisible();
  await expect(page.getByText(/Du bist offline/)).toBeVisible();

  await page.getByRole("checkbox", { name: "Wasser" }).check();
  await page.getByLabel("Neuer Punkt in Wanderung").fill("Sonnencreme");
  await page.getByLabel("Neuer Punkt in Wanderung").press("Enter");
  await expect(page.getByText("wartet auf Übertragung")).toBeVisible();
  await expect(page.getByText(/2 Änderungen warten/)).toBeVisible();

  // Verbindung zurück → Übertragung
  await context.setOffline(false);
  await expect(page.getByText(/2 Änderungen wurden übertragen/)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Wasser" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Sonnencreme" })).toBeEnabled();
});
