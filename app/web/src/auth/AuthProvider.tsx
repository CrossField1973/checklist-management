import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { Accent, FontSize, Language, PublicConfig, Theme, User } from "../api/types";
import { applyLanguage, detectLanguage, rememberLanguage } from "../i18n";
import { kvGet, kvSet } from "../offline/idb";
import { clearOfflineData } from "../offline/persist";

interface AuthValue {
  /** angemeldeter Nutzer, null = abgemeldet */
  user: User | null;
  config: PublicConfig | undefined;
  /** true, solange noch unbekannt ist, ob eine Sitzung besteht */
  loading: boolean;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function applyTheme(theme: Theme | undefined) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme; // „System“: die Farben folgen prefers-color-scheme
}

/** Akzentfarbe und Schriftgröße als Attribute am Wurzelelement (die Werte stehen in styles.css); Standardwerte ohne Attribut. */
export function applyAppearance(accent: Accent | undefined, fontSize: FontSize | undefined) {
  const root = document.documentElement;
  if (accent && accent !== "blue") root.dataset.accent = accent; else delete root.dataset.accent;
  if (fontSize && fontSize !== "normal") root.dataset.fontsize = fontSize; else delete root.dataset.fontsize;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<User | null> => {
      try {
        const user = (await api.get<{ user: User }>("/me")).user;
        return user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) { void clearOfflineData(); return null; } // Sitzung beendet: lokale Daten entfernen
        if (err instanceof ApiError && err.status === 0) { // keine Verbindung: zuletzt angemeldeten Nutzer verwenden
          const cached = await kvGet<User>("user");
          if (cached) return cached;
        }
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
    networkMode: "always", // auch ohne Verbindung ausführen, um auf den gemerkten Nutzer zurückzufallen (F-74)
  });
  const config = useQuery({ queryKey: ["config"], queryFn: () => api.get<PublicConfig>("/config"), staleTime: 5 * 60_000, retry: 1, networkMode: "always" });

  const user = me.data ?? null;

  // Sprache: Profil (angemeldet) sonst Browser/zuletzt gewählt; Design: Profil sonst System
  useEffect(() => {
    const lang: Language = user?.language ?? detectLanguage(config.data?.defaultLanguage);
    applyLanguage(lang);
    if (user) rememberLanguage(user.language);
  }, [user?.language, config.data?.defaultLanguage, user]);
  useEffect(() => applyTheme(user?.theme), [user?.theme]);
  useEffect(() => applyAppearance(user?.accent, user?.fontSize), [user?.accent, user?.fontSize]);
  // Angemeldeten Nutzer für den Start ohne Verbindung merken (auch nach Anmeldung/Registrierung und Profiländerungen, F-74)
  useEffect(() => { if (user) void kvSet("user", user); }, [user]);

  const setUser = useCallback((u: User) => qc.setQueryData(["me"], u), [qc]);
  const logout = useCallback(async () => {
    try { await api.post("/auth/logout"); } finally {
      await clearOfflineData();
      qc.setQueryData(["me"], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "config" });
    }
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({ user, config: config.data, loading: me.isPending, setUser, logout }),
    [user, config.data, me.isPending, setUser, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth außerhalb des AuthProvider");
  return ctx;
}
