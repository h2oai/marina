// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const BASE = import.meta.env.MODE === "development" ? "" : "";

const TOKEN_KEY = "marina_chat_token";
const LEGACY_TOKEN_KEY = "marina_dashboard_token";

// One-time migration: older dashboards wrote to a separate key. Promote the
// legacy value to the unified key so users don't get logged out on upgrade.
try {
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy && !localStorage.getItem(TOKEN_KEY)) {
    localStorage.setItem(TOKEN_KEY, legacy);
  }
  if (legacy) localStorage.removeItem(LEGACY_TOKEN_KEY);
} catch {
  /* localStorage disabled — non-fatal */
}

/** Get the current session token. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Store the session token. */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Clear the session token locally. Use `logout()` to also revoke server-side. */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

/**
 * Revoke the current session on the server, then clear it locally.
 * Callers should also reset in-memory chat state (loggedIn=false, entityName=null).
 */
export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${BASE}/api/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* network down — still clear locally so the user isn't stuck */
    }
  }
  clearToken();
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/** Download an authenticated API response without placing session tokens in URLs. */
export async function downloadApi(path: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const disposition = res.headers.get("content-disposition");
  const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Turn a thrown API error into a human-readable message. `fetchApi`/`postApi`
 * throw `Error("API error: <status>")`; a 401 means the dashboard has no valid
 * session — the most common reason admin saves/lists silently failed.
 */
export function describeApiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("401")) {
    return "Not authorized — log in (chat panel) as an admin to manage this.";
  }
  return msg.startsWith("API error:") ? `Request failed (${msg.slice(11).trim()}).` : msg;
}

export async function postApi<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function deleteApi(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE", headers: authHeaders() });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function putApi<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function patchApi<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/**
 * Drop-in replacement for `fetch()` that attaches the Bearer token.
 * Used by canvas code and anywhere that needs raw fetch with auth.
 */
export function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init?.headers as Record<string, string>),
  };
  return fetch(url, { ...init, headers });
}
