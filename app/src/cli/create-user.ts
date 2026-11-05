import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/index.js";
import { EmailTakenError, PasswordPolicyError, createUser } from "../users.js";

/**
 * Legt einen Nutzer an – auch bei REGISTRATION_ENABLED=false (N-07).
 *
 *   create-user <email> [Anzeigename]
 *
 * Das Passwort wird aus CREATE_USER_PASSWORD gelesen. Ist die Variable nicht gesetzt,
 * wird ein zufälliges Passwort erzeugt und einmalig ausgegeben.
 */
async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email || email.startsWith("-")) {
    console.error("Verwendung: create-user <email> [Anzeigename]\nOptional: CREATE_USER_PASSWORD=<passwort>");
    process.exit(2);
  }
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  const generated = !process.env.CREATE_USER_PASSWORD;
  const password = process.env.CREATE_USER_PASSWORD || randomBytes(18).toString("base64url");
  const displayName = nameParts.join(" ").trim() || email.split("@")[0]!;

  try {
    const user = await createUser(db, config, { email, displayName, password });
    console.log(`Nutzer angelegt: ${user.email}`);
    if (generated) console.log(`Zufälliges Passwort (bitte nach dem Login ändern): ${password}`);
  } catch (err) {
    if (err instanceof EmailTakenError) console.error("Fehler: Diese E-Mail ist bereits vergeben.");
    else if (err instanceof PasswordPolicyError) console.error(`Fehler: Passwort entspricht nicht der Richtlinie (${err.problems.join(", ")}).`);
    else throw err;
    process.exit(1);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
