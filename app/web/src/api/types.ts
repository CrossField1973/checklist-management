export type Language = "de" | "en";
export type Theme = "light" | "dark" | "system";
export const ACCENTS = ["blue", "indigo", "violet", "rose", "orange", "green", "teal", "slate"] as const;
export type Accent = (typeof ACCENTS)[number];
export type FontSize = "normal" | "large" | "xlarge";

export interface User {
  id: string;
  email: string;
  displayName: string;
  language: Language;
  theme: Theme;
  accent: Accent;
  fontSize: FontSize;
  /** Erledigte Punkte in Checklisten ausblenden (gilt für alle Geräte des Benutzers) */
  hideDone: boolean;
  trashRetentionDays: number | null;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  createdAt: number;
}

export interface PublicConfig {
  registrationEnabled: boolean;
  smtpEnabled: boolean;
  oidcEnabled: boolean;
  oidcName: string | null;
  oidcLoginUrl: string | null;
  defaultLanguage: Language;
  mcpUrl: string;
}

export interface TwoFactorStatus { enabled: boolean; enabledAt: number | null; pendingSetup: boolean; recoveryCodesRemaining: number }
export interface TwoFactorSetup { secret: string; otpauthUrl: string }

export interface ApiTokenInfo {
  id: string; name: string; prefix: string; permission: "read" | "write";
  expiresAt: number | null; expired: boolean; lastUsedAt: number | null; createdAt: number;
}

export interface ShareInfo {
  id: string; runId: string; runTitle: string; runStatus: "active" | "archived"; runDeleted: boolean;
  access: "anyone" | "password"; permission: "view" | "edit"; url: string | null; createdAt: number;
}

export interface SsoStatus { enabled: boolean; name: string | null; linked: boolean }

export interface ImportIssue { path: string; message: string }
export interface ImportPreview {
  valid: boolean; issues: ImportIssue[]; warnings: string[];
  counts?: { templates: number; runs: number; items: number };
  preview?: {
    templates: { title: string; itemCount: number; tags: string[]; sample: string[] }[];
    runs: { title: string; status: string; sections: string[]; progress: { done: number; total: number } }[];
    tags: { new: string[]; existing: string[] };
  };
}
export interface ImportResult { templates: number; runs: number; items: number; tagsCreated: number; tagsReused: number }

export interface Tag { id: string; name: string; color: string; /** automatisch gewählte Schriftfarbe (schwarz/weiß) mit AA-Kontrast */ textColor: string; templateCount?: number }

export interface TemplateSummary {
  id: string; title: string; description: string | null; tags: Tag[]; itemCount: number; createdAt: number; updatedAt: number;
}
export interface TemplateDetail extends TemplateSummary { items: import("../lib/tree").ItemNode[] }

export interface Progress { done: number; total: number }
export interface ShareBadge { access: "anyone" | "password"; permission: "view" | "edit" }
export interface RunSummary {
  id: string; title: string; status: "active" | "archived"; createdAt: number; updatedAt: number; archivedAt: number | null;
  sectionTitles: string[]; progress: Progress; share: ShareBadge | null;
}
export interface RunItemNode {
  id: string; title: string; description: string | null; position: number; isChecked: boolean; checkedAt: number | null;
  childProgress: Progress; children: RunItemNode[];
}
export interface RunSection { id: string; title: string; position: number; sourceTemplateId: string | null; progress: Progress; items: RunItemNode[] }
export interface RunDetail {
  id: string; title: string; status: "active" | "archived"; createdAt: number; updatedAt: number; archivedAt: number | null;
  share: ShareBadge | null; sections: RunSection[]; progress: Progress;
}
export interface OwnShare { id: string; access: "anyone" | "password"; permission: "view" | "edit"; url: string | null; createdAt: number }
export interface TrashEntry {
  type: "template" | "run"; id: string; title: string; deletedAt: number; purgeAt: number | null;
  statusBeforeDelete?: "active" | "archived"; progress?: Progress;
}
