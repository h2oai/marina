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

/** A body that could not be parsed, as opposed to a transport failure. */
class BodyParseError extends Error {}

/**
 * Request `url` and read its body with `read`, all under one deadline: the
 * timer covers the headers AND the body, so a server that answers and then
 * stalls the body is still cut off.
 */
async function request<T>(
  url: string,
  label: string,
  init: { method?: "GET" | "POST"; body?: unknown },
  read: (res: Response) => Promise<T>,
): Promise<HttpResult<T>> {
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
      // allow-empty-catch: draining an error body; the status is reported regardless
      await res.text().catch(() => "");
      return { ok: false, error: `${label} HTTP ${res.status}` };
    }
    return { ok: true, value: await read(res) };
  } catch (err) {
    if (err instanceof BodyParseError)
      return { ok: false, error: `${label} returned invalid JSON` };
    return {
      ok: false,
      error:
        (err as Error).name === "AbortError" ? `${label} timed out` : `${label} request failed`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BodyParseError();
  }
}

/** The default fetcher: real network, labelled errors without URLs. */
export function lookupFetch(label: string): LookupFetch {
  return {
    json<T>(url: string, init?: { method?: "GET" | "POST"; body?: unknown }) {
      return request<T>(url, label, init ?? {}, readJson<T>);
    },
    text(url: string) {
      return request(url, label, {}, (res) => res.text());
    },
  };
}
