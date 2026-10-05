// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research provenance cache: every page a research run read, kept on disk as it
 * was at the moment it was read. A cited answer can then be audited against
 * exactly what its author saw — the text behind each citation, when it was
 * fetched, the HTTP status and a hash of the bytes — and exported to whatever
 * layout an evaluator expects (`benchmarks/mind2web2/cache-export.ts`).
 *
 * Layout under `dir`:
 *   index.json           { version, pages: { <key>: PageRecord } }
 *   pages/<key>.txt      the extracted text the reader saw
 *   pages/<key>.pdf      the raw bytes of a PDF
 *   pages/<key>.body     the raw body of any other page (up to RAW_BODY_MAX_BYTES)
 *   pages/<key>.jpg      a screenshot, when a browser rendered the page
 *
 * `key` is the sha256 (first 32 hex chars) of the canonical URL
 * (`canonicalUrl`): fragment dropped, tracking parameters removed, one
 * trailing slash dropped. A later read of the same URL replaces the earlier
 * one (the record keeps `reads`, the number of reads).
 *
 * Failed reads are recorded too (status / error, no text), so an audit can
 * tell "never opened" from "opened and blocked".
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PageKind = "web" | "pdf";

export interface PageRecord {
  /** The URL as the reader asked for it. */
  url: string;
  /** Canonical form used for the key and for lookups. */
  canonical: string;
  kind: PageKind;
  /** HTTP status of the final response (0 when the request failed). */
  status: number;
  contentType?: string;
  /** ISO time of the (latest) read. */
  fetchedAt: string;
  /** sha256 of the response body bytes (absent on failure). */
  sha256?: string;
  bytes?: number;
  title?: string;
  /** Characters of extracted text kept in `pages/<key>.txt`. */
  textChars: number;
  /** Why the read failed (network error, refused by policy, HTTP error). */
  error?: string;
  /** How many times the URL was read in this cache's lifetime. */
  reads: number;
  /** How the page was read: a plain fetch, or a rendered (browser) read. */
  via?: "fetch" | "browser";
  /** A screenshot of the first screen is kept (`pages/<key>.jpg`). */
  screenshot?: boolean;
}

/** What a reader hands the cache after one read. */
export interface PageCapture {
  url: string;
  status: number;
  contentType?: string;
  body?: Uint8Array;
  text?: string;
  title?: string;
  error?: string;
  fetchedAt?: Date;
  via?: "fetch" | "browser";
  /** JPEG of the rendered page, when a browser read it. */
  screenshot?: Uint8Array;
}

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

/**
 * The URL a page is filed under: fragment dropped, tracking parameters
 * (`utm_*`, `fbclid`, `gclid`, …) removed, host lower-cased, one trailing slash
 * dropped. Returns the input trimmed when it does not parse.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.hash = "";
  for (const name of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) u.searchParams.delete(name);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  let out = u.toString();
  if (u.search === "" && out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

export function pageKey(url: string): string {
  return createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 32);
}

const INDEX_VERSION = 1;
/** Raw bodies of non-PDF pages are kept up to this size (the text is always kept). */
export const RAW_BODY_MAX_BYTES = 4 * 1024 * 1024;

export class ProvenanceCache {
  readonly dir: string;
  private readonly pages = new Map<string, PageRecord>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "pages"), { recursive: true });
    const index = join(dir, "index.json");
    if (existsSync(index)) {
      const parsed = JSON.parse(readFileSync(index, "utf8")) as {
        version?: number;
        pages?: Record<string, PageRecord>;
      };
      for (const [k, v] of Object.entries(parsed.pages ?? {})) this.pages.set(k, v);
    }
  }

  /** File one read. Returns the stored record. */
  record(capture: PageCapture): PageRecord {
    const key = pageKey(capture.url);
    const prior = this.pages.get(key);
    const kind: PageKind = isPdf(capture.contentType, capture.body) ? "pdf" : "web";
    const ok = !capture.error && capture.status >= 200 && capture.status < 300;
    // A failed re-read never replaces a good earlier read: the citation still
    // points at what the reader saw then.
    if (!ok && prior && !prior.error && prior.status >= 200 && prior.status < 300) {
      prior.reads++;
      this.save();
      return prior;
    }
    const text = capture.text ?? "";
    const rec: PageRecord = {
      url: capture.url,
      canonical: canonicalUrl(capture.url),
      kind,
      status: capture.status,
      ...(capture.contentType ? { contentType: capture.contentType } : {}),
      fetchedAt: (capture.fetchedAt ?? new Date()).toISOString(),
      ...(capture.body
        ? {
            sha256: createHash("sha256").update(capture.body).digest("hex"),
            bytes: capture.body.byteLength,
          }
        : {}),
      ...(capture.title ? { title: capture.title } : {}),
      textChars: text.length,
      ...(capture.error ? { error: capture.error } : {}),
      reads: (prior?.reads ?? 0) + 1,
      ...(capture.via ? { via: capture.via } : {}),
      ...(capture.screenshot && ok ? { screenshot: true } : {}),
    };
    writeFileSync(join(this.dir, "pages", `${key}.txt`), text);
    if (kind === "pdf" && capture.body && ok) {
      writeFileSync(join(this.dir, "pages", `${key}.pdf`), capture.body);
    } else if (capture.body && ok && capture.body.byteLength <= RAW_BODY_MAX_BYTES) {
      writeFileSync(join(this.dir, "pages", `${key}.body`), capture.body);
    }
    if (capture.screenshot && ok)
      writeFileSync(join(this.dir, "pages", `${key}.jpg`), capture.screenshot);
    this.pages.set(key, rec);
    this.save();
    return rec;
  }

  /** The record for a URL (any spelling with the same canonical form). */
  get(url: string): PageRecord | undefined {
    return this.pages.get(pageKey(url));
  }

  /** True when the URL was read successfully. */
  readOk(url: string): boolean {
    const r = this.get(url);
    return Boolean(r && !r.error && r.status >= 200 && r.status < 300);
  }

  /** The extracted text the reader saw, or undefined. */
  text(url: string): string | undefined {
    const r = this.get(url);
    if (!r) return undefined;
    const p = join(this.dir, "pages", `${pageKey(url)}.txt`);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  /** The raw response body of a non-PDF page (kept up to `RAW_BODY_MAX_BYTES`). */
  body(url: string): Uint8Array | undefined {
    const p = join(this.dir, "pages", `${pageKey(url)}.body`);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  /** The screenshot of a rendered read, when one was taken. */
  screenshot(url: string): Uint8Array | undefined {
    const p = join(this.dir, "pages", `${pageKey(url)}.jpg`);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  /** The raw PDF bytes, when the page was a PDF. */
  pdf(url: string): Uint8Array | undefined {
    const p = join(this.dir, "pages", `${pageKey(url)}.pdf`);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  list(): PageRecord[] {
    return [...this.pages.values()];
  }

  private save(): void {
    const index = join(this.dir, "index.json");
    const tmp = `${index}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: INDEX_VERSION, pages: Object.fromEntries(this.pages) }, null, 1),
    );
    renameSync(tmp, index);
  }
}

/** A PDF by content type or by its `%PDF-` magic bytes. */
export function isPdf(contentType: string | undefined, body?: Uint8Array): boolean {
  if (contentType?.toLowerCase().includes("application/pdf")) return true;
  if (!body || body.byteLength < 5) return false;
  return (
    body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46 && body[4] === 0x2d
  );
}
