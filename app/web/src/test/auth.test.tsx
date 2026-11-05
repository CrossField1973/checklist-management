import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { USER, apiError, mockApi, renderApp } from "./harness";

const heading = (name: RegExp | string) => screen.findByRole("heading", { name, level: 1 });

describe("Zugriffsschutz und Weiterleitungen", () => {
  it("leitet Abgemeldete von geschützten Seiten zur Anmeldung", async () => {
    mockApi({ user: null });
    renderApp("/profile");
    expect(await heading("Anmelden")).toBeInTheDocument();
  });

  it("leitet Angemeldete von der Anmeldeseite zur Startseite", async () => {
    mockApi();
    renderApp("/login");
    expect(await heading("Aktuelle Durchführungen")).toBeInTheDocument();
    expect(screen.getByText("Anna Muster")).toBeInTheDocument();
  });

  it("kehrt nach der Anmeldung zur ursprünglich gewünschten Seite zurück", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", () => { api.setUser(USER); return { body: { user: USER } }; });
    api.on("GET /me/2fa", () => ({ body: { enabled: false, enabledAt: null, pendingSetup: false, recoveryCodesRemaining: 0 } }));
    api.on("GET /me/tokens", () => ({ body: { tokens: [] } }));
    api.on("GET /me/shares", () => ({ body: { shares: [] } }));
    const { ui } = renderApp("/profile");
    await ui.type(await screen.findByLabelText("E-Mail"), "anna@example.org");
    await ui.type(screen.getByLabelText("Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await heading("Profil")).toBeInTheDocument();
  });

  it("zeigt für unbekannte Adressen eine Hinweisseite", async () => {
    mockApi({ user: null });
    renderApp("/gibt-es-nicht");
    expect(await heading("Seite nicht gefunden")).toBeInTheDocument();
  });

  it("öffnet das Archiv für angemeldete Nutzer", async () => {
    mockApi().on("GET /runs", () => ({ body: { total: 0, runs: [] } }));
    renderApp("/archive");
    expect(await heading("Archiv")).toBeInTheDocument();
    expect(await screen.findByText("Das Archiv ist leer.")).toBeInTheDocument();
  });
});

describe("Anmelden", () => {
  it("meldet an, sendet E-Mail und Passwort und zeigt danach die Navigation", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", () => { api.setUser(USER); return { body: { user: USER } }; });
    const { ui } = renderApp("/login");
    await ui.type(await screen.findByLabelText("E-Mail"), "anna@example.org");
    await ui.type(screen.getByLabelText("Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await heading("Aktuelle Durchführungen")).toBeInTheDocument();
    expect(api.callsTo("POST /auth/login")[0]!.body).toEqual({ email: "anna@example.org", password: "Kaffeetasse-Wolke-42" });
    const nav = screen.getByRole("navigation", { name: "Hauptnavigation" });
    for (const name of ["Aktuelle Durchführungen", "Vorlagen", "Archiv", "Papierkorb", "Profil"]) expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
  });

  it("zeigt bei falschen Zugangsdaten eine Fehlermeldung (als Alert) und bleibt auf der Seite", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", () => apiError(401, "invalid_credentials"));
    const { ui } = renderApp("/login");
    await ui.type(await screen.findByLabelText("E-Mail"), "anna@example.org");
    await ui.type(screen.getByLabelText("Passwort"), "falsch");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-Mail oder Passwort ist falsch.");
    expect(screen.getByRole("heading", { name: "Anmelden", level: 1 })).toBeInTheDocument();
  });

  it("nennt bei zu vielen Versuchen die Wartezeit", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", () => apiError(429, "too_many_attempts", { retryAfterSeconds: 120 }));
    const { ui } = renderApp("/login");
    await ui.type(await screen.findByLabelText("E-Mail"), "a@b.de");
    await ui.type(screen.getByLabelText("Passwort"), "x");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("etwa 2 Minute");
  });

  it("fragt bei aktiver Zwei-Faktor-Anmeldung den Code ab und sendet ihn mit", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", ({ body }) => {
      if (!body.code) return apiError(401, "two_factor_required");
      if (body.code !== "123456") return apiError(401, "invalid_code");
      api.setUser(USER);
      return { body: { user: USER } };
    });
    const { ui } = renderApp("/login");
    await ui.type(await screen.findByLabelText("E-Mail"), "anna@example.org");
    await ui.type(screen.getByLabelText("Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));

    const code = await screen.findByLabelText(/Code aus der Authenticator-App/);
    expect(code).toHaveFocus();
    expect(screen.getByLabelText("E-Mail")).toHaveAttribute("readonly");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // der Zwischenschritt ist kein Fehler
    expect(screen.getByRole("button", { name: "Bestätigen" })).toBeInTheDocument();

    await ui.type(code, "000000");
    await ui.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Code ist falsch");

    await ui.clear(code);
    await ui.type(code, "123456");
    await ui.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await heading("Aktuelle Durchführungen")).toBeInTheDocument();
    expect(api.callsTo("POST /auth/login").at(-1)!.body).toEqual({ email: "anna@example.org", password: "Kaffeetasse-Wolke-42", code: "123456" });
  });

  it("weist nach Verwendung eines Wiederherstellungscodes auf die verbleibende Anzahl hin", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", ({ body }) => {
      if (!body.code) return apiError(401, "two_factor_required");
      api.setUser(USER);
      return { body: { user: USER, recoveryCodesRemaining: 1 } };
    });
    const { ui } = renderApp("/login");
    await ui.type(await screen.findByLabelText("E-Mail"), "a@b.de");
    await ui.type(screen.getByLabelText("Passwort"), "x");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    await ui.type(await screen.findByLabelText(/Code aus der Authenticator-App/), "ABCDE-FGHJK");
    await ui.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByText(/bleibt noch 1 Wiederherstellungscode/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument(); // noch nicht weitergeleitet
    await ui.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await heading("Aktuelle Durchführungen")).toBeInTheDocument();
  });

  it("zeigt „Passwort vergessen“ und „Registrieren“ nur, wenn der Server das anbietet", async () => {
    mockApi({ user: null, config: { smtpEnabled: false, registrationEnabled: false } });
    renderApp("/login");
    await heading("Anmelden");
    expect(screen.queryByRole("link", { name: "Passwort vergessen?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Registrieren" })).not.toBeInTheDocument();
  });

  it("zeigt die SSO-Schaltfläche mit dem Namen des Anbieters als normalen Link (Seitenwechsel)", async () => {
    mockApi({ user: null, config: { oidcEnabled: true, oidcName: "Authentik", oidcLoginUrl: "/api/v1/auth/oidc/login" } });
    renderApp("/login");
    const link = await screen.findByRole("link", { name: "Mit Authentik anmelden" });
    expect(link).toHaveAttribute("href", "/api/v1/auth/oidc/login");
  });

  it("übersetzt Fehler aus dem SSO-Ablauf (?error=…)", async () => {
    mockApi({ user: null, config: { oidcEnabled: true, oidcName: "SSO", oidcLoginUrl: "/x" } });
    renderApp("/login?error=sso_email_not_verified");
    expect(await screen.findByRole("alert")).toHaveTextContent("bestätigt die Adresse aber nicht");
  });

  it("fällt bei unbekanntem SSO-Fehlercode auf eine allgemeine SSO-Meldung zurück", async () => {
    mockApi({ user: null, config: { oidcEnabled: true, oidcName: "SSO", oidcLoginUrl: "/x" } });
    renderApp("/login?error=irgendwas");
    expect(await screen.findByRole("alert")).toHaveTextContent("Anmeldung per SSO ist fehlgeschlagen");
  });

  it("meldet ab und kehrt zur Anmeldung zurück", async () => {
    const api = mockApi();
    const { ui } = renderApp("/");
    await ui.click(await screen.findByRole("button", { name: "Abmelden" }));
    expect(await heading("Anmelden")).toBeInTheDocument();
    expect(api.callsTo("POST /auth/logout")).toHaveLength(1);
  });
});

describe("Registrieren", () => {
  it("legt ein Konto an, meldet an und zeigt die Startseite", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/register", () => { api.setUser(USER); return { status: 201, body: { user: USER } }; });
    const { ui } = renderApp("/register");
    await ui.type(await screen.findByLabelText("Anzeigename"), "Anna Muster");
    await ui.type(screen.getByLabelText("E-Mail"), "anna@example.org");
    await ui.type(screen.getByLabelText("Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(screen.getByRole("button", { name: "Registrieren" }));
    expect(await heading("Aktuelle Durchführungen")).toBeInTheDocument();
    expect(api.callsTo("POST /auth/register")[0]!.body).toEqual({ displayName: "Anna Muster", email: "anna@example.org", password: "Kaffeetasse-Wolke-42" });
  });

  it("erklärt Verstöße gegen die Passwort-Richtlinie verständlich", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/register", () => apiError(422, "password_policy", { problems: ["too_short"] }));
    const { ui } = renderApp("/register");
    await ui.type(await screen.findByLabelText("Anzeigename"), "A");
    await ui.type(screen.getByLabelText("E-Mail"), "a@b.de");
    await ui.type(screen.getByLabelText("Passwort"), "kurz");
    await ui.click(screen.getByRole("button", { name: "Registrieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Passwort ist nicht sicher genug. Es braucht mindestens 12 Zeichen.");
  });

  it("meldet vergebene E-Mail-Adressen", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/register", () => apiError(409, "email_taken"));
    const { ui } = renderApp("/register");
    await ui.type(await screen.findByLabelText("Anzeigename"), "A");
    await ui.type(screen.getByLabelText("E-Mail"), "a@b.de");
    await ui.type(screen.getByLabelText("Passwort"), "Kaffeetasse-Wolke-42");
    await ui.click(screen.getByRole("button", { name: "Registrieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("bereits vergeben");
  });

  it("zeigt bei abgeschalteter Registrierung nur einen Hinweis statt des Formulars", async () => {
    mockApi({ user: null, config: { registrationEnabled: false } });
    renderApp("/register");
    expect(await screen.findByText(/nicht selbst erstellt werden/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Passwort")).not.toBeInTheDocument();
  });
});

describe("Passwort vergessen und zurücksetzen", () => {
  it("antwortet nach dem Absenden immer neutral", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/forgot", () => ({ status: 202, body: { status: "accepted" } }));
    const { ui } = renderApp("/forgot-password");
    await ui.type(await screen.findByLabelText("E-Mail"), "irgendwer@example.org");
    await ui.click(screen.getByRole("button", { name: "Link senden" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Wenn ein Konto mit dieser E-Mail-Adresse existiert");
    expect(api.callsTo("POST /auth/forgot")[0]!.body).toEqual({ email: "irgendwer@example.org" });
  });

  it("erklärt, wenn der Server keine E-Mails versenden kann", async () => {
    mockApi({ user: null, config: { smtpEnabled: false } });
    renderApp("/forgot-password");
    expect(await screen.findByText(/nicht eingerichtet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("E-Mail")).not.toBeInTheDocument();
  });

  it("setzt das Passwort mit dem Token aus dem Link und verweist zur Anmeldung", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/reset", () => ({ body: { status: "ok" } }));
    const { ui } = renderApp("/reset-password?token=abcdefghij1234");
    await ui.type(await screen.findByLabelText("Neues Passwort"), "Frisches-Passwort-99");
    await ui.type(screen.getByLabelText("Passwort wiederholen"), "Frisches-Passwort-99");
    await ui.click(screen.getByRole("button", { name: "Passwort speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Dein Passwort wurde geändert");
    expect(api.callsTo("POST /auth/reset")[0]!.body).toEqual({ token: "abcdefghij1234", password: "Frisches-Passwort-99" });
    expect(screen.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/login");
  });

  it("prüft die Wiederholung, ohne den Server zu fragen", async () => {
    const api = mockApi({ user: null });
    const { ui } = renderApp("/reset-password?token=abcdefghij1234");
    await ui.type(await screen.findByLabelText("Neues Passwort"), "Frisches-Passwort-99");
    await ui.type(screen.getByLabelText("Passwort wiederholen"), "anders");
    await ui.click(screen.getByRole("button", { name: "Passwort speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stimmen nicht überein");
    expect(api.callsTo("POST /auth/reset")).toHaveLength(0);
  });

  it("meldet ungültige oder abgelaufene Links und fehlenden Token", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/reset", () => apiError(400, "invalid_or_expired_token"));
    const { ui, unmount } = renderApp("/reset-password?token=abcdefghij1234");
    await ui.type(await screen.findByLabelText("Neues Passwort"), "Frisches-Passwort-99");
    await ui.type(screen.getByLabelText("Passwort wiederholen"), "Frisches-Passwort-99");
    await ui.click(screen.getByRole("button", { name: "Passwort speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ungültig oder abgelaufen");
    unmount();
    renderApp("/reset-password");
    expect(await screen.findByRole("alert")).toHaveTextContent("Es fehlt der Zurücksetzen-Code");
  });
});

describe("Sprache und Design", () => {
  it("zeigt die Oberfläche in der Sprache des Profils", async () => {
    mockApi({ user: { ...USER, language: "en" } });
    renderApp("/");
    expect(await heading("Current runs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("setzt das Design aus dem Profil (hell/dunkel); „System“ folgt dem Gerät", async () => {
    const api = mockApi({ user: { ...USER, theme: "dark" } });
    const first = renderApp("/");
    await heading("Aktuelle Durchführungen");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    first.unmount();
    api.setUser({ ...USER, theme: "light" });
    const second = renderApp("/");
    await heading("Aktuelle Durchführungen");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    second.unmount();
    api.setUser({ ...USER, theme: "system" });
    renderApp("/");
    await heading("Aktuelle Durchführungen");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
  });

  it("nutzt vor der Anmeldung die Browsersprache bzw. die zuletzt gewählte Sprache", async () => {
    localStorage.setItem("language", "en");
    mockApi({ user: null });
    renderApp("/login");
    expect(await heading("Sign in")).toBeInTheDocument();
  });
});

describe("Barrierefreiheit (Grundlagen)", () => {
  it("bietet einen Sprunglink zum Inhalt und beschriftete Landmarken", async () => {
    mockApi();
    renderApp("/");
    expect(await screen.findByRole("link", { name: "Zum Inhalt springen" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("navigation", { name: "Hauptnavigation" })).toBeInTheDocument();
  });

  it("verbindet Formularfelder mit Beschriftung und kennzeichnet Fehler per Alert", async () => {
    const api = mockApi({ user: null });
    api.on("POST /auth/login", () => apiError(401, "invalid_credentials"));
    const { ui } = renderApp("/login");
    const email = await screen.findByLabelText("E-Mail");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Passwort")).toHaveAttribute("autocomplete", "current-password");
    await ui.type(email, "a@b.de");
    await ui.type(screen.getByLabelText("Passwort"), "x");
    await ui.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
