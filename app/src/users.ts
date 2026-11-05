import { eq } from "drizzle-orm";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { checkPasswordPolicy, hashPassword, type PasswordProblem } from "./auth/password.js";
import type { User } from "./plugins/auth.js";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function toUserDto(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    language: u.language,
    theme: u.theme,
    trashRetentionDays: u.trashRetentionDays,
    hasPassword: u.passwordHash !== null,
    twoFactorEnabled: u.totpEnabledAt !== null,
    createdAt: u.createdAt,
  };
}

export function findUserByEmail(db: Db, email: string) {
  return db.select().from(schema.users).where(eq(schema.users.email, normalizeEmail(email))).get();
}

export class PasswordPolicyError extends Error {
  constructor(public problems: PasswordProblem[]) {
    super("password_policy");
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super("email_taken");
  }
}

/** Legt einen Nutzer an (Registrierung und CLI). Wirft PasswordPolicyError / EmailTakenError. */
export async function createUser(
  db: Db,
  config: Config,
  input: { email: string; displayName: string; password: string },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const problems = await checkPasswordPolicy(
    input.password,
    { email, displayName: input.displayName },
    config.PASSWORD_BREACH_CHECK,
  );
  if (problems.length) throw new PasswordPolicyError(problems);
  if (findUserByEmail(db, email)) throw new EmailTakenError();
  const passwordHash = await hashPassword(input.password);
  const [user] = db
    .insert(schema.users)
    .values({
      email,
      displayName: input.displayName.trim(),
      passwordHash,
      language: config.DEFAULT_LANGUAGE,
      trashRetentionDays: config.TRASH_RETENTION_DAYS === 0 ? null : config.TRASH_RETENTION_DAYS,
    })
    .returning()
    .all();
  return user!;
}
