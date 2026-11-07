import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiTokenInfo, ShareInfo } from "../api/types";
import { USER, apiError, mockApi, renderApp } from "./harness";

const NO_2FA = { enabled: false, enabledAt: null, pendingSetup: false, recoveryCodesRemaining: 0 };

/** Fake-API für ein Profil mit allen Bereichen (leere Listen); einzelne Tests überschreiben Routen. */
function profileApi(opts: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi(opts);
  api.on("GET /me/2fa", () => ({ body: NO_2FA }));
  api.on("GET /me/tokens", () => ({ body: { tokens: [] } }));
  api.on("GET /me/shares", () => ({ body: { shares: [] } }));
  api.on("GET /me/sso", () => ({ body: { enabled: false, name: null, linked: false } }));
  return api;
}
const section = (name: string) => screen.getByRole("region", { name });
const openProfile = async (sectionId = "account") => {
  const r = renderApp(`/profile?section=${sectionId}`);
  await screen.findByRole("heading", { name: "Profil", level: 1 });
  return r;
};

/** Inhalt der Zwischenablage (user-event stellt sie bereit) */
const clipboardText = () => navigator.clipboard.readText();

describe("Profil: Konto (F-05)", () => {
  it("zeigt links die Bereiche und rechts nur den gewählten Inhalt", async () => {
    profileApi();
    const { ui } = await openProfile();
    const nav = within(screen.getByRole("navigation", { name: "Profilbereiche" }));
    expect(nav.queryByRole("button", { name: "Single Sign-on" })).not.toBeInTheDocument(); // SSO nicht konfiguriert
    expect(screen.getByRole("region", { name: "Konto" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Zwei-Faktor-Anmeldung" })).not.toBeInTheDocument();
    // „Konto“ enthält auch „Konto löschen“; „Sicherheit“ enthält Passwort ändern und Zwei-Faktor-Anmeldung
    for (const name of ["Konto", "Konto löschen"]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    for (const name of ["Passwort ändern", "Zwei-Faktor-Anmeldung", "Konto löschen"]) expect(nav.queryByRole("button", { name })).not.toBeInTheDocument();
    for (const name of ["Darstellung", "Tags", "Sicherheit", "API-Token", "Geteilte Checklisten", "Tastenkürzel", "Daten"]) {
      await ui.click(nav.getByRole("button", { name }));
      expect(await screen.findByRole("region", { name: name === "Sicherheit" ? "Passwort ändern" : name })).toBeInTheDocument();
      expect(nav.getByRole("button", { name })).toHaveAttribute("aria-current", "page");
      if (name === "Sicherheit") expect(await screen.findByRole("region", { name: "Zwei-Faktor-Anmeldung" })).toBeInTheDocument();
    }
    expect(screen.queryByRole("region", { name: "Konto" })).not.toBeInTheDocument();
  });

  it("öffnet das Profil über den Benutzer unten links in der Navigation", async () => {
    profileApi();
    const r = renderApp("/");
    await r.ui.click(await screen.findByRole("link", { name: "Profil öffnen" }));
    expect(await screen.findByRole("heading", { name: "Profil", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Konto" })).toBeInTheDocument();
  });

  it("speichert Name, Sprache und Papierkorb-Frist und wendet die Sprache sofort an", async () => {
    const api = profileApi();
    api.on("PUT /me", ({ body }) => ({ body: { user: { ...USER, ...body } } }));
    const { ui } = await openProfile();
    const account = within(section("Konto"));
    expect(account.queryByLabelText("Design")).not.toBeInTheDocument(); // liegt unter „Darstellung“
    await ui.clear(account.getByLabelText("Anzeigename"));
    await ui.type(account.getByLabelText("Anzeigename"), "Anna M.");
    await ui.selectOptions(account.getByLabelText("Sprache"), "en");
    await ui.selectOptions(account.getByLabelText("Papierkorb automatisch leeren nach"), "never");
    await ui.click(account.getByRole("button", { name: "Speichern" }));

    expect(api.callsTo("PUT /me")[0]!.body).toEqual({ displayName: "Anna M.", language: "en", trashRetentionDays: null });
    // die Oberfläche wechselt sofort in die gewählte Sprache
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
  });

  it("Darstellung: Design, Akzentfarbe, Schriftgröße und Erledigte ausblenden wirken sofort und werden im Konto gespeichert", async () => {
    const api = profileApi();
    api.on("PUT /me", ({ body }) => ({ body: { user: { ...USER, ...body } } }));
    const { ui } = await openProfile("display");
    const box = within(section("Darstellung"));
    await ui.selectOptions(box.getByLabelText("Design"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await ui.click(box.getByRole("button", { name: "Petrol" }));
    expect(document.documentElement.dataset.accent).toBe("teal");
    expect(box.getByRole("button", { name: "Petrol" })).toHaveAttribute("aria-pressed", "true");
    await ui.selectOptions(box.getByLabelText("Schriftgröße"), "large");
    expect(document.documentElement.dataset.fontsize).toBe("large");
    await ui.click(box.getByLabelText("Erledigte ausblenden"));
    await waitFor(() => expect(api.callsTo("PUT /me")).toHaveLength(4));
    expect(api.callsTo("PUT /me").map((c) => c.body)).toEqual([{ theme: "dark" }, { accent: "teal" }, { fontSize: "large" }, { hideDone: true }]);
    await ui.click(box.getByRole("button", { name: "Blau" })); // Standard: Attribut entfällt
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it("Darstellung: bei einem Fehler wird der alte Wert wiederhergestellt", async () => {
    const api = profileApi();
    api.on("PUT /me", () => apiError(500, "internal_error"));
    const { ui } = await openProfile("display");
    await ui.click(within(section("Darstellung")).getByRole("button", { name: "Violett" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it("verlangt für eine neue E-Mail-Adresse das aktuelle Passwort und sendet es mit", async () => {
    const api = profileApi();
    api.on("PUT /me", ({ body }) => ({ body: { user: { ...USER, email: body.email } } }));
    const { ui } = await openProfile();
    const account = within(section("Konto"));
    expect(account.queryByLabelText("Aktuelles Passwort")).not.toBeInTheDocument();
    await ui.clear(account.getByLabelText("E-Mail"));
    await ui.type(account.getByLabelText("E-Mail"), "neu@example.org");
    await ui.type(await account.findByLabelText("Aktuelles Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(account.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /me")).toHaveLength(1));
    expect(api.callsTo("PUT /me")[0]!.body).toMatchObject({ email: "neu@example.org", currentPassword: "Kaffeetasse-Wolke-42" });
    expect(await account.findByRole("status")).toHaveTextContent("Gespeichert.");
  });

  it("meldet Serverfehler beim Speichern (z. B. falsches Passwort, vergebene E-Mail)", async () => {
    const api = profileApi();
    api.on("PUT /me", () => apiError(409, "email_taken"));
    const { ui } = await openProfile();
    const account = within(section("Konto"));
    await ui.clear(account.getByLabelText("E-Mail"));
    await ui.type(account.getByLabelText("E-Mail"), "belegt@example.org");
    await ui.type(await account.findByLabelText("Aktuelles Passwort"), "x");
    await ui.click(account.getByRole("button", { name: "Speichern" }));
    expect(await account.findByRole("alert")).toHaveTextContent("bereits vergeben");
  });
});

describe("Profil: Passwort ändern (F-06)", () => {
  it("prüft die Wiederholung lokal und ändert das Passwort", async () => {
    const api = profileApi();
    api.on("POST /me/password", () => ({ status: 204 }));
    const { ui } = await openProfile("security");
    const pw = within(section("Passwort ändern"));
    await ui.type(pw.getByLabelText("Aktuelles Passwort"), "Kaffeetasse-Wolke-42");
    await ui.type(pw.getByLabelText("Neues Passwort"), "Ganz-neues-Passwort-77");
    await ui.type(pw.getByLabelText("Passwort wiederholen"), "tippfehler");
    await ui.click(pw.getByRole("button", { name: "Passwort ändern" }));
    expect(await pw.findByRole("alert")).toHaveTextContent("stimmen nicht überein");
    expect(api.callsTo("POST /me/password")).toHaveLength(0);

    await ui.clear(pw.getByLabelText("Passwort wiederholen"));
    await ui.type(pw.getByLabelText("Passwort wiederholen"), "Ganz-neues-Passwort-77");
    await ui.click(pw.getByRole("button", { name: "Passwort ändern" }));
    expect(await pw.findByRole("status")).toHaveTextContent("Das Passwort wurde geändert.");
    expect(api.callsTo("POST /me/password")[0]!.body).toEqual({ currentPassword: "Kaffeetasse-Wolke-42", newPassword: "Ganz-neues-Passwort-77" });
    expect(pw.getByLabelText("Aktuelles Passwort")).toHaveValue(""); // Felder werden geleert
  });

  it("zeigt Richtlinien-Verstöße und ein falsches aktuelles Passwort verständlich an", async () => {
    const api = profileApi();
    api.on("POST /me/password", ({ body }) => body.currentPassword === "falsch"
      ? apiError(403, "invalid_current_password")
      : apiError(422, "password_policy", { problems: ["too_common", "contains_identity"] }));
    const { ui } = await openProfile("security");
    const pw = within(section("Passwort ändern"));
    const fill = async (current: string) => {
      await ui.clear(pw.getByLabelText("Aktuelles Passwort"));
      await ui.type(pw.getByLabelText("Aktuelles Passwort"), current);
      await ui.clear(pw.getByLabelText("Neues Passwort"));
      await ui.type(pw.getByLabelText("Neues Passwort"), "anna123456789");
      await ui.clear(pw.getByLabelText("Passwort wiederholen"));
      await ui.type(pw.getByLabelText("Passwort wiederholen"), "anna123456789");
      await ui.click(pw.getByRole("button", { name: "Passwort ändern" }));
    };
    await fill("falsch");
    expect(await pw.findByRole("alert")).toHaveTextContent("Das aktuelle Passwort ist falsch.");
    await fill("richtig");
    await waitFor(() => expect(pw.getByRole("alert")).toHaveTextContent("Es ist zu einfach oder zu häufig. Es darf deine E-Mail oder deinen Namen nicht enthalten."));
  });

  it("erklärt Konten ohne Passwort (SSO), statt ein unbrauchbares Formular zu zeigen", async () => {
    profileApi({ user: { ...USER, hasPassword: false } });
    const { ui } = await openProfile("security");
    const pw = within(section("Passwort ändern"));
    expect(pw.getByRole("status")).toHaveTextContent("kein Passwort");
    expect(pw.queryByLabelText("Neues Passwort")).not.toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "Konto" }));
    const del = within(await screen.findByRole("region", { name: "Konto löschen" }));
    expect(del.queryByRole("button", { name: /Konto löschen/ })).not.toBeInTheDocument();
  });
});

describe("Profil: Zwei-Faktor-Anmeldung (F-08)", () => {
  it("führt durch Einrichtung: Passwort → QR-Code und Schlüssel → Code → Wiederherstellungscodes", async () => {
    const api = profileApi();
    api.on("POST /me/2fa/setup", () => ({ body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Checklisten:anna%40example.org?secret=JBSWY3DPEHPK3PXP" } }));
    api.on("POST /me/2fa/enable", () => ({ body: { enabled: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"], user: { ...USER, twoFactorEnabled: true } } }));
    const { ui } = await openProfile("security");
    const tf = section("Zwei-Faktor-Anmeldung");
    await ui.click(await within(tf).findByRole("button", { name: "Einrichten" }));

    const dialog = await screen.findByRole("dialog", { name: "Zwei-Faktor-Anmeldung einrichten" });
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "Kaffeetasse-Wolke-42");
    await ui.click(within(dialog).getByRole("button", { name: "Weiter" }));
    expect(api.callsTo("POST /me/2fa/setup")[0]!.body).toEqual({ password: "Kaffeetasse-Wolke-42" });

    expect(await within(dialog).findByTestId("totp-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(dialog.querySelector("svg")).not.toBeNull(); // QR-Code
    const activate = within(dialog).getByRole("button", { name: "Aktivieren" });
    expect(activate).toBeDisabled(); // erst mit 6 Ziffern
    await ui.type(within(dialog).getByLabelText("6-stelliger Code"), "12a3456");
    expect(within(dialog).getByLabelText("6-stelliger Code")).toHaveValue("123456"); // Nicht-Ziffern werden entfernt
    await ui.click(activate);
    expect(api.callsTo("POST /me/2fa/enable")[0]!.body).toEqual({ code: "123456" });

    // Wiederherstellungscodes: Schließen erst nach Bestätigung
    expect(await within(dialog).findByRole("list", { name: "Wiederherstellungscodes" })).toHaveTextContent("AAAAA-BBBBB");
    const done = within(dialog).getByRole("button", { name: "Fertig" });
    expect(done).toBeDisabled();
    // Solange die Codes angezeigt werden, lässt sich der Dialog nicht per Esc/Abbrechen schließen (sonst gingen sie verloren)
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Wiederherstellungscodes" })).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Kopieren" }));
    expect(await clipboardText()).toBe("AAAAA-BBBBB\nCCCCC-DDDDD");
    await ui.click(within(dialog).getByRole("checkbox"));
    expect(done).toBeEnabled();
    api.on("GET /me/2fa", () => ({ body: { enabled: true, enabledAt: 1, pendingSetup: false, recoveryCodesRemaining: 2 } }));
    await ui.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await within(tf).findByText("Aktiv. Dir bleiben 2 Wiederherstellungscodes.")).toBeInTheDocument();
  });

  it("meldet einen falschen Code bei der Aktivierung, ohne den Dialog zu verlassen", async () => {
    const api = profileApi();
    api.on("POST /me/2fa/setup", () => ({ body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } }));
    api.on("POST /me/2fa/enable", () => apiError(422, "invalid_code"));
    const { ui } = await openProfile("security");
    await ui.click(await within(section("Zwei-Faktor-Anmeldung")).findByRole("button", { name: "Einrichten" }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "x");
    await ui.click(within(dialog).getByRole("button", { name: "Weiter" }));
    await ui.type(await within(dialog).findByLabelText("6-stelliger Code"), "000000");
    await ui.click(within(dialog).getByRole("button", { name: "Aktivieren" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Der Code ist falsch");
    expect(within(dialog).getByTestId("totp-secret")).toBeInTheDocument();
  });

  it("deaktiviert nur mit Passwort und Code", async () => {
    const api = profileApi({ user: { ...USER, twoFactorEnabled: true } });
    api.on("GET /me/2fa", () => ({ body: { enabled: true, enabledAt: 1, pendingSetup: false, recoveryCodesRemaining: 10 } }));
    api.on("POST /me/2fa/disable", () => ({ status: 204 }));
    const { ui } = await openProfile("security");
    const tf = section("Zwei-Faktor-Anmeldung");
    expect(await within(tf).findByText(/Dir bleiben 10 Wiederherstellungscodes/)).toBeInTheDocument();
    await ui.click(within(tf).getByRole("button", { name: "Deaktivieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Zwei-Faktor-Anmeldung deaktivieren" });
    const submit = within(dialog).getByRole("button", { name: "Deaktivieren" });
    expect(submit).toBeDisabled();
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "Kaffeetasse-Wolke-42");
    await ui.type(within(dialog).getByLabelText(/Code aus der Authenticator-App/), "123456");
    api.on("GET /me/2fa", () => ({ body: NO_2FA }));
    await ui.click(submit);
    await waitFor(() => expect(api.callsTo("POST /me/2fa/disable")).toHaveLength(1));
    expect(api.callsTo("POST /me/2fa/disable")[0]!.body).toEqual({ password: "Kaffeetasse-Wolke-42", code: "123456" });
    expect(await within(tf).findByRole("button", { name: "Einrichten" })).toBeInTheDocument();
  });

  it("erneuert Wiederherstellungscodes und zeigt die neuen einmalig an", async () => {
    const api = profileApi({ user: { ...USER, twoFactorEnabled: true } });
    api.on("GET /me/2fa", () => ({ body: { enabled: true, enabledAt: 1, pendingSetup: false, recoveryCodesRemaining: 3 } }));
    api.on("POST /me/2fa/recovery-codes", () => ({ body: { recoveryCodes: ["NEUE1-NEUE2"] } }));
    const { ui } = await openProfile("security");
    await ui.click(await within(section("Zwei-Faktor-Anmeldung")).findByRole("button", { name: "Neue Wiederherstellungscodes" }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "pw");
    await ui.type(within(dialog).getByLabelText(/Code aus der Authenticator-App/), "654321");
    await ui.click(within(dialog).getByRole("button", { name: "Neue Wiederherstellungscodes" }));
    expect(await within(dialog).findByRole("list", { name: "Wiederherstellungscodes" })).toHaveTextContent("NEUE1-NEUE2");
  });
});

describe("Profil: Single Sign-on (F-09)", () => {
  const sso = { oidcEnabled: true, oidcName: "Authentik", oidcLoginUrl: "/api/v1/auth/oidc/login" };

  it("bietet das Verknüpfen als Seitenwechsel an, wenn noch nichts verknüpft ist", async () => {
    const api = profileApi({ config: sso });
    api.on("GET /me/sso", () => ({ body: { enabled: true, name: "Authentik", linked: false } }));
    await openProfile("sso");
    const link = await within(await screen.findByRole("region", { name: "Single Sign-on" })).findByRole("link", { name: "Mit Authentik verknüpfen" });
    expect(link).toHaveAttribute("href", "/api/v1/auth/oidc/login?link=1");
  });

  it("löst die Verknüpfung nur mit Passwort; Konten ohne Passwort erhalten einen Hinweis", async () => {
    const api = profileApi({ config: sso });
    api.on("GET /me/sso", () => ({ body: { enabled: true, name: "Authentik", linked: true } }));
    api.on("POST /me/sso/unlink", () => ({ status: 204 }));
    const { ui } = await openProfile("sso");
    const box = within(await screen.findByRole("region", { name: "Single Sign-on" }));
    expect(await box.findByRole("status")).toHaveTextContent("mit Authentik verknüpft");
    await ui.click(box.getByRole("button", { name: "Verknüpfung lösen" }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "Kaffeetasse-Wolke-42");
    api.on("GET /me/sso", () => ({ body: { enabled: true, name: "Authentik", linked: false } }));
    await ui.click(within(dialog).getByRole("button", { name: "Verknüpfung lösen" }));
    await waitFor(() => expect(api.callsTo("POST /me/sso/unlink")[0]?.body).toEqual({ password: "Kaffeetasse-Wolke-42" }));
  });

  it("zeigt nach der Rückkehr vom Anbieter eine Bestätigung", async () => {
    const api = profileApi({ config: sso });
    api.on("GET /me/sso", () => ({ body: { enabled: true, name: "Authentik", linked: true } }));
    renderApp("/?sso=linked"); // Rücksprung-Adresse des Servers
    expect(await screen.findByText("Die Verknüpfung wurde eingerichtet.")).toBeInTheDocument();
  });
});

describe("Profil: API-Token (F-61)", () => {
  const token = (over: Partial<ApiTokenInfo> = {}): ApiTokenInfo => ({ id: "t1", name: "Skript", prefix: "ck_Ab3x", permission: "read", expiresAt: null, expired: false, lastUsedAt: null, createdAt: 1, ...over });

  it("listet Token mit Rechten, Ablauf und letzter Nutzung – nie den Token selbst", async () => {
    const api = profileApi();
    api.on("GET /me/tokens", () => ({ body: { tokens: [token(), token({ id: "t2", name: "Alt", permission: "write", expired: true, expiresAt: 5, lastUsedAt: 1_700_000_000_000 })] } }));
    await openProfile("tokens");
    const box = within(section("API-Token"));
    const items = await box.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Skript");
    expect(items[0]).toHaveTextContent("Nur lesen");
    expect(items[0]).toHaveTextContent("ck_Ab3x…");
    expect(items[0]).toHaveTextContent("noch nie");
    expect(items[1]).toHaveTextContent("Lesen und schreiben");
    expect(items[1]).toHaveTextContent("abgelaufen");
  });

  it("legt einen Token an, zeigt ihn genau einmal mit Warnung und lässt ihn kopieren", async () => {
    const api = profileApi();
    api.on("POST /me/tokens", () => ({ status: 201, body: { token: "ck_GEHEIMER_KLARTEXT_TOKEN", apiToken: token() } }));
    const { ui } = await openProfile("tokens");
    await ui.click(within(section("API-Token")).getByRole("button", { name: "Token erstellen" }));
    const dialog = await screen.findByRole("dialog", { name: "Neuen API-Token erstellen" });
    const submit = within(dialog).getByRole("button", { name: "Erstellen" });
    expect(submit).toBeDisabled(); // ohne Namen nicht möglich
    await ui.type(within(dialog).getByLabelText(/^Name/), "Home Assistant");
    await ui.selectOptions(within(dialog).getByLabelText("Rechte"), "write");
    expect(within(dialog).getByText(/nicht löschen/)).toBeInTheDocument(); // Hinweis zum Schreibrecht
    await ui.click(submit);
    expect(api.callsTo("POST /me/tokens")[0]!.body).toEqual({ name: "Home Assistant", permission: "write" });

    expect(await within(dialog).findByTestId("new-token")).toHaveTextContent("ck_GEHEIMER_KLARTEXT_TOKEN");
    expect(within(dialog).getByRole("status")).toHaveTextContent("nur einmal angezeigt");
    await ui.click(within(dialog).getByRole("button", { name: "Kopieren" }));
    expect(await clipboardText()).toBe("ck_GEHEIMER_KLARTEXT_TOKEN");
    await ui.click(within(dialog).getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent("ck_GEHEIMER_KLARTEXT_TOKEN"); // danach nirgends mehr sichtbar
    // und nirgends im Browser gespeichert (Local-/Session-Storage)
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    expect(stored).not.toContain("ck_GEHEIMER_KLARTEXT_TOKEN");
  });

  it("sendet ein Ablaufdatum als Ende des gewählten Tages", async () => {
    const api = profileApi();
    api.on("POST /me/tokens", () => ({ status: 201, body: { token: "ck_x", apiToken: token() } }));
    const { ui } = await openProfile("tokens");
    await ui.click(within(section("API-Token")).getByRole("button", { name: "Token erstellen" }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText(/^Name/), "Kurz");
    const year = new Date().getFullYear() + 1;
    await ui.type(within(dialog).getByLabelText(/Gültig bis/), `${year}-06-30`);
    await ui.click(within(dialog).getByRole("button", { name: "Erstellen" }));
    await waitFor(() => expect(api.callsTo("POST /me/tokens")).toHaveLength(1));
    const sent = api.callsTo("POST /me/tokens")[0]!.body.expiresAt as string;
    expect(new Date(sent).getTime()).toBe(new Date(`${year}-06-30T23:59:59`).getTime());
  });

  it("widerruft einen Token nach Rückfrage", async () => {
    const api = profileApi();
    api.on("GET /me/tokens", () => ({ body: { tokens: [token()] } }));
    api.on("DELETE /me/tokens/t1", () => ({ status: 204 }));
    const { ui } = await openProfile("tokens");
    await ui.click(await within(section("API-Token")).findByRole("button", { name: "Token Skript widerrufen" }));
    const dialog = await screen.findByRole("dialog", { name: "Token widerrufen?" });
    expect(dialog).toHaveTextContent("Skript");
    expect(api.callsTo("DELETE /me/tokens/t1")).toHaveLength(0);
    api.on("GET /me/tokens", () => ({ body: { tokens: [] } }));
    await ui.click(within(dialog).getByRole("button", { name: "Widerrufen" }));
    await waitFor(() => expect(api.callsTo("DELETE /me/tokens/t1")).toHaveLength(1));
    expect(await within(section("API-Token")).findByText("Du hast noch keine API-Token.")).toBeInTheDocument();
  });

  it("nennt die MCP-Adresse und bietet die Konfiguration zum Kopieren an", async () => {
    profileApi();
    const { ui } = await openProfile("tokens");
    const box = within(section("API-Token"));
    await ui.click(box.getByText("KI-Assistenten anbinden (MCP)"));
    expect(box.getByTestId("mcp-url")).toHaveTextContent("http://localhost:3000/mcp");
    await ui.click(box.getByRole("button", { name: "Konfiguration kopieren" }));
    expect(JSON.parse(await clipboardText())).toEqual({ mcpServers: { checklisten: { type: "http", url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer ck_IHR_TOKEN" } } } });
  });
});

describe("Profil: Geteilte Checklisten (F-45)", () => {
  const share = (over: Partial<ShareInfo> = {}): ShareInfo => ({
    id: "s1", runId: "r1", runTitle: "Ausflug Füssen", runStatus: "active", runDeleted: false, access: "anyone", permission: "view",
    url: "http://localhost:3000/s/TOKEN123", createdAt: 1, ...over,
  });

  it("listet Freigaben mit Zugriffsart und Berechtigung und kennzeichnet den Papierkorb", async () => {
    const api = profileApi();
    api.on("GET /me/shares", () => ({ body: { shares: [share(), share({ id: "s2", runId: "r2", runTitle: "Alt", access: "password", permission: "edit", runDeleted: true })] } }));
    await openProfile("shares");
    const items = await within(section("Geteilte Checklisten")).findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Ausflug Füssen");
    expect(items[0]).toHaveTextContent("Jeder mit dem Link · Nur ansehen");
    expect(items[1]).toHaveTextContent("Link + Passwort · Ansehen und bearbeiten");
    expect(items[1]).toHaveTextContent("im Papierkorb");
    expect(within(items[1]!).getByRole("button", { name: /Einstellungen für Alt/ })).toBeDisabled();
  });

  it("kopiert den Link", async () => {
    const api = profileApi();
    api.on("GET /me/shares", () => ({ body: { shares: [share()] } }));
    const { ui } = await openProfile("shares");
    await ui.click(await within(section("Geteilte Checklisten")).findByRole("button", { name: "Link kopieren" }));
    expect(await clipboardText()).toBe("http://localhost:3000/s/TOKEN123");
  });

  it("ändert Einstellungen: Passwort nur senden, wenn eines eingegeben wurde", async () => {
    const api = profileApi();
    api.on("GET /me/shares", () => ({ body: { shares: [share({ access: "password", permission: "view" })] } }));
    api.on("PUT /runs/r1/share", ({ body }) => ({ body: { share: body } }));
    const { ui } = await openProfile("shares");
    await ui.click(await within(section("Geteilte Checklisten")).findByRole("button", { name: /Einstellungen für Ausflug Füssen/ }));
    const dialog = await screen.findByRole("dialog", { name: "Freigabe-Einstellungen" });
    expect(within(dialog).getByLabelText("Zugriff")).toHaveValue("password"); // aktuelle Werte sind vorbelegt
    await ui.selectOptions(within(dialog).getByLabelText("Berechtigung"), "edit");
    await ui.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /runs/r1/share")).toHaveLength(1));
    expect(api.callsTo("PUT /runs/r1/share")[0]!.body).toEqual({ access: "password", permission: "edit" }); // kein leeres Passwort

    await ui.click(await within(section("Geteilte Checklisten")).findByRole("button", { name: /Einstellungen für Ausflug Füssen/ }));
    const again = await screen.findByRole("dialog");
    await ui.type(within(again).getByLabelText("Passwort für den Link"), "neues-passwort");
    await ui.click(within(again).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(api.callsTo("PUT /runs/r1/share")).toHaveLength(2));
    expect(api.callsTo("PUT /runs/r1/share")[1]!.body).toEqual({ access: "password", permission: "view", password: "neues-passwort" });
  });

  it("zieht einzelne und alle Freigaben nach Rückfrage zurück", async () => {
    const api = profileApi();
    api.on("GET /me/shares", () => ({ body: { shares: [share(), share({ id: "s2", runId: "r2", runTitle: "Zweite" })] } }));
    api.on("DELETE /me/shares/s1", () => ({ status: 204 }));
    api.on("DELETE /me/shares", () => ({ body: { revoked: 2 } }));
    const { ui } = await openProfile("shares");
    const box = within(section("Geteilte Checklisten"));
    await ui.click(await box.findByRole("button", { name: "Freigabe von Ausflug Füssen zurückziehen" }));
    const one = await screen.findByRole("dialog", { name: "Teilen zurückziehen?" });
    expect(api.callsTo("DELETE /me/shares/s1")).toHaveLength(0);
    await ui.click(within(one).getByRole("button", { name: "Zurückziehen" }));
    await waitFor(() => expect(api.callsTo("DELETE /me/shares/s1")).toHaveLength(1));

    await ui.click(await box.findByRole("button", { name: "Alle Freigaben zurückziehen" }));
    const all = await screen.findByRole("dialog", { name: "Alle Freigaben zurückziehen?" });
    expect(all).toHaveTextContent("Alle 2 Links");
    await ui.click(within(all).getByRole("button", { name: "Zurückziehen" }));
    await waitFor(() => expect(api.callsTo("DELETE /me/shares")).toHaveLength(1));
  });
});

describe("Profil: Daten (F-50 bis F-52)", () => {
  it("prüft einen Import als Vorschau und importiert erst nach Bestätigung", async () => {
    const api = profileApi();
    api.on("POST /import", ({ body }) => body.dryRun
      ? { body: { valid: true, issues: [], warnings: [], counts: { templates: 1, runs: 0, items: 2 }, preview: { templates: [{ title: "Packliste", itemCount: 2, tags: [], sample: ["a", "b"] }], runs: [], tags: { new: ["Reisen"], existing: [] } } } }
      : { status: 201, body: { result: { templates: 1, runs: 0, items: 2, tagsCreated: 1, tagsReused: 0 }, warnings: [] } });
    const { ui } = await openProfile("data");
    const box = within(section("Daten"));
    expect(box.queryByRole("button", { name: "Jetzt importieren" })).not.toBeInTheDocument();
    const check = box.getByRole("button", { name: "Prüfen" });
    expect(check).toBeDisabled(); // ohne Inhalt nicht möglich
    await ui.click(box.getByLabelText("Oder Inhalt einfügen"));
    await ui.paste('{"templates":[{"title":"Packliste"}]}');
    await ui.click(check);
    expect(await box.findByText(/Bereit zum Import: 1 Vorlagen, 2 Punkte\./)).toBeInTheDocument();
    expect(box.getByText(/Vorlage „Packliste“ \(2 Punkte\)/)).toBeInTheDocument();
    expect(box.getByText("Neue Tags: Reisen")).toBeInTheDocument();
    expect(api.callsTo("POST /import")[0]!.body).toMatchObject({ format: "json", dryRun: true, templatesOnly: true });
    expect(api.callsTo("POST /import")).toHaveLength(1); // die Vorschau legt nichts an

    await ui.click(box.getByRole("button", { name: "Jetzt importieren" }));
    expect(await box.findByText("Importiert: 1 Vorlagen, 2 Punkte.")).toBeInTheDocument();
    expect(api.callsTo("POST /import")[1]!.body).toMatchObject({ dryRun: false });
    expect(box.getByLabelText("Oder Inhalt einfügen")).toHaveValue(""); // Eingabe geleert
  });

  it("zeigt Fehler der Vorschau mit Pfad bzw. Zeile und blockiert den Import", async () => {
    const api = profileApi();
    api.on("POST /import", () => ({ body: { valid: false, issues: [{ path: "Zeile 3", message: "Titel fehlt" }, { path: "templates[0].title", message: "darf nicht leer sein" }], warnings: [] } }));
    const { ui } = await openProfile("data");
    const box = within(section("Daten"));
    await ui.selectOptions(box.getByLabelText("Format"), "csv");
    await ui.click(box.getByLabelText("Oder Inhalt einfügen"));
    await ui.paste("Vorlage,Titel\nA,");
    await ui.click(box.getByRole("button", { name: "Prüfen" }));
    const alert = await box.findByRole("alert");
    expect(alert).toHaveTextContent("2 Probleme gefunden – es wird nichts importiert");
    expect(alert).toHaveTextContent("Zeile 3: Titel fehlt");
    expect(alert).toHaveTextContent("templates[0].title: darf nicht leer sein");
    expect(box.queryByRole("button", { name: "Jetzt importieren" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /import")[0]!.body).toMatchObject({ format: "csv" });
  });

  it("verlangt bei CSV optional einen Vorlagennamen und sendet ihn mit", async () => {
    const api = profileApi();
    api.on("POST /import", () => ({ body: { valid: false, issues: [], warnings: [] } }));
    const { ui } = await openProfile("data");
    const box = within(section("Daten"));
    expect(box.queryByLabelText(/Name der Vorlage/)).not.toBeInTheDocument(); // nur bei CSV
    await ui.selectOptions(box.getByLabelText("Format"), "csv");
    await ui.type(box.getByLabelText(/Name der Vorlage/), "Putzplan");
    await ui.click(box.getByLabelText("Oder Inhalt einfügen"));
    await ui.paste("Name\nKüche");
    await ui.click(box.getByRole("button", { name: "Prüfen" }));
    await waitFor(() => expect(api.callsTo("POST /import")).toHaveLength(1));
    expect(api.callsTo("POST /import")[0]!.body).toMatchObject({ format: "csv", title: "Putzplan" });
  });

  it("lädt Exporte über die Download-Schnittstelle herunter", async () => {
    const api = profileApi();
    const files: string[] = [];
    api.on("GET /export", () => ({ body: { format: "checklisten-export" } }));
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { files.push(this.download); });
    const { ui } = await openProfile("data");
    const box = within(section("Daten"));
    await ui.click(box.getByRole("button", { name: "Alle Vorlagen exportieren (JSON)" }));
    await waitFor(() => expect(files).toEqual(["vorlagen.json"]));
    click.mockRestore();
  });
});

describe("Profil: Konto löschen (F-52)", () => {
  it("löscht erst nach Passwortbestätigung und kehrt zur Anmeldung zurück", async () => {
    const api = profileApi();
    api.on("DELETE /me", () => { api.setUser(null); return { status: 204 }; });
    const { ui } = await openProfile();
    await ui.click(within(section("Konto löschen")).getByRole("button", { name: "Konto löschen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Konto endgültig löschen?" });
    const confirm = within(dialog).getByRole("button", { name: "Konto endgültig löschen" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("unwiderruflich");
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "Kaffeetasse-Wolke-42");
    await ui.click(confirm);
    expect(await screen.findByRole("heading", { name: "Anmelden", level: 1 })).toBeInTheDocument();
    expect(api.callsTo("DELETE /me")[0]!.body).toEqual({ password: "Kaffeetasse-Wolke-42" });
  });

  it("bleibt bei falschem Passwort im Dialog und meldet den Fehler", async () => {
    const api = profileApi();
    api.on("DELETE /me", () => apiError(403, "invalid_current_password"));
    const { ui } = await openProfile();
    await ui.click(within(section("Konto löschen")).getByRole("button", { name: "Konto löschen …" }));
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByLabelText("Passwort zur Bestätigung"), "falsch");
    await ui.click(within(dialog).getByRole("button", { name: "Konto endgültig löschen" }));
    await waitFor(() => expect(within(dialog).getAllByRole("alert").some((a) => a.textContent?.includes("Das aktuelle Passwort ist falsch."))).toBe(true));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Abbrechen schließt den Dialog ohne Serveraufruf", async () => {
    const api = profileApi();
    const { ui } = await openProfile();
    await ui.click(within(section("Konto löschen")).getByRole("button", { name: "Konto löschen …" }));
    await ui.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("DELETE /me")).toHaveLength(0);
  });
});

describe("Profil: Tastenkürzel", () => {
  it("zeigt die Übersicht aller Kürzel", async () => {
    profileApi();
    await openProfile("shortcuts");
    const box = within(section("Tastenkürzel"));
    for (const key of ["Strg + S", "N", "/", "?", "Esc"]) expect(box.getByText(key)).toBeInTheDocument();
  });
});
