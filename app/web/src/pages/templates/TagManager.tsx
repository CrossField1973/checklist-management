import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Tag } from "../../api/types";
import { ColorPicker } from "../../components/ColorPicker";
import { TrashIcon } from "../../components/icons";
import { Alert, Button, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";

export const useTags = () => useQuery({ queryKey: ["tags"], queryFn: async () => (await api.get<{ tags: Tag[] }>("/tags")).tags });

/** Ein Tag in der Verwaltung: Farbe wählen, umbenennen, löschen (Rückfrage nennt die Zahl betroffener Vorlagen). */
function TagRow({ tag, onChanged, onError, onAskDelete }: { tag: Tag; onChanged: () => void; onError: (e: unknown) => void; onAskDelete: (tag: Tag) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(tag.name);

  const save = async (patch: { name?: string; color?: string }) => {
    try { await api.put(`/tags/${tag.id}`, patch); onChanged(); } catch (err) { onError(err); setName(tag.name); }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <ColorPicker label={t("tags.colorOf", { name: tag.name })} value={tag.color} onChange={(color) => void save({ color })} />
      <input
        className="input min-w-0 flex-1" aria-label={t("tags.nameOf", { name: tag.name })} value={name} maxLength={50}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== tag.name && void save({ name: name.trim() })}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
      <Button size="sm" variant="danger" onClick={() => onAskDelete(tag)} aria-label={t("tags.delete", { name: tag.name })} title={t("common.delete")}><TrashIcon /></Button>
    </li>
  );
}

/** F-17/F-18: Tags verwalten (Profil → Tags). Neue Tags erhalten automatisch eine gut unterscheidbare Farbe (änderbar). */
export function TagManager() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const tags = useTags();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<Tag | null>(null);

  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ["tags"] });
    void qc.invalidateQueries({ queryKey: ["templates"] }); // Tag-Namen/-Farben erscheinen in der Liste
    void qc.invalidateQueries({ queryKey: ["template"] });
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/tags", { name: name.trim() });
      setName("");
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function confirmDelete() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await api.del(`/tags/${toDelete.id}`);
      setToDelete(null);
      refresh();
    } catch (err) {
      setError(errorText(err));
      setToDelete(null);
    } finally {
      setBusy(false);
    }
  }

  const used = toDelete?.templateCount ?? 0;
  return (
    <>
      {tags.isPending ? <Spinner /> : tags.data && tags.data.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {tags.data.map((tag) => <TagRow key={`${tag.id}-${tag.name}-${tag.color}`} tag={tag} onChanged={refresh} onError={(e) => setError(errorText(e))} onAskDelete={setToDelete} />)}
        </ul>
      ) : <p className="hint mt-0">{t("tags.empty")}</p>}
      <form onSubmit={create} className="mt-4 border-t border-border pt-3" noValidate>
        <TextInput label={t("tags.newName")} hint={t("tags.newHint")} value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" className="mt-2" disabled={busy || !name.trim()}>{t("tags.create")}</Button>
      </form>
      {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}

      <Dialog open={toDelete !== null} onClose={() => setToDelete(null)} title={t("tags.deleteTitle", { name: toDelete?.name })}
        footer={<><Button onClick={() => setToDelete(null)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>{t("common.delete")}</Button></>}>
        <p className="m-0">{used > 0 ? t("tags.deleteText", { count: used }) : t("tags.deleteUnused")}</p>
      </Dialog>
    </>
  );
}
