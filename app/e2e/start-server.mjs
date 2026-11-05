// Startet den gebauten Server mit frischer, temporärer Datenbank für die Ende-zu-Ende-Tests.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".e2e-data");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const port = process.env.E2E_PORT ?? "3100";

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port, HOST: "127.0.0.1", APP_BASE_URL: `http://localhost:${port}`,
    SESSION_SECRET: "e2e-only-secret-e2e-only-secret-1234", DATABASE_PATH: join(dir, "app.db"),
    WEB_DIST: join(root, "web", "dist"), LOG_LEVEL: "warn", REGISTRATION_ENABLED: "true",
    API_RATE_LIMIT_PER_MINUTE: "1000",
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
