import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import App from "../App";
import type { PublicConfig, User } from "../api/types";
import { AuthProvider } from "../auth/AuthProvider";

export const USER: User = {
  id: "u1", email: "anna@example.org", displayName: "Anna Muster", language: "de", theme: "system",
  trashRetentionDays: 30, hasPassword: true, twoFactorEnabled: false, createdAt: 1,
};
export const CONFIG: PublicConfig = {
  registrationEnabled: true, smtpEnabled: true, oidcEnabled: false, oidcName: null, oidcLoginUrl: null,
  defaultLanguage: "de", mcpUrl: "http://localhost:3000/mcp",
};

export interface Call { method: string; path: string; body: any; headers: Record<string, string> }
type Result = { status?: number; body?: unknown } | undefined | void;
type Handler = (call: Call) => Result | Promise<Result>;

/**
 * Ersetzt `fetch` durch eine kleine Fake-API: Routen werden als „METHODE /pfad“ (ohne /api/v1) registriert.
 * Nicht registrierte Aufrufe schlagen laut fehl, damit Tests keine ungewollten Anfragen übersehen.
 */
export function mockApi(opts: { user?: User | null; config?: Partial<PublicConfig> } = {}) {
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  let user: User | null = opts.user === undefined ? USER : opts.user;
  const config = { ...CONFIG, ...opts.config };

  routes.set("GET /config", () => ({ body: config }));
  routes.set("GET /me", () => (user ? { body: { user } } : { status: 401, body: { error: "unauthorized" } }));
  routes.set("POST /auth/logout", () => { user = null; return { status: 204 }; });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = String(input).replace(/^\/api\/v1/, "");
    let body: any = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    const call = { method, path, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const handler = routes.get(`${method} ${path.split("?")[0]}`);
    if (!handler) throw new Error(`Unerwarteter API-Aufruf: ${method} ${path}`);
    const res = (await handler(call)) ?? {};
    const status = res.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(res.body ?? {}), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    on(route: string, handler: Handler) { routes.set(route, handler); return this; },
    /** Aufrufe einer Route (z. B. „PUT /me“) */
    callsTo: (route: string) => calls.filter((c) => `${c.method} ${c.path.split("?")[0]}` === route),
    setUser(u: User | null) { user = u; },
  };
}

export function renderApp(route = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, ui, queryClient };
}

/** Kurzform für JSON-Fehlerantworten des Servers */
export const apiError = (status: number, error: string, extra: object = {}) => ({ status, body: { error, ...extra } });
