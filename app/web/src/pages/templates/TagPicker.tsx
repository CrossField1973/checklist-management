import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Tag } from "../../api/types";
import { Alert, Button, useErrorText } from "../../components/ui";
import { TagChip } from "./TagChip";
import { useTags } from "./TagManager";

/** Tags für eine Vorlage wählen oder (sofort, unabhängig vom Entwurf) neu anlegen; die Farbe wählt der Server. */
export function TagPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const tags = useTags();
  const [newTag, setNewTag] = useState("");
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  async function addTag() {
    const name = newTag.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await api.post<{ tag: Tag }>("/tags", { name });
      await qc.invalidateQueries({ queryKey: ["tags"] });
      onChange([...value, res.tag.id]);
      setNewTag("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <fieldset className="m-0 mt-3 border-0 p-0">
      <legend className="label m-0 mb-1 p-0">{t("editor.tags")}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {tags.data?.map((tag) => (
          <button key={tag.id} type="button" aria-pressed={value.includes(tag.id)} onClick={() => toggle(tag.id)}
            className={`btn btn-sm ${value.includes(tag.id) ? "ring-2 ring-primary" : ""}`}>
            <TagChip tag={tag} /> <span aria-hidden="true">{value.includes(tag.id) ? "✓" : "+"}</span>
          </button>
        ))}
        {tags.data && tags.data.length === 0 && <span className="hint">{t("editor.noTags")}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className="input min-w-0 flex-1" aria-label={t("editor.newTag")} placeholder={t("editor.newTagPlaceholder")} maxLength={50} value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTag(); } }} />
        <Button disabled={!newTag.trim()} onClick={() => void addTag()}>{t("editor.addTag")}</Button>
      </div>
      <p className="hint mb-0 mt-1">{t("tags.newHint")}</p>
      {error && <div className="mt-2"><Alert kind="error">{error}</Alert></div>}
    </fieldset>
  );
}
