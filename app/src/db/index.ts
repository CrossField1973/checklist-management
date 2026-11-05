import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof openDatabase>;

// Liegt sowohl in src/db (Entwicklung) als auch dist/db (Build) zwei Ebenen unter dem App-Ordner.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Öffnet die SQLite-Datei (oder ":memory:"), aktiviert Fremdschlüssel und führt Migrationen aus. */
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return Object.assign(db, { sqlite });
}

export { schema };
