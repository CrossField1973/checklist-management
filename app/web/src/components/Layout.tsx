import { useState } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { OfflineManager } from "../offline/OfflineManager";
import { Shortcuts } from "./Shortcuts";
import { Button, Spinner } from "./ui";

const NAV = [
  { to: "/", key: "nav.runs", end: true },
  { to: "/templates", key: "nav.templates" },
  { to: "/archive", key: "nav.archive" },
  { to: "/trash", key: "nav.trash" },
] as const;

/** Geschützter Bereich: ohne Sitzung Weiterleitung zur Anmeldung (mit Rücksprung). */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-6"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Shell />;
}

function Shell() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center justify-between rounded-lg px-3 py-2 no-underline ${isActive ? "bg-soft font-semibold text-primary" : "text-text hover:bg-bg"}`;

  return (
    <div className="min-h-screen md:grid md:grid-cols-[236px_1fr]">
      <a href="#main" className="skip-link">{t("common.skipToContent")}</a>

      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 md:hidden">
        <Button size="sm" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((o) => !o)}>☰ {t("nav.menu")}</Button>
        <span className="font-semibold">{t("app.name")}</span>
      </header>

      <nav id="sidebar" aria-label={t("nav.main")} className={`${open ? "flex" : "hidden"} flex-col gap-1 border-r border-border bg-surface p-3 md:sticky md:top-0 md:flex md:h-screen`}>
        <div className="mx-2 mb-3 hidden items-center gap-2 text-[17px] font-semibold md:flex">
          <img src="/favicon.svg" alt="" width={24} height={24} /> {t("app.name")}
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={"end" in n ? n.end : false} className={link} onClick={() => setOpen(false)}>{t(n.key)}</NavLink>
        ))}
        <div className="flex-1" />
        <div className="mx-2 mt-4 border-t border-border pt-3">
          <NavLink to="/profile" aria-label={t("nav.openProfile")} title={t("nav.openProfile")} className={({ isActive }) => `block rounded-lg px-2 py-1.5 no-underline ${isActive ? "bg-soft text-primary" : "text-text hover:bg-bg"}`} onClick={() => setOpen(false)}>
            <span className="block truncate text-sm font-semibold">{user?.displayName}</span>
            <span className="hint block truncate">{user?.email}</span>
          </NavLink>
          <Button size="sm" className="mt-2" onClick={() => void logout()}>{t("nav.logout")}</Button>
        </div>
      </nav>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl p-4 md:p-7">
        <Shortcuts />
        {user && <OfflineManager userId={user.id} />}
        <Outlet />
      </main>
    </div>
  );
}

/** Seiten für Abmeldete (Anmelden, Registrieren …): angemeldete Nutzer gehen zur Startseite. */
export function PublicOnly() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-6"><Spinner /></div>;
  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? "/"} replace />;
  return <Outlet />;
}

/** Rahmen für Anmelde-Seiten. */
export function AuthFrame({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="mb-4 flex items-center gap-2 text-xl font-semibold"><img src="/favicon.svg" alt="" width={28} height={28} /> {t("app.name")}</div>
      <main className="card">
        <h1 className="m-0 mb-1 text-xl font-semibold">{title}</h1>
        {children}
      </main>
      {footer && <div className="mt-4 text-center text-sm">{footer}</div>}
    </div>
  );
}
