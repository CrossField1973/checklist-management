import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/** Zeitstempel als Unix-Millisekunden, IDs als UUID-Text (Pflichtenheft Abschnitt 4). */
const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => integer("created_at").notNull().$defaultFn(() => Date.now());

// ---------- Konto ----------
export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"), // null bei reinem SSO
  language: text("language", { enum: ["de", "en"] }).notNull().default("de"),
  theme: text("theme", { enum: ["light", "dark", "system"] }).notNull().default("system"),
  trashRetentionDays: integer("trash_retention_days"), // null = nie
  totpSecret: text("totp_secret"), // verschlüsselt gespeichert
  totpEnabledAt: integer("totp_enabled_at"), // null = nicht aktiv (Secret nur vorläufig, falls gesetzt)
  totpLastStep: integer("totp_last_step"), // zuletzt akzeptierter Zeitschritt (Replay-Schutz)
  createdAt: createdAt(),
});

export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
  },
  (t) => [uniqueIndex("user_identities_provider_subject").on(t.provider, t.subject)],
);

export const recoveryCodes = sqliteTable("recovery_codes", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: integer("used_at"),
});

export const passwordResets = sqliteTable("password_resets", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  permission: text("permission", { enum: ["read", "write"] }).notNull(),
  expiresAt: integer("expires_at"),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  createdAt: createdAt(),
});

/** Technische Browser-Sitzungen, ohne Oberfläche. */
export const sessions = sqliteTable("sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  lastSeenAt: integer("last_seen_at").notNull().$defaultFn(() => Date.now()),
  userAgent: text("user_agent"),
});

// ---------- Tags (nur für Vorlagen) ----------
export const tags = sqliteTable(
  "tags",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(), // #RRGGBB
  },
  (t) => [uniqueIndex("tags_user_name").on(t.userId, t.name)],
);

// ---------- Vorlagen ----------
export const templates = sqliteTable(
  "templates",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
    deletedAt: integer("deleted_at"), // Papierkorb
  },
  (t) => [index("templates_owner").on(t.ownerId, t.deletedAt)],
);

export const templateItems = sqliteTable(
  "template_items",
  {
    id: id(),
    templateId: text("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    parentItemId: text("parent_item_id").references((): AnySQLiteColumn => templateItems.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("template_items_tpl").on(t.templateId), index("template_items_parent").on(t.parentItemId)],
);

export const templateTags = sqliteTable(
  "template_tags",
  {
    templateId: text("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.tagId] })],
);

// ---------- Durchführungen ----------
export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
    archivedAt: integer("archived_at"),
    deletedAt: integer("deleted_at"), // Papierkorb (auch für „Abschließen“)
    statusBeforeDelete: text("status_before_delete", { enum: ["active", "archived"] }),
  },
  (t) => [index("runs_owner").on(t.ownerId, t.status, t.deletedAt)],
);

export const runSections = sqliteTable(
  "run_sections",
  {
    id: id(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    sourceTemplateId: text("source_template_id").references(() => templates.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(), // Kopie des Vorlagennamens
    position: integer("position").notNull().default(0),
  },
  (t) => [index("run_sections_run").on(t.runId)],
);

export const runItems = sqliteTable(
  "run_items",
  {
    id: id(),
    sectionId: text("section_id").notNull().references(() => runSections.id, { onDelete: "cascade" }),
    parentItemId: text("parent_item_id").references((): AnySQLiteColumn => runItems.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    isChecked: integer("is_checked", { mode: "boolean" }).notNull().default(false),
    checkedAt: integer("checked_at"),
  },
  (t) => [index("run_items_section").on(t.sectionId), index("run_items_parent").on(t.parentItemId)],
);

// ---------- Teilen (kein Ablaufdatum, nur für aktive Durchführungen) ----------
export const runShares = sqliteTable(
  "run_shares",
  {
    id: id(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenEnc: text("token_enc"), // verschlüsselter Token, damit der Link später erneut angezeigt werden kann
    access: text("access", { enum: ["anyone", "password"] }).notNull(),
    passwordHash: text("password_hash"),
    permission: text("permission", { enum: ["view", "edit"] }).notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("run_shares_run").on(t.runId)],
);
