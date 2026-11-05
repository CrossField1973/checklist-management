import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import type { Logger } from "./logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Löscht Papierkorb-Einträge endgültig, deren Aufbewahrungsdauer (Profil, F-32) abgelaufen ist.
 * Nutzer ohne Frist („nie“) bleiben unberührt. Das Archiv wird nie automatisch geleert.
 */
export function purgeExpiredTrash(db: Db, now = Date.now()) {
  let templates = 0;
  let runs = 0;
  const users = db.select({ id: schema.users.id, days: schema.users.trashRetentionDays }).from(schema.users)
    .where(isNotNull(schema.users.trashRetentionDays)).all();
  db.transaction((tx) => {
    for (const u of users) {
      if (!u.days || u.days <= 0) continue;
      const cutoff = now - u.days * DAY_MS;
      templates += tx.delete(schema.templates)
        .where(and(eq(schema.templates.ownerId, u.id), isNotNull(schema.templates.deletedAt), lt(schema.templates.deletedAt, cutoff))).run().changes;
      runs += tx.delete(schema.runs)
        .where(and(eq(schema.runs.ownerId, u.id), isNotNull(schema.runs.deletedAt), lt(schema.runs.deletedAt, cutoff))).run().changes;
    }
  });
  return { templates, runs };
}

/** Entfernt abgelaufene oder verbrauchte Passwort-Reset-Token (N-10). */
export function purgeStaleResetTokens(db: Db, now = Date.now()) {
  return db.delete(schema.passwordResets)
    .where(or(lt(schema.passwordResets.expiresAt, now), isNotNull(schema.passwordResets.usedAt))).run().changes;
}

export function runMaintenance(db: Db, logger: Logger, now = Date.now()) {
  try {
    const trash = purgeExpiredTrash(db, now);
    const resetTokens = purgeStaleResetTokens(db, now);
    if (trash.templates || trash.runs || resetTokens) {
      logger.info({ event: "maintenance", trashTemplates: trash.templates, trashRuns: trash.runs, resetTokens }, "Wartung: abgelaufene Einträge gelöscht");
    }
  } catch (err) {
    logger.error({ err, event: "maintenance_failed" }, "Wartung fehlgeschlagen");
  }
}

/** Startet die Hintergrundjobs im selben Prozess (N-10): einmal beim Start, danach stündlich. */
export function startJobs(db: Db, logger: Logger): () => void {
  runMaintenance(db, logger);
  const timer = setInterval(() => runMaintenance(db, logger), HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
