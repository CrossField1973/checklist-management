/** Dünner Client für die REST-API (gleiche Herkunft, Cookie-Sitzung). */

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(code);
    this.name = "ApiError";
  }
  /** Zusatzinfos des Servers, z. B. die Verstöße gegen die Passwort-Richtlinie */
  get problems(): string[] {
    return Array.isArray(this.body.problems) ? (this.body.problems as string[]) : [];
  }
  get retryAfterSeconds(): number | undefined {
    return typeof this.body.retryAfterSeconds === "number" ? this.body.retryAfterSeconds : undefined;
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* kein JSON */ }
  if (!res.ok) {
    const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, typeof obj.error === "string" ? obj.error : `http_${res.status}`, obj);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, headers?: Record<string, string>) => request<T>("GET", path, undefined, headers),
  post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => request<T>("POST", path, body, headers),
  put: <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>("PUT", path, body, headers),
  del: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>("DELETE", path, body, headers),
};

/** Lädt eine Datei vom Server herunter (z. B. Export) und speichert sie über den Browser. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/v1${path}`, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name ? decodeURIComponent(name) : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
