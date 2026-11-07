import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, downloadFile } from "../../api/client";
import type { TemplateDetail } from "../../api/types";
import { Alert, Button, Card, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";
import { ExportDialog } from "../../components/ExportDialog";
import { CopyIcon, DownloadIcon, TrashIcon } from "../../components/icons";
import { addRefToTree, addToTree, countNodes, moveInTree, removeFromTree, toInput, updateInTree, type ItemNode, type MoveTarget } from "../../lib/tree";
import { TemplatePicker } from "../runs/TemplatePicker";
import { ItemTree } from "./ItemTree";
import { useLeaveGuard } from "./LeaveGuard";
import { TagPicker } from "./TagPicker";

type Detail = { template: TemplateDetail };
export interface Draft { title: string; tagIds: string[]; items: ItemNode[] }

const snapshot = (d: Draft) => JSON.stringify({ t: d.title.trim(), g: [...d.tagIds].sort(), i: toInput(d.items) });
const fromTemplate = (tpl: TemplateDetail): Draft => ({ title: tpl.title, tagIds: tpl.tags.map((x) => x.id), items: tpl.items });
const payload = (d: Draft) => ({ title: d.title.trim(), tagIds: d.tagIds, items: toInput(d.items) });

/**
 * Gemeinsamer Entwurf für „Vorlage erstellen“ und „Vorlage bearbeiten“: Punkte, Titel, Beschreibung und Tags werden lokal
 * geändert und erst mit „Erstellen“ bzw. „Speichern“ in einem Schritt übertragen. Beim Verlassen mit offenen Änderungen wird nachgefragt.
 */
function DraftForm({ mode, templateId, initial, initialUsedIn = 0 }: { mode: "create" | "edit"; templateId?: string; initial: Draft; initialUsedIn?: number }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const creating = mode === "create";

  const [draft, setDraft] = useState<Draft>(initial);
  const [baseline, setBaseline] = useState(() => snapshot(initial));
  const [savedTitle, setSavedTitle] = useState(initial.title);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ItemNode | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleting, setDeleting] = useState<ItemNode | null>(null);
  const [deleteTemplate, setDeleteTemplate] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const [refPick, setRefPick] = useState<string[]>([]);
  const usedIn = initialUsedIn;

  const dirty = creating || snapshot(draft) !== baseline;
  const { dialog: leaveDialog, allowLeave } = useLeaveGuard(dirty);
  const set = (patch: Partial<Draft>) => { setNotice(null); setDraft((d) => ({ ...d, ...patch })); };
  const setItems = (items: ItemNode[]) => set({ items });

  const addItem = async (title: string, parentId: string | null) => setItems(addToTree(draft.items, title, parentId));
  const moveItem = async (itemId: string, target: MoveTarget) => {
    const next = moveInTree(draft.items, itemId, target.parentItemId, target.position);
    if (next) setItems(next);
  };
  /** Fügt die gewählten Vorlagen als Verweise ein (deren Punkte erscheinen später als Unterpunkte). */
  async function addRefs() {
    const known = await qc.fetchQuery({ queryKey: ["templates", "all"], queryFn: () => api.get<{ templates: { id: string; title: string; itemCount: number }[] }>("/templates?sort=title&limit=100") });
    let items = draft.items;
    for (const id of refPick) {
      const tpl = known.templates.find((x) => x.id === id);
      if (tpl) items = addRefToTree(items, { templateId: tpl.id, title: tpl.title, itemCount: tpl.itemCount, missing: false });
    }
    setItems(items);
    setRefsOpen(false);
    setRefPick([]);
  }
  function openEdit(node: ItemNode) { setEditing(node); setEditTitle(node.title); }
  function saveItemEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setItems(updateInTree(draft.items, editing.id, { title: editTitle.trim() }));
    setEditing(null);
  }
  function confirmDeleteItem() {
    if (!deleting) return;
    setItems(removeFromTree(draft.items, deleting.id));
    setDeleting(null);
  }

  async function submit() {
    if (!draft.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const res = await api.post<Detail>("/templates", payload(draft));
        await qc.invalidateQueries({ queryKey: ["templates"] });
        allowLeave();
        navigate(`/templates/${res.template.id}`, { replace: true, state: { notice: t("editor.created") } });
      } else {
        const res = await api.put<Detail>(`/templates/${templateId}`, payload(draft));
        const next = fromTemplate(res.template);
        qc.setQueryData<Detail>(["template", templateId], res);
        void qc.invalidateQueries({ queryKey: ["templates"] });
        setDraft(next); // der Server vergibt die Punkt-IDs neu
        setBaseline(snapshot(next));
        setSavedTitle(next.title);
        setNotice(t("common.saved"));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    setError(null);
    try {
      const res = await api.post<Detail>(`/templates/${templateId}/duplicate`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      navigate(`/templates/${res.template.id}`, { state: { notice: t("templates.duplicated") } });
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function removeTemplate() {
    setBusy(true);
    try {
      await api.del(`/templates/${templateId}`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      qc.removeQueries({ queryKey: ["template", templateId] });
      allowLeave();
      navigate("/templates", { replace: true, state: { notice: t("templates.deleted", { title: savedTitle }) } });
    } catch (err) {
      setError(errorText(err));
      setDeleteTemplate(false);
    } finally {
      setBusy(false);
    }
  }
  const download = (format: string, delimiter?: string, name = "export") =>
    downloadFile(`/templates/${templateId}/export?format=${format}${delimiter ? `&delimiter=${delimiter}` : ""}`, name).catch((err) => setError(errorText(err)));

  const childCount = (n: ItemNode) => countNodes(n.children);

  return (
    <>
      <p className="mt-0"><Link className="link" to="/templates">← {t("editor.back")}</Link></p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 break-words text-2xl font-semibold">
          {creating ? t("editor.creatingHeading", { title: draft.title }) : savedTitle}
        </h1>
        {!creating && (
          <>
            <Button onClick={() => setExportOpen(true)}>{t("editor.export")} <DownloadIcon /></Button>
            <Button onClick={() => void duplicate()}>{t("templates.duplicate")} <CopyIcon /></Button>
            <Button variant="danger" onClick={() => setDeleteTemplate(true)}>{t("common.delete")} <TrashIcon /></Button>
          </>
        )}
        <Button variant="primary" data-shortcut="save" disabled={busy || !draft.title.trim() || (!creating && !dirty)} onClick={() => void submit()}>
          {creating ? t("editor.createButton") : t("common.save")}
        </Button>
      </div>
      {dirty && !creating && <p className="hint mt-0">{t("editor.unsaved")}</p>}
      {creating && <p className="hint mt-0">{t("editor.createHint")}</p>}

      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      <div className="grid gap-4">
        <Card title={t("editor.items")} description={t("editor.itemsHint", { count: countNodes(draft.items) })}>
          <ItemTree items={draft.items} onAdd={addItem} onEdit={openEdit} onDelete={(n) => setDeleting(n)} onMove={moveItem} />
          <div className="mt-3"><Button onClick={() => setRefsOpen(true)}>{t("editor.addTemplate")}</Button><span className="hint ml-2">{t("editor.addTemplateHint")}</span></div>
        </Card>

        <Card title={t("editor.details")}>
          <TextInput label={t("templates.titleLabel")} required maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
          <TagPicker value={draft.tagIds} onChange={(tagIds) => set({ tagIds })} />
        </Card>

      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t("items.editTitle")}>
        <form onSubmit={saveItemEdit} noValidate>
          <TextInput label={t("items.titleLabel")} required autoFocus maxLength={200} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!editTitle.trim()}>{t("items.apply")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title={t("items.deleteTitle")}
        footer={<><Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button><Button variant="danger" onClick={confirmDeleteItem}>{t("common.delete")}</Button></>}>
        <p className="m-0">{deleting && childCount(deleting) > 0 ? t("items.deleteWithChildren", { title: deleting.title, count: childCount(deleting) }) : t("items.deleteText", { title: deleting?.title })}</p>
      </Dialog>

      <Dialog open={deleteTemplate} onClose={() => setDeleteTemplate(false)} title={t("templates.deleteTitle")}
        footer={<><Button onClick={() => setDeleteTemplate(false)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void removeTemplate()}>{t("common.delete")}</Button></>}>
        <p className="m-0">{t("templates.deleteText", { title: savedTitle })}</p>
        {usedIn > 0 && <p className="mt-3 mb-0 font-semibold">{t("templates.usedWarning", { count: usedIn })}</p>}
      </Dialog>

      <Dialog open={refsOpen} onClose={() => setRefsOpen(false)} title={t("editor.addTemplate")}
        footer={<><Button onClick={() => setRefsOpen(false)}>{t("common.cancel")}</Button><Button variant="primary" disabled={refPick.length === 0} onClick={() => void addRefs()}>{t("editor.addSelected")}</Button></>}>
        <p className="hint mt-0">{t("editor.addTemplateText")}</p>
        <TemplatePicker enabled={refsOpen} selected={refPick} onChange={setRefPick} exclude={templateId ? [templateId] : []} />
      </Dialog>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} title={t("editor.export")} options={[
        { id: "json", label: "JSON", hint: t("editor.exportJsonHint"), run: () => download("json", undefined, "vorlage.json") },
        { id: "csv", label: "CSV", hint: t("editor.exportCsvHint"), run: () => download("csv", "semicolon", "vorlage.csv") },
      ]} />

      {leaveDialog}
    </>
  );
}

/** F-12 bis F-16: Vorlage bearbeiten – Punkte, Details, Tags, Export, Duplizieren, Löschen. */
export default function TemplateEditor() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const errorText = useErrorText();
  const detail = useQuery({ queryKey: ["template", id], queryFn: () => api.get<Detail>(`/templates/${id}`) });

  if (detail.isPending) return <Spinner />;
  if (detail.isError && !detail.data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <>
        <Alert kind="error">{notFound ? t("editor.notFound") : errorText(detail.error)}</Alert>
        <p><Link className="link" to="/templates">{t("editor.back")}</Link></p>
      </>
    );
  }
  return <DraftForm key={id} mode="edit" templateId={id} initial={fromTemplate(detail.data.template)} initialUsedIn={detail.data.template.usedInCount ?? 0} />;
}

/** Vorlage erstellen: Startwerte kommen aus dem Dialog der Vorlagenliste; ohne sie (z. B. nach Neuladen) zurück zur Liste. */
export function TemplateCreate() {
  const state = useLocation().state as { draft?: { title: string; tagIds: string[] } } | null;
  if (!state?.draft) return <Navigate to="/templates" replace />;
  return <DraftForm mode="create" initial={{ ...state.draft, items: [] }} />;
}
