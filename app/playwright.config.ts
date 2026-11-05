import { defineConfig } from "@playwright/test";

/**
 * Ende-zu-Ende-Tests der Hauptabläufe gegen den echten, gebauten Server (`npm run test:e2e` baut vorher alles).
 * Browser: standardmäßig das auf dem Rechner installierte Microsoft Edge; mit `E2E_BROWSER=chrome` Google Chrome,
 * mit `E2E_BROWSER=chromium` das von Playwright geladene Chromium (`npx playwright install chromium`).
 */
const PORT = 3100;
/** Mit E2E_BASE_URL (z. B. http://localhost:3000) laufen die Tests gegen einen bereits laufenden Server, etwa den Docker-Container. */
const external = process.env.E2E_BASE_URL;
const channel = process.env.E2E_BROWSER ?? "msedge";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
    locale: "de-DE",
    ...(channel === "chromium" ? {} : { channel }),
    trace: "retain-on-failure",
  },
  webServer: external ? undefined : {
    command: "node e2e/start-server.mjs",
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { E2E_PORT: String(PORT) },
  },
});
