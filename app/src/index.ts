import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { startJobs } from "./jobs.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = openDatabase(config.DATABASE_PATH);
  const app = buildServer({ config, db, logger });
  const stopJobs = startJobs(db, logger);

  const shutdown = async (signal: string) => {
    logger.info({ event: "shutdown", signal }, "Beende Anwendung");
    stopJobs();
    await app.close();
    db.sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { event: "startup", registrationEnabled: config.REGISTRATION_ENABLED, smtp: config.smtpEnabled, oidc: config.oidcEnabled },
    "Anwendung gestartet",
  );
}

main().catch((err) => {
  // Konfigurationsfehler sind erwartbar und sollen lesbar auf stderr landen.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
