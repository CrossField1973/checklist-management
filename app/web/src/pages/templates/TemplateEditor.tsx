import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, downloadFile } from "../../api/client";
import type { Tag, TemplateDetail } from "../../api/types";
import { Alert, Button, Card, Dialog, Spinner, TextArea, TextInput, useErrorText } from "../../components/ui";
import { countNodes, moveInTree, type ItemNode, type MoveTarget } from "../../lib/tree";
import { ItemTree } from "./ItemTree";
import { TagChip } from "./TagChip";
import { TagsDialog, useTags } from "./TagsDialog";

type Detail = { template: TemplateDetail };

/** Titel, Beschreibung und Tags der Vorlage (F-12, F-17). Eigener Zustand, wird erst mit „Speichern“ übernommen. */
function MetaForm({ template, onSaved, onOpenTags }: { template: TemplateDetail; onSaved: (t: TemplateDetail) => void; onOpenTags: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const tags = useTags();
  const [title, setTitle] = useState(template.title);
  const [description, setDescription] = useState(template.description ?? "");
  const [tagIds, setTagIds] = useState<string[]>(template.tags.map((x) => x.id));
  const [newTag, setNewTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const original = template.tags.map((x) => x.id).sort().join(",");
  const dirty = title !== template.title || description !== (template.description ?? "") || [...tagIds].sort().join(",") !== original;
  const toggle = (id: string) => { setSaved(false); setTagIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])); };

  async function addTag() {
    const name = newTag.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await api.post<{ tag: Tag }>("/tags", { name }); // Farbe wählt der Server automatisch
      await qc.invalidateQueries({ queryKey: ["tags"] });
      setTagIds((cur) => [...cur, res.tag.id]);
      setNewTag("");
      setSaved(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.put<Detail>(`/templates/${template.id}`, { title: title.trim(), description: description.trim() ? description : null, tagIds });
      onSaved(res.template);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["tags"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("editor.details")}>
      <form onSubmit={save} noValidate>
        <TextInput label={t("templates.titleLabel")} required maxLength={200} value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} />
        <TextArea label={t("editor.description")} rows={3} maxLength={5000} value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} />

        <fieldset className="m-0 mt-3 border-0 p-0">
          <legend className="label m-0 mb-1 p-0">{t("editor.tags")}</legend>
          <div className="flex flex-wrap items-center gap-2">
            {tags.data?.map((tag) => (
              <button key={tag.id} type="button" aria-pressed={tagIds.includes(tag.id)} onClick={() => toggle(tag.id)}
                className={`btn btn-sm ${tagIds.includes(tag.id) ? "ring-2 ring-primary" : ""}`}>
                <TagChip tag={tag} /> <span aria-hidden="true">{tagIds.includes(tag.id) ? "✓" : "+"}</span>
              </button>
            ))}
            {tags.data && tags.data.length === 0 && <span className="hint">{t("editor.noTags")}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1" aria-label={t("editor.newTag")} placeholder={t("editor.newTagPlaceholder")} maxLength={50} value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTag(); } }} />
            <Button disabled={!newTag.trim()} onClick={() => void addTag()}>{t("editor.addTag")}</Button>
            <Button onClick={onOpenTags}>{t("templates.manageTags")}</Button>
          </div>
          <p className="hint mb-0 mt-1">{t("tags.newHint")}</p>
        </fieldset>

        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
        {saved && !dirty && <div className="mt-3"><Alert kind="ok">{t("common.saved")}</Alert></div>}
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || !dirty || !title.trim()}>{t("common.save")}</Button>
          {dirty && <span className="hint">{t("editor.unsaved")}</span>}
        </div>
      </form>
    </Card>
  );
}

/** F-12 bis F-16: Vorlage bearbeiten – Details, Tags, Punkte mit Unterpunkten und Drag-and-Drop, Export, Duplizieren, Löschen. */
export default function TemplateEditor() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const key = ["template", id];
  const detail = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/templates/${id}`) });

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ItemNode | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [deleting, setDeleting] = useState<ItemNode | null>(null);
  const [deleteTemplate, setDeleteTemplate] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const notice = (location.state as { notice?: string } | null)?.notice;

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
  const template = detail.data.template;
  const items = template.items;

  /** Hält den Zwischenspeicher aktuell (Baum und Zähler), ohne neu zu laden. */
  const setItems = (next: ItemNode[]): void => {
    qc.setQueryData<Detail>(key, (old) => (old ? { template: { ...old.template, items: next, itemCount: countNodes(next) } } : old));
  };
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(errorText(err)); void qc.invalidateQueries({ queryKey: key }); }
  };

  const addItem = (title: string, parentId: string | null) =>
    run(async () => setItems((await api.post<{ items: ItemNode[] }>(`/templates/${id}/items`, { title, ...(parentId ? { parentItemId: parentId } : {}) })).items));

  const moveItem = (itemId: string, target: MoveTarget) =>
    run(async () => {
      const optimistic = moveInTree(items, itemId, target.parentItemId, target.position);
      if (optimistic) setItems(optimistic); // sofortige Rückmeldung; die Antwort des Servers ersetzt sie
      setItems((await api.post<{ items: ItemNode[] }>(`/template-items/${itemId}/move`, target)).items);
    });

  function openEdit(node: ItemNode) { setEditing(node); setEditTitle(node.title); setEditDescription(node.description ?? ""); setError(null); }
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    await run(async () => {
      setItems((await api.put<{ items: ItemNode[] }>(`/template-items/${editing.id}`, { title: editTitle.trim(), description: editDescription.trim() ? editDescription : null })).items);
      setEditing(null);
    });
    setBusy(false);
  }
  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    await run(async () => {
      setItems((await api.del<{ items: ItemNode[] }>(`/template-items/${deleting.id}`)).items);
      setDeleting(null);
    });
    setBusy(false);
  }

  async function duplicate() {
    await run(async () => {
      const res = await api.post<Detail>(`/templates/${id}/duplicate`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      navigate(`/templates/${res.template.id}`, { state: { notice: t("templates.duplicated") } });
    });
  }
  async function removeTemplate() {
    setBusy(true);
    await run(async () => {
      await api.del(`/templates/${id}`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      qc.removeQueries({ queryKey: key });
      navigate("/templates", { replace: true, state: { notice: t("templates.deleted", { title: template.title }) } });
    });
    setBusy(false);
  }
  const download = (format: string, delimiter?: string, name = "export") =>
    downloadFile(`/templates/${id}/export?format=${format}${delimiter ? `&delimiter=${delimiter}` : ""}`, name).catch((err) => setError(errorText(err)));

  const childCount = (n: ItemNode) => countNodes(n.children);

  return (
    <>
      <p className="mt-0"><Link className="link" to="/templates">← {t("editor.back")}</Link></p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 break-words text-2xl font-semibold">{template.title}</h1>
        <Button onClick={() => void duplicate()}>{t("templates.duplicate")}</Button>
        <Button variant="danger" onClick={() => setDeleteTemplate(true)}>{t("common.delete")}</Button>
      </div>

      {notice && <div className="mb-3"><Alert kind="ok">{notice}</Alert></div>}
      {error && <div className="mb-3"><Alert kind="error">{error}</Alert></div>}

      <div className="grid gap-4">
        <MetaForm key={template.id} template={template} onOpenTags={() => setTagsOpen(true)}
          onSaved={(saved) => { qc.setQueryData<Detail>(key, { template: saved }); void qc.invalidateQueries({ queryKey: ["templates"] }); }} />

        <Card title={t("editor.items")} description={t("editor.itemsHint", { count: countNodes(items) })}>
          <ItemTree items={items} onAdd={addItem} onEdit={openEdit} onDelete={(n) => setDeleting(n)} onMove={moveItem} />
        </Card>

        <Card title={t("editor.export")} description={t("editor.exportHint")}>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("editor.export")}>
            <Button size="sm" onClick={() => void download("json", undefined, "vorlage.json")}>JSON</Button>
            <Button size="sm" onClick={() => void download("csv", "comma", "vorlage.csv")}>CSV</Button>
            <Button size="sm" onClick={() => void download("csv", "semicolon", "vorlage.csv")}>{t("editor.csvExcel")}</Button>
            <Button size="sm" onClick={() => void download("md", undefined, "vorlage.md")}>Markdown</Button>
          </div>
        </Card>
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t("items.editTitle")}>
        <form onSubmit={saveEdit} noValidate>
          <TextInput label={t("items.titleLabel")} required autoFocus maxLength={200} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          <TextArea label={t("editor.description")} rows={4} maxLength={5000} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
          {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={busy || !editTitle.trim()}>{t("common.save")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title={t("items.deleteTitle")}
        footer={<><Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>{t("common.delete")}</Button></>}>
        <p className="m-0">{deleting && childCount(deleting) > 0 ? t("items.deleteWithChildren", { title: deleting.title, count: childCount(deleting) }) : t("items.deleteText", { title: deleting?.title })}</p>
      </Dialog>

      <Dialog open={deleteTemplate} onClose={() => setDeleteTemplate(false)} title={t("templates.deleteTitle")}
        footer={<><Button onClick={() => setDeleteTemplate(false)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void removeTemplate()}>{t("common.delete")}</Button></>}>
        <p className="m-0">{t("templates.deleteText", { title: template.title })}</p>
      </Dialog>

      <TagsDialog open={tagsOpen} onClose={() => setTagsOpen(false)} />
    </>
  );
}
