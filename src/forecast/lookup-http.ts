// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One SSRF-guarded, timeout-bounded GET for forecast lookups. Errors never
 * carry the URL, because some lookups pass their key as a query parameter.
 */

import { CONNECTOR_HTTP_TIMEOUT_MS } from "../engine/constants";
import { guardedFetch, validateFetchUrl } from "../net/url-guard";

export type HttpResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LookupFetch {
  json<T>(url: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<HttpResult<T>>;
  text(url: string): Promise<HttpResult<string>>;
}

async function request(
  url: string,
  label: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<HttpResult<Response>> {
  const urlErr = await validateFetchUrl(url);
  if (urlErr) return { ok: false, error: `${label} endpoint rejected` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTOR_HTTP_TIMEOUT_MS);
  try {
    const res = await guardedFetch(url, {
      method: init.method ?? "GET",
      signal: controller.signal,
      ...(init.body !== undefined
        ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      return { ok: false, error: `${label} HTTP ${res.status}` };
    }
    return { ok: true, value: res };
  } catch (err) {
    return {
      ok: false,
      error:
        (err as Error).name === "AbortError" ? `${label} timed out` : `${label} request failed`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The default fetcher: real network, labelled errors without URLs. */
export function lookupFetch(label: string): LookupFetch {
  return {
    async json<T>(url: string, init?: { method?: "GET" | "POST"; body?: unknown }) {
      const r = await request(url, label, init);
      if (!r.ok) return r;
      try {
        return { ok: true, value: (await r.value.json()) as T };
      } catch {
        return { ok: false, error: `${label} returned invalid JSON` };
      }
    },
    async text(url: string) {
      const r = await request(url, label);
      if (!r.ok) return r;
      return { ok: true, value: await r.value.text() };
    },
  };
}
