import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Progress, RunItemNode, RunSection } from "../../api/types";
import { Button, Dialog } from "../../components/ui";

export interface BoardActions {
  onCheck: (item: RunItemNode, checked: boolean) => Promise<void>;
  onAdd: (sectionId: string, title: string, parentItemId: string | null) => Promise<void>;
  onDelete: (item: RunItemNode) => Promise<void>;
  onDeleteSection?: (section: RunSection) => Promise<void>;
}

export function ProgressBar({ progress, label }: { progress: Progress; label: string }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-bg">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm tabular-nums">{progress.done}/{progress.total}</span>
    </div>
  );
}

function AddForm({ label, onAdd, onClose, autoFocus }: { label: string; onAdd: (title: string) => Promise<void>; onClose?: () => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try { await onAdd(title); setValue(""); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex gap-2" noValidate>
      <input className="input min-w-0 flex-1" aria-label={label} placeholder={t("runs.addPlaceholder")} value={value} maxLength={200} autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && onClose) { e.preventDefault(); onClose(); } }} />
      <Button type="submit" variant="primary" disabled={busy || !value.trim()}>{t("common.add")}</Button>
      {onClose && <Button onClick={onClose}>{t("common.cancel")}</Button>}
    </form>
  );
}

const isDone = (i: RunItemNode): boolean => i.isChecked && i.children.every(isDone);

function Item({ item, sectionId, readOnly, hideDone, actions, onAskDelete }: { item: RunItemNode; sectionId: string; readOnly: boolean; hideDone: boolean; actions: BoardActions; onAskDelete: (i: RunItemNode) => void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const hasChildren = item.children.length > 0;
  const pending = item.id.startsWith("tmp-"); // offline angelegt, noch nicht übertragen (F-74)
  return (
    <li>
      <div className="row flex flex-wrap items-start gap-2 rounded-lg border border-border bg-surface p-1 pr-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <label className={`flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 ${readOnly || pending ? "" : "cursor-pointer hover:bg-bg"}`}>
              <input
                type="checkbox" className="h-6 w-6 shrink-0" checked={item.isChecked} disabled={readOnly || pending}
                id={`chk-${item.id}`} onChange={(e) => void actions.onCheck(item, e.target.checked)}
              />
              <span className={`break-words font-medium ${item.isChecked ? "text-muted line-through" : ""}`}>{item.title}</span>
            </label>
            {pending && <span className="badge">{t("offline.waiting")}</span>}
            {hasChildren && <span className="badge" aria-label={t("runs.subProgress", { done: item.childProgress.done, total: item.childProgress.total })}>{item.childProgress.done}/{item.childProgress.total}</span>}
          </div>
          {item.description && <p className="hint m-0 whitespace-pre-wrap break-words px-2 pb-1">{item.description}</p>}
        </div>
        {!readOnly && !pending && (
          <div role="group" aria-label={t("runs.actionsFor", { title: item.title })} className="row-actions flex gap-1 self-center">
            <Button size="sm" aria-expanded={adding} onClick={() => setAdding((a) => !a)} aria-label={t("runs.addChild", { title: item.title })} title={t("runs.addChildShort")}>＋</Button>
            <Button size="sm" variant="danger" onClick={() => onAskDelete(item)} aria-label={t("runs.deleteItem", { title: item.title })} title={t("common.delete")}>🗑</Button>
          </div>
        )}
      </div>
      {(hasChildren || adding) && (
        <ul className="m-0 mt-2 grid list-none gap-2 p-0 pl-6">
          {item.children.filter((c) => !(hideDone && isDone(c))).map((c) => <Item key={c.id} item={c} sectionId={sectionId} readOnly={readOnly} hideDone={hideDone} actions={actions} onAskDelete={onAskDelete} />)}
          {adding && <li><AddForm label={t("runs.addChildLabel", { title: item.title })} autoFocus onClose={() => setAdding(false)} onAdd={(title) => actions.onAdd(sectionId, title, item.id)} /></li>}
        </ul>
      )}
    </li>
  );
}

/** Abschnitte mit ihren Punkten (F-23 bis F-25). Wird von der eigenen Ansicht und der Freigabe-Ansicht genutzt; `readOnly` sperrt alles. */
export function RunBoard({ sections, readOnly, hideDone = false, actions }: { sections: RunSection[]; readOnly: boolean; hideDone?: boolean; actions: BoardActions }) {
  const { t } = useTranslation();
  const [toDelete, setToDelete] = useState<RunItemNode | null>(null);
  const [sectionToDelete, setSectionToDelete] = useState<RunSection | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmDelete() {
    setBusy(true);
    try {
      if (toDelete) await actions.onDelete(toDelete);
      if (sectionToDelete && actions.onDeleteSection) await actions.onDeleteSection(sectionToDelete);
    } finally { setBusy(false); setToDelete(null); setSectionToDelete(null); }
  }

  return (
    <div className="grid gap-4">
      {sections.length === 0 && <p className="hint">{t("runs.noSections")}</p>}
      {sections.map((s) => (
        <section key={s.id} className="card" aria-labelledby={`sec-${s.id}`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id={`sec-${s.id}`} className="m-0 flex-1 text-lg font-semibold">{s.title}</h2>
            <div className="w-40"><ProgressBar progress={s.progress} label={t("runs.sectionProgress", { title: s.title })} /></div>
            {!readOnly && actions.onDeleteSection && (
              <Button size="sm" variant="danger" onClick={() => setSectionToDelete(s)} aria-label={t("runs.removeSection", { title: s.title })}>{t("runs.removeSectionShort")}</Button>
            )}
          </div>
          <ul className="m-0 mt-3 grid list-none gap-2 p-0" aria-label={s.title}>
            {s.items.filter((i) => !(hideDone && isDone(i))).map((i) => <Item key={i.id} item={i} sectionId={s.id} readOnly={readOnly} hideDone={hideDone} actions={actions} onAskDelete={setToDelete} />)}
          </ul>
          {s.items.length === 0 && <p className="hint">{t("runs.emptySection")}</p>}
          {hideDone && s.items.length > 0 && s.items.every(isDone) && <p className="hint">{t("runs.allHidden")}</p>}
          {!readOnly && <div className="mt-3"><AddForm label={t("runs.addLabel", { title: s.title })} onAdd={(title) => actions.onAdd(s.id, title, null)} /></div>}
        </section>
      ))}

      <Dialog
        open={toDelete !== null || sectionToDelete !== null} onClose={() => { setToDelete(null); setSectionToDelete(null); }}
        title={toDelete ? t("runs.deleteItemTitle") : t("runs.removeSectionTitle")}
        footer={<><Button onClick={() => { setToDelete(null); setSectionToDelete(null); }}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>{t("common.delete")}</Button></>}
      >
        <p className="m-0">{toDelete ? t("runs.deleteItemText", { title: toDelete.title, count: toDelete.childProgress.total }) : t("runs.removeSectionText", { title: sectionToDelete?.title })}</p>
      </Dialog>
    </div>
  );
}
