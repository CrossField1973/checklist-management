import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ApiTokenInfo } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, Button, Card, Dialog, Select, Spinner, TextInput, useErrorText } from "../../components/ui";
import { useCopy } from "../../lib/clipboard";

/** Letzter Moment des gewählten Tages (lokale Zeit) als ISO-Zeitpunkt, damit der Token den ganzen Tag gilt. */
const endOfDayIso = (date: string) => new Date(`${date}T23:59:59`).toISOString();

/** F-61: API-Token anlegen (Klartext nur einmal), auflisten, widerrufen – plus Hinweis zur MCP-Anbindung. */
export function TokensSection() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { config } = useAuth();
  const list = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<{ tokens: ApiTokenInfo[] }>("/me/tokens") });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [expires, setExpires] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiTokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tokenCopy = useCopy();
  const mcpCopy = useCopy();
  const fmt = (ms: number | null) => (ms === null ? t("profile.tokens.never") : new Date(ms).toLocaleDateString(i18n.language));

  const closeCreate = () => { setCreating(false); setCreated(null); setName(""); setPermission("read"); setExpires(""); setError(null); };
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ token: string }>("/me/tokens", { name, permission, ...(expires ? { expiresAt: endOfDayIso(expires) } : {}) });
      setCreated(res.token);
      await qc.invalidateQueries({ queryKey: ["tokens"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function doRevoke() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.del(`/me/tokens/${revoke.id}`);
      await qc.invalidateQueries({ queryKey: ["tokens"] });
      setRevoke(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const mcpUrl = config?.mcpUrl ?? `${location.origin}/mcp`;
  const mcpSnippet = JSON.stringify({ mcpServers: { checklisten: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ck_IHR_TOKEN" } } } }, null, 2);

  return (
    <Card title={t("profile.tokens.title")} description={t("profile.tokens.description")}>
      {list.isPending ? <Spinner /> : list.data && list.data.tokens.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {list.data.tokens.map((tok) => (
            <li key={tok.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="m-0 font-semibold">{tok.name} <span className="badge">{tok.permission === "write" ? t("profile.tokens.write") : t("profile.tokens.read")}</span> {tok.expired && <span className="badge text-danger">{t("profile.tokens.expired")}</span>}</p>
                <p className="hint m-0"><span className="mono">{tok.prefix}…</span> · {t("profile.tokens.expires")}: {fmt(tok.expiresAt)} · {t("profile.tokens.lastUsed")}: {tok.lastUsedAt ? fmt(tok.lastUsedAt) : t("profile.tokens.neverUsed")}</p>
              </div>
              <Button size="sm" variant="danger" onClick={() => setRevoke(tok)} aria-label={t("profile.tokens.revokeFor", { name: tok.name })}>{t("profile.tokens.revoke")}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="hint m-0">{t("profile.tokens.empty")}</p>}
      <div className="mt-3"><Button onClick={() => setCreating(true)}>{t("profile.tokens.create")}</Button></div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">{t("profile.tokens.mcpTitle")}</summary>
        <p className="hint">{t("profile.tokens.mcpText")}</p>
        <p className="code-box mono my-2" data-testid="mcp-url">{mcpUrl}</p>
        <pre className="code-box mono overflow-x-auto text-xs">{mcpSnippet}</pre>
        <Button size="sm" onClick={() => void mcpCopy.copy(mcpSnippet)}>{mcpCopy.copied ? t("common.copied") : t("profile.tokens.copyConfig")}</Button>
      </details>

      <Dialog open={creating} onClose={closeCreate} title={t("profile.tokens.createTitle")}>
        {created ? (
          <>
            <Alert kind="info">{t("profile.tokens.createdWarning")}</Alert>
            <p className="code-box mono my-3" data-testid="new-token">{created}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => void tokenCopy.copy(created)}>{tokenCopy.copied ? t("common.copied") : t("common.copy")}</Button>
              <Button variant="primary" onClick={closeCreate}>{t("common.done")}</Button>
            </div>
          </>
        ) : (
          <form onSubmit={create} noValidate>
            <TextInput label={t("profile.tokens.name")} required autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <Select label={t("profile.tokens.permission")} hint={permission === "write" ? t("profile.tokens.writeHint") : t("profile.tokens.readHint")} value={permission} onChange={(e) => setPermission(e.target.value as "read" | "write")}>
              <option value="read">{t("profile.tokens.read")}</option>
              <option value="write">{t("profile.tokens.write")}</option>
            </Select>
            <TextInput label={t("profile.tokens.expiry")} hint={t("profile.tokens.expiryHint")} type="date" min={new Date().toISOString().slice(0, 10)} value={expires} onChange={(e) => setExpires(e.target.value)} />
            {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={closeCreate}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t("profile.tokens.createSubmit")}</Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={revoke !== null} onClose={() => setRevoke(null)} title={t("profile.tokens.revokeTitle")} footer={<><Button onClick={() => setRevoke(null)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void doRevoke()}>{t("profile.tokens.revoke")}</Button></>}>
        <p className="m-0">{t("profile.tokens.revokeText", { name: revoke?.name })}</p>
        {error && <div className="mt-3"><Alert kind="error">{error}</Alert></div>}
      </Dialog>
    </Card>
  );
}
