import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Tag } from "../../api/types";
import { Alert, Button, Dialog, Spinner, TextInput, useErrorText } from "../../components/ui";
import { TagChip } from "./TagChip";

export const useTags = () => useQuery({ queryKey: ["tags"], queryFn: async () => (await api.get<{ tags: Tag[] }>("/tags")).tags });

/** Ein Tag in der Verwaltung: Farbe wählen, umbenennen, löschen (mit Rückfrage). */
function TagRow({ tag, onChanged, onError }: { tag: Tag; onChanged: () => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [confirm, setConfirm] = useState(false);

  const save = async (patch: { name?: string; color?: string }) => {
    try { await api.put(`/tags/${tag.id}`, patch); onChanged(); } catch (err) { onError(err); setName(tag.name); setColor(tag.color); }
  };
  const del = async () => {
    try { await api.del(`/tags/${tag.id}`); onChanged(); } catch (err) { onError(err); }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <input
        type="color" aria-label={t("tags.colorOf", { name: tag.name })} value={color}
        onChange={(e) => setColor(e.target.value)}
        onBlur={() => color !== tag.color && void save({ color })}
        className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
      />
      <input
        className="input min-w-0 flex-1" aria-label={t("tags.nameOf", { name: tag.name })} value={name} maxLength={50}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== tag.name && void save({ name: name.trim() })}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
      <span className="hint">{t("tags.usedBy", { count: tag.templateCount ?? 0 })}</span>
      {confirm ? (
        <span className="flex items-center gap-1" role="group" aria-label={t("tags.confirmDelete", { name: tag.name })}>
          <span className="text-sm">{t("tags.confirmDelete", { name: tag.name })}</span>
          <Button size="sm" variant="danger" onClick={() => void del()}>{t("common.delete")}</Button>
          <Button size="sm" onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
        </span>
      ) : (
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)} aria-label={t("tags.delete", { name: tag.name })}>{t("common.delete")}</Button>
      )}
    </li>
  );
}

/** F-17/F-18: Tags verwalten. Neue Tags erhalten automatisch eine gut unterscheidbare Farbe (änderbar). */
export function TagsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const tags = useTags();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <Dialog open={open} onClose={onClose} title={t("tags.title")} footer={<Button variant="primary" onClick={onClose}>{t("common.done")}</Button>}>
      <p className="hint mt-0">{t("tags.intro")}</p>
      {tags.isPending ? <Spinner /> : tags.data && tags.data.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {tags.data.map((tag) => <TagRow key={`${tag.id}-${tag.name}-${tag.color}`} tag={tag} onChanged={refresh} onError={(e) => setError(errorText(e))} />)}
        </ul>
      ) : <p className="hint">{t("tags.empty")}</p>}
      {tags.data && tags.data.length > 0 && <p className="hint mb-0">{tags.data.map((tag) => <span key={tag.id} className="mr-1 inline-block"><TagChip tag={tag} /></span>)}</p>}
      <form onSubmit={create} className="mt-4 border-t border-border pt-3" noValidate>
        <TextInput label={t("tags.newName")} hint={t("tags.newHint")} value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" className="mt-2" disabled={busy || !name.trim()}>{t("tags.create")}</Button>
      </form>
      {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
    </Dialog>
  );
}
