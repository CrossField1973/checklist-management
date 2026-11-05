import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";

export function Button({ variant = "default", size, className = "", type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger"; size?: "sm" }) {
  const v = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "";
  return <button type={type} className={`btn ${v} ${size === "sm" ? "btn-sm" : ""} ${className}`} {...rest} />;
}

interface FieldProps { label: string; hint?: string; error?: string | null; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }

/** Beschriftetes Formularfeld mit Hinweis- und Fehlertext (per aria-describedby verbunden). */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && <p id={`${id}-hint`} className="hint mt-1">{hint}</p>}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}

export function TextInput({ label, hint, error, ...rest }: ComponentProps<"input"> & { label: string; hint?: string; error?: string | null }) {
  return <Field label={label} hint={hint} error={error}>{(p) => <input className="input" {...p} {...rest} />}</Field>;
}

export function TextArea({ label, hint, error, ...rest }: ComponentProps<"textarea"> & { label: string; hint?: string; error?: string | null }) {
  return <Field label={label} hint={hint} error={error}>{(p) => <textarea className="input" {...p} {...rest} />}</Field>;
}

export function Select({ label, hint, error, children, ...rest }: ComponentProps<"select"> & { label: string; hint?: string; error?: string | null }) {
  return <Field label={label} hint={hint} error={error}>{(p) => <select className="input" {...p} {...rest}>{children}</select>}</Field>;
}

export function Alert({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: ReactNode }) {
  // Fehler werden Screenreadern sofort vorgelesen, Hinweise höflich
  return <div role={kind === "error" ? "alert" : "status"} className={`alert alert-${kind}`}>{children}</div>;
}

export function Card({ title, description, children, id }: { title?: string; description?: string; children: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className="card">
      {title && <h2 id={headingId} className="m-0 text-lg font-semibold">{title}</h2>}
      {description && <p className="hint mt-1 mb-0">{description}</p>}
      <div className={title ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

export function Spinner() {
  const { t } = useTranslation();
  return <p role="status" className="hint">{t("common.loading")}</p>;
}

/** Modaler Dialog auf Basis des nativen <dialog>: Fokusfalle, Esc zum Schließen und Hintergrund-Sperre kommen vom Browser. */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 id={titleId} className="m-0 text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
      {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
    </dialog>
  );
}

/** Übersetzt Server-Fehlercodes in verständliche Texte; unbekannte Codes erhalten eine allgemeine Meldung. */
export function useErrorText() {
  const { t, i18n } = useTranslation();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "password_policy") {
        const problems = err.problems.map((p) => t(`errors.policy.${p}`, { defaultValue: p }));
        return `${t("errors.password_policy")}${problems.length ? ` ${problems.join(" ")}` : ""}`;
      }
      if (err.retryAfterSeconds) {
        return t("errors.too_many_attempts_wait", { minutes: Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) });
      }
      const key = `errors.${err.code}`;
      if (i18n.exists(key)) return t(key);
      if (err.status === 0) return t("errors.network_error");
    }
    return t("errors.unknown");
  };
}
