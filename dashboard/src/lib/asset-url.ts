// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Signed asset URLs for elements that cannot send a bearer token.
 *
 * `<img>`, `<video>`, `<audio>`, `<iframe>` and `<a download>` load
 * `/assets/<key>` without an `Authorization` header, so a remote viewer cannot
 * read a private asset that its session may read. `useAssetUrl(url)` asks the
 * server (`POST /api/assets/sign`, batched) for a short-lived URL signed for the
 * current session and re-signs it shortly before it expires. The server answers
 * public assets with the plain URL, so they keep their long-lived caching.
 *
 * Local viewers are unchanged: a loopback page, the desktop shell, a page with
 * no session and any URL that is not this server's `/assets/` path use the URL
 * as given.
 */

import { useEffect, useState } from "react";
import { authFetch, getToken } from "./api";
import { apiOrigin } from "./api-origin";

/** Re-sign this many ms before a signature expires. */
export const REFRESH_MARGIN_MS = 60_000;
/** Server cap on URLs per signing request (`MAX_SIGN_BATCH`). */
const BATCH = 100;

interface Entry {
  url: string;
  /** Unix seconds, or null when the URL needs no signature. */
  expiresAt: number | null;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
let queue: { path: string; token: string; resolve: (e: Entry) => void }[] = [];
let flushScheduled = false;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || h.startsWith("127.");
}

/**
 * This server's `/assets/<key>` path for `url`, when a signature could matter
 * for the current viewer; else undefined (use the URL as given).
 */
export function signablePath(
  url: string | undefined | null,
  location: Pick<Location, "protocol" | "origin" | "hostname"> = window.location,
  token: string | null = getToken(),
): string | undefined {
  if (!token || isLoopbackHost(location.hostname)) return undefined;
  // An already-signed URL passed back in is re-signed from its bare path.
  return ownAssetPath(url, location);
}

/** This server's `/assets/<key>` path for `url` (desktop shell excluded), else undefined. */
function ownAssetPath(
  url: string | undefined | null,
  location: Pick<Location, "protocol" | "origin">,
): string | undefined {
  if (!url || location.protocol === "views:") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url, apiOrigin(location));
  } catch {
    return undefined;
  }
  if (parsed.origin !== apiOrigin(location)) return undefined;
  if (!/^\/assets\/[^/]+$/.test(parsed.pathname)) return undefined;
  return parsed.pathname;
}

/**
 * The session bearer for a fetch of this server's own asset (e.g. pdf.js), or
 * no headers for any other URL — a token never goes to another origin.
 */
export function assetAuthHeaders(
  url: string | undefined | null,
  location: Pick<Location, "protocol" | "origin"> = window.location,
  token: string | null = getToken(),
): Record<string, string> {
  return token && ownAssetPath(url, location) ? { Authorization: `Bearer ${token}` } : {};
}

function fresh(entry: Entry | undefined, now = Date.now()): entry is Entry {
  if (!entry) return false;
  return entry.expiresAt === null || entry.expiresAt * 1000 - REFRESH_MARGIN_MS > now;
}

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += BATCH) {
    const chunk = batch.slice(i, i + BATCH);
    // A chunk is signed under one session token; mixed tokens (a login change
    // mid-flush) simply get their own request.
    const byToken = new Map<string, typeof chunk>();
    for (const item of chunk) {
      const list = byToken.get(item.token) ?? [];
      list.push(item);
      byToken.set(item.token, list);
    }
    await Promise.all(
      [...byToken.values()].map(async (items) => {
        let urls: Record<string, Entry> | undefined;
        try {
          const res = await authFetch(`${apiOrigin()}/api/assets/sign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: [...new Set(items.map((x) => x.path))] }),
          });
          if (res.ok) urls = ((await res.json()) as { urls?: Record<string, Entry> }).urls ?? {};
        } catch {
          // Network failure: fall back to the plain URL (today's behaviour).
        }
        for (const item of items) {
          const signed = urls?.[item.path];
          const entry: Entry = signed
            ? {
                url: signed.url.startsWith("/") ? `${apiOrigin()}${signed.url}` : signed.url,
                expiresAt: signed.expiresAt,
              }
            : urls
              ? // Omitted: not readable by this session — the plain URL reads the same.
                { url: item.path, expiresAt: null }
              : // The request failed: use the plain URL and retry in a while.
                { url: item.path, expiresAt: Math.floor(Date.now() / 1000) + 90 };
          const key = `${item.token}\n${item.path}`;
          cache.set(key, entry);
          inflight.delete(key);
          item.resolve(entry);
        }
      }),
    );
  }
}

function request(path: string, token: string): Promise<Entry> {
  const key = `${token}\n${path}`;
  const cached = cache.get(key);
  if (fresh(cached)) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = new Promise<Entry>((resolve) => {
    queue.push({ path, token, resolve });
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(() => void flush(), 0);
    }
  });
  inflight.set(key, promise);
  return promise;
}

/** The URL to load `url` with now (signing it when needed). */
export async function resolveAssetUrl(
  url: string,
  location: Pick<Location, "protocol" | "origin" | "hostname"> = window.location,
): Promise<string> {
  const path = signablePath(url, location);
  const token = getToken();
  if (!path || !token) return url;
  return (await request(path, token)).url;
}

/**
 * `url` as an element should load it. Returns `undefined` while a signature is
 * being fetched (render a placeholder rather than a request that would 404);
 * otherwise the plain or signed URL, kept fresh before it expires.
 */
export function useAssetUrl(
  url: string | undefined | null,
  location: Pick<Location, "protocol" | "origin" | "hostname"> = window.location,
): string | undefined {
  const path = signablePath(url, location);
  const token = getToken();
  const key = path && token ? `${token}\n${path}` : undefined;
  const [state, setState] = useState<{ key: string; entry: Entry } | undefined>(() => {
    const cached = key ? cache.get(key) : undefined;
    return key && fresh(cached) ? { key, entry: cached } : undefined;
  });
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` re-runs the effect to re-sign before expiry.
  useEffect(() => {
    if (!path || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forKey = `${token}\n${path}`;
    void request(path, token).then((next) => {
      if (cancelled) return;
      setState({ key: forKey, entry: next });
      if (next.expiresAt !== null) {
        const wait = Math.max(5_000, next.expiresAt * 1000 - REFRESH_MARGIN_MS - Date.now());
        timer = setTimeout(() => setGeneration((g) => g + 1), wait);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, token, generation]);

  if (!url) return undefined;
  if (!path || !token) return url;
  // While the first signature is in flight (or the state is for an older url),
  // render nothing rather than a doomed request. A signature being refreshed
  // stays in use until it actually expires.
  if (!state || state.key !== key || !fresh(state.entry, Date.now() - REFRESH_MARGIN_MS)) {
    return undefined;
  }
  return state.entry.url;
}

/** Drop every cached signature (tests; logout). */
export function clearAssetUrlCache(): void {
  cache.clear();
  inflight.clear();
  queue = [];
  flushScheduled = false;
}
