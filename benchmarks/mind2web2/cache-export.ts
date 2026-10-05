// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exports what the research agent read (its `ProvenanceCache`) into the Mind2Web 2
 * webpage-cache layout the official judge reads (`mind2web2/utils/cache_filesys.py`):
 *
 *   cache/<agent>/<task_id>/index.json   { "<url>": "web" | "pdf" }
 *   cache/<agent>/<task_id>/<md5>.txt    page text      (web)
 *   cache/<agent>/<task_id>/<md5>.jpg    screenshot     (web; both files required)
 *   cache/<agent>/<task_id>/<md5>.pdf    PDF bytes      (pdf)
 *
 * `md5` is of the URL with the fragment removed, percent-decoded (Python's
 * `unquote`) and one trailing slash dropped (`_remove_frag_and_slash`); the
 * index key is that same string. A page the agent read through the browser
 * carries its screenshot; one read by plain fetch gets a blank screenshot —
 * either way the judge sees the text the agent saw. URLs
 * the agent did not read successfully are left out, for the official cacher to
 * capture (it skips URLs already in the index).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUrlFor } from "../../src/research/cited-answer";
import {
  canonicalUrl,
  type PageRecord,
  type ProvenanceCache,
} from "../../src/research/provenance-cache";

/** A 64×64 white JPEG: the screenshot slot for pages read as text. */
export const BLANK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0CiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//2Q==",
  "base64",
);

/** Python `urllib.parse.unquote` (UTF-8, errors="replace"): percent runs decoded as bytes. */
export function pyUnquote(s: string): string {
  if (!s.includes("%")) return s;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return decoder.decode(bytes);
  });
}

/** The judge's storage form of a URL: no fragment, percent-decoded, one trailing slash dropped. */
export function m2w2StorageUrl(url: string): string {
  const hash = url.indexOf("#");
  const noFrag = hash >= 0 ? url.slice(0, hash) : url;
  let decoded = pyUnquote(noFrag);
  if (decoded.endsWith("/") && decoded.length > 1 && !decoded.endsWith("://"))
    decoded = decoded.slice(0, -1);
  return decoded;
}

export function m2w2Hash(url: string): string {
  return createHash("md5").update(m2w2StorageUrl(url), "utf8").digest("hex");
}

export interface ExportStats {
  urls: number;
  exported: number;
  pdf: number;
  /** Already in the task's index (left untouched). */
  present: number;
  /** Cited but never read successfully by the agent (left for the official cacher). */
  notRead: number;
}

/**
 * Write the pages behind `urls` into `taskDir`. When several caches read the
 * same URL (several runs of one task), the latest successful read wins.
 */
export function exportTaskCache(
  caches: readonly ProvenanceCache[],
  urls: readonly string[],
  taskDir: string,
  opts: { overwrite?: boolean } = {},
): ExportStats {
  mkdirSync(taskDir, { recursive: true });
  const indexPath = join(taskDir, "index.json");
  const index: Record<string, "web" | "pdf"> = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, "web" | "pdf">)
    : {};
  const stats: ExportStats = { urls: 0, exported: 0, pdf: 0, present: 0, notRead: 0 };
  const seen = new Set<string>();
  for (const url of urls) {
    const key = m2w2StorageUrl(url);
    if (seen.has(canonicalUrl(url))) continue;
    seen.add(canonicalUrl(url));
    stats.urls++;
    if (index[key] && !opts.overwrite) {
      stats.present++;
      continue;
    }
    let best: { cache: ProvenanceCache; rec: PageRecord; readAs: string } | undefined;
    for (const cache of caches) {
      const readAs = readUrlFor(cache, url);
      const rec = readAs ? cache.get(readAs) : undefined;
      if (!readAs || !rec) continue;
      if (!best || rec.fetchedAt > best.rec.fetchedAt) best = { cache, rec, readAs };
    }
    if (!best) {
      stats.notRead++;
      continue;
    }
    const hash = m2w2Hash(url);
    if (best.rec.kind === "pdf") {
      const bytes = best.cache.pdf(best.readAs);
      if (!bytes) {
        stats.notRead++;
        continue;
      }
      writeFileSync(join(taskDir, `${hash}.pdf`), bytes);
      index[key] = "pdf";
      stats.pdf++;
    } else {
      const text = best.cache.text(best.readAs) ?? "";
      if (!text.trim()) {
        stats.notRead++;
        continue;
      }
      writeFileSync(join(taskDir, `${hash}.txt`), text);
      writeFileSync(join(taskDir, `${hash}.jpg`), best.cache.screenshot(best.readAs) ?? BLANK_JPEG);
      index[key] = "web";
    }
    stats.exported++;
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return stats;
}
