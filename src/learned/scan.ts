// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Export-safety scans for learned bundles. The allow-list decides what MAY
 * leave; these scans decide what may NOT, item by item. An item that fails any
 * scan is DROPPED — never redacted in place — and the reason is reported
 * (never the content). The same scans run again on import.
 *
 *   secret            key-shaped strings, private-key blocks, bearer tokens,
 *                     `password=…`-style assignments, JWTs, and the values of
 *                     this process's own secret-named environment variables
 *   instance          emails, IPv4 addresses, absolute paths, internal host
 *                     names, UUIDs, URLs with a query string or credentials,
 *                     phone-like numbers, plus caller-supplied instance tokens
 *                     (host name, instance name, data directory)
 *   human-name        a local account name (≥ 4 characters, whole word)
 *   benchmark-text    any 6-word shingle, or 40-character window at a word
 *                     start, shared with a local benchmark dataset cache
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export type ScanReason = "secret" | "instance" | "human-name" | "benchmark-text";

export interface ScanContext {
  /** Literal identifiers of this instance (host name, instance name, paths). */
  instanceTokens?: readonly string[];
  /** Local account names; whole-word, case-insensitive. */
  humanNames?: readonly string[];
  benchmarkIndex?: BenchmarkTextIndex;
  /** Secret values to look for verbatim (defaults to secret-named env values). */
  secretValues?: readonly string[];
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[abpr]|AKIA|ASIA|AIza|hf)[-_A-Za-z0-9]{12,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?\b\s*[:=]\s*["']?[^\s"']{8,}/i,
];

const INSTANCE_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/, // IPv4
  /(?:^|[\s"'(=:])(?:~\/|\/(?:home|Users|root|srv|var|tmp|etc|opt|mnt|data|workspace)\/)/, // POSIX path
  /\b[A-Za-z]:\\[^\s]/, // Windows path
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|internal|lan|corp|intranet|home\.arpa)\b/i, // internal host
  /\blocalhost:\d{2,5}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
  /\bhttps?:\/\/[^\s/]*@/i, // URL with credentials
  /\bhttps?:\/\/[^\s?#]+\?[^\s]+/i, // URL with a query string
  /(?:^|[^\d.])\+?\d{1,3}[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/, // phone-like
];

const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)S?$/i;

/** Values of secret-named environment variables (≥ 8 characters) to scan for verbatim. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || !SECRET_ENV_NAME.test(k)) continue;
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t.length >= 8) out.push(t);
    }
  }
  return out;
}

/** Account names that would never identify a person (system words). */
const NAME_STOPLIST = new Set([
  "marina",
  "guide",
  "system",
  "admin",
  "agent",
  "user",
  "operator",
  "default",
  "local",
  "world",
]);

/** The local account names worth scanning for (persons and agents, not `marina:*` services). */
export function scannableNames(names: readonly string[]): string[] {
  return names.filter(
    (n) => n.length >= 4 && !n.includes(":") && !NAME_STOPLIST.has(n.toLowerCase()),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string inside a value (keys excluded), for scanning. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

export class Scanner {
  private readonly names: RegExp | undefined;
  private readonly tokens: string[];
  private readonly secrets: string[];

  constructor(private readonly ctx: ScanContext = {}) {
    const names = scannableNames(ctx.humanNames ?? []);
    this.names = names.length
      ? new RegExp(
          `(?:^|[^A-Za-z0-9_])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`,
          "i",
        )
      : undefined;
    this.tokens = (ctx.instanceTokens ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 4);
    this.secrets = [...(ctx.secretValues ?? secretEnvValues())];
  }

  /** The first reason `texts` fail, or undefined when they pass. */
  scan(texts: readonly string[]): ScanReason | undefined {
    for (const text of texts) {
      if (SECRET_PATTERNS.some((re) => re.test(text))) return "secret";
      if (this.secrets.some((s) => text.includes(s))) return "secret";
    }
    for (const text of texts) {
      if (INSTANCE_PATTERNS.some((re) => re.test(text))) return "instance";
      const lower = text.toLowerCase();
      if (this.tokens.some((t) => lower.includes(t))) return "instance";
    }
    if (this.names && texts.some((t) => this.names?.test(t))) return "human-name";
    if (this.ctx.benchmarkIndex && texts.some((t) => this.ctx.benchmarkIndex?.overlaps(t)))
      return "benchmark-text";
    return undefined;
  }
}

// ─── Benchmark-text index ──────────────────────────────────────────────────

const SHINGLE = 6;
const WINDOW = 40;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Lower-cased, whitespace-collapsed text with the offsets of each word start. */
function windows(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (let i = 0; i + WINDOW <= norm.length; i++) {
    if (i === 0 || norm[i - 1] === " ") out.push(norm.slice(i, i + WINDOW));
  }
  return out;
}

const h = (s: string) => Bun.hash(s);

/**
 * Shingles of local benchmark text (questions, answers, choices) — 64-bit
 * hashes only, never the text. `overlaps(text)` is true when the text shares
 * any 6-word shingle or word-aligned 40-character window with the corpus.
 */
export class BenchmarkTextIndex {
  private readonly shingles = new Set<number | bigint>();
  private readonly windowSet = new Set<number | bigint>();
  corpora = 0;
  texts = 0;

  add(text: string): void {
    if (text.length < 12) return;
    this.texts++;
    const w = words(text);
    for (let i = 0; i + SHINGLE <= w.length; i++)
      this.shingles.add(h(w.slice(i, i + SHINGLE).join(" ")));
    for (const win of windows(text)) this.windowSet.add(h(win));
  }

  overlaps(text: string): boolean {
    const w = words(text);
    for (let i = 0; i + SHINGLE <= w.length; i++) {
      if (this.shingles.has(h(w.slice(i, i + SHINGLE).join(" ")))) return true;
    }
    for (const win of windows(text)) if (this.windowSet.has(h(win))) return true;
    return false;
  }

  get size(): number {
    return this.shingles.size;
  }

  /** Index a JSON / JSONL / text file (every string value of JSON). */
  addFile(path: string): void {
    const raw = readFileSync(path, "utf8");
    const ext = extname(path).toLowerCase();
    this.corpora++;
    if (ext === ".json") {
      try {
        for (const s of stringsOf(JSON.parse(raw) as unknown)) this.add(s);
        return;
      } catch {
        // allow-empty-catch: not JSON after all — indexed as plain text below
      }
    }
    if (ext === ".jsonl") {
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          for (const s of stringsOf(JSON.parse(line) as unknown)) this.add(s);
        } catch {
          this.add(line);
        }
      }
      return;
    }
    for (const para of raw.split(/\n\s*\n/)) this.add(para);
  }

  /** Index a file, or every .json/.jsonl/.txt file under a directory (recursive). */
  addPath(path: string): void {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.isFile()) {
      this.addFile(path);
      return;
    }
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const cst = statSync(child);
      if (cst.isDirectory()) this.addPath(child);
      else if ([".json", ".jsonl", ".txt"].includes(extname(entry).toLowerCase()))
        this.addFile(child);
    }
  }
}

/** The dataset caches the harness knows (`benchmarks/datasets`), relative to a checkout. */
export const DEFAULT_BENCHMARK_CORPORA = ["benchmarks/datasets"];
