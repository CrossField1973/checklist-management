import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, downloadFile } from "../../api/client";
import type { ImportIssue, ImportPreview, ImportResult } from "../../api/types";
import { Alert, Button, Card, Select, TextArea, TextInput, useErrorText } from "../../components/ui";

type Format = "json" | "csv";

/** F-50, F-51: Export aller Vorlagen und Import von Vorlagen mit Vorschau (Checklisten werden nicht importiert). */
export function DataSection() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [exportError, setExportError] = useState<string | null>(null);

  const [format, setFormat] = useState<Format>("json");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async (path: string, name: string) => {
    setExportError(null);
    try { await downloadFile(path, name); } catch (err) { setExportError(errorText(err)); }
  };

  const reset = () => { setPreview(null); setIssues([]); setResult(null); setError(null); };

  async function readFile(file: File | undefined) {
    if (!file) return;
    reset();
    setContent(await file.text());
    setFormat(file.name.toLowerCase().endsWith(".csv") ? "csv" : "json");
  }

  const body = (dryRun: boolean) => ({ format, content, dryRun, templatesOnly: true, ...(format === "csv" && title.trim() ? { title: title.trim() } : {}) });

  async function check() {
    reset();
    setBusy(true);
    try {
      const res = await api.post<ImportPreview>("/import", body(true));
      setPreview(res);
      setIssues(res.issues);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ result: ImportResult }>("/import", body(false));
      setResult(res.result);
      setPreview(null);
      setContent("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "import_invalid") setIssues((err.body.issues as ImportIssue[]) ?? []);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("profile.data.title")} description={t("profile.data.description")}>
      <h3 className="m-0 text-base font-semibold">{t("profile.data.exportTitle")}</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button onClick={() => void download("/export?scope=templates", "vorlagen.json")}>{t("profile.data.exportAll")}</Button>
      </div>
      <p className="hint mb-0">{t("profile.data.exportHint")}</p>
      {exportError && <div className="mt-3"><Alert kind="error">{exportError}</Alert></div>}

      <h3 className="mt-6 mb-0 text-base font-semibold">{t("profile.data.importTitle")}</h3>
      <p className="hint mt-1">{t("profile.data.importHint")}</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="import-file">{t("profile.data.file")}</label>
          <input id="import-file" className="input" type="file" accept=".json,.csv,application/json,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
        </div>
        <Select label={t("profile.data.format")} value={format} onChange={(e) => { setFormat(e.target.value as Format); reset(); }}>
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </Select>
      </div>
      {format === "csv" && <TextInput label={t("profile.data.csvTitle")} hint={t("profile.data.csvTitleHint")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}
      <TextArea label={t("profile.data.content")} rows={6} className="input mono" value={content} onChange={(e) => { setContent(e.target.value); reset(); }} spellCheck={false} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void check()} disabled={busy || !content.trim()}>{t("profile.data.check")}</Button>
        {preview?.valid && <Button variant="primary" onClick={() => void doImport()} disabled={busy}>{t("profile.data.runImport")}</Button>}
      </div>

      {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
      {issues.length > 0 && (
        <div className="mt-3">
          <Alert kind="error">
            <p className="m-0 font-semibold">{t("profile.data.issues", { count: issues.length })}</p>
            <ul className="mt-1 mb-0 pl-5">{issues.slice(0, 50).map((i, n) => <li key={n}>{i.path ? <><span className="mono">{i.path}</span>: </> : null}{i.message}</li>)}</ul>
            {issues.length > 50 && <p className="m-0 mt-1">{t("profile.data.moreIssues", { count: issues.length - 50 })}</p>}
          </Alert>
        </div>
      )}
      {preview?.valid && preview.counts && preview.preview && (
        <div className="mt-3">
          <Alert kind="ok">
            <p className="m-0 font-semibold">{t("profile.data.previewOk", { templates: preview.counts.templates, items: preview.counts.items })}</p>
            <ul className="mt-1 mb-0 pl-5">
              {preview.preview.templates.map((tpl, i) => <li key={`t${i}`}>{t("profile.data.previewTemplate", { title: tpl.title, count: tpl.itemCount })}</li>)}
            </ul>
            {preview.preview.tags.new.length > 0 && <p className="m-0 mt-1">{t("profile.data.newTags", { tags: preview.preview.tags.new.join(", ") })}</p>}
            {preview.warnings.map((w) => <p key={w} className="m-0 mt-1">{w}</p>)}
            <p className="m-0 mt-1">{t("profile.data.alwaysNew")}</p>
          </Alert>
        </div>
      )}
      {result && <div className="mt-3"><Alert kind="ok">{t("profile.data.imported", { templates: result.templates, items: result.items })}</Alert></div>}
    </Card>
  );
}
