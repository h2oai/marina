// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native task generators — shared types, seeded randomness and deliverable parsing.
 *
 * A generator turns a seed into a fresh task instance (dispatch text, private
 * per-member material, world setup steps) plus the oracle data that scores a
 * deliverable exactly. Everything is synthetic and deterministic from the seed.
 */

export type NativeTaskId = "csp" | "aggregation" | "bugs" | "auction" | "delphi" | "pipeline";

/** One world-setup step, applied by the runner through Marina commands or the filesystem. */
export type SetupStep =
  /** `pool create <pool>` (idempotent). */
  | { kind: "pool"; pool: string }
  /** `pool <pool> add <text>`. Pool listings show 60 characters: keep these short. */
  | { kind: "pool-note"; pool: string; text: string }
  /** Private material for one member: delivered as an Operator `tell`, seen by that member only. */
  | { kind: "private"; member: string; text: string }
  /** A file written under the code workspace root (path relative to it). */
  | { kind: "file"; path: string; content: string };

/** Optional fault: the runner stops `member` (`agent stop`) `afterSeconds` into the task. */
export interface FaultPlan {
  member: string;
  afterSeconds: number;
}

export interface NativeInstance<O> {
  task: NativeTaskId;
  seed: number;
  /** Deliverable tag, e.g. `CSP7`; prefixes the deliverable line and the private material. */
  tag: string;
  /** Formation shape the task exercises (informational). */
  shape: string;
  /** Dispatch text for `crew dispatch <crew> <text>`. Single line. */
  text: string;
  /** Private material per member (also present in `setup` as `private` steps). */
  privateMaterial: Record<string, string[]>;
  setup: SetupStep[];
  /** Pool the deliverable note goes to. */
  pool: string;
  /** Regex source that identifies a deliverable note (any attempt, right or wrong). */
  deliverableRe: string;
  /** A canonical correct deliverable (for inspection and known-good tests). */
  answer: string;
  /** Workspace-relative files the oracle reads at scoring time. */
  scoreFiles?: string[];
  fault?: FaultPlan;
  oracle: O;
}

export interface GenerateOptions {
  /** Crew member names private material is dealt to. */
  members?: string[];
  /** Deliverable pool (default `eval-artifacts`, the sweep convention). */
  pool?: string;
  /** Aggregation: replicate shards and plan an `agent stop` of one member. */
  crash?: boolean;
}

export interface ScoreContext {
  /** Workspace-relative path → current content, for oracles that read files. */
  files?: Record<string, string>;
}

export interface NativeScore {
  correct: boolean;
  /** 0–1. */
  score: number;
  details: Record<string, unknown>;
}

export interface NativeGenerator<O> {
  id: NativeTaskId;
  title: string;
  shape: string;
  generate(seed: number, opts?: GenerateOptions): NativeInstance<O>;
  score(deliverable: string, oracle: O, ctx?: ScoreContext): NativeScore | Promise<NativeScore>;
}

/** The showcase answerer crew at `MARINA_ANSWERER_COUNT=1`. */
export const DEFAULT_MEMBERS = ["Answerer", "Mathematician", "Reflector", "Translator"];
export const DEFAULT_POOL = "eval-artifacts";

// ─── Seeded randomness ───────────────────────────────────────────────────────

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: readonly T[]): T[];
  /** Standard normal (Box–Muller). */
  normal(): number;
}

/** mulberry32 keyed by (salt, seed); independent streams per salt. */
export function makeRng(seed: number, salt: string): Rng {
  let a = hash32(`${salt}:${seed}`) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)] as T,
    shuffle: <T>(xs: readonly T[]) => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
    normal: () => {
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

// ─── Deliverable parsing ─────────────────────────────────────────────────────

/** Escape a literal for use inside a RegExp source. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source matching `<TAG> <LABEL>:` anywhere in a note. */
export function deliverableRe(tag: string, label: string): string {
  return `${escapeRe(tag)}\\s+${escapeRe(label)}\\s*:`;
}

/**
 * Parse `<TAG> <LABEL>: k=v; k=v; …` into an ordered key → value map. Keys are
 * case-folded; values trimmed. Returns null when the header is absent.
 */
export function parseFields(text: string, tag: string, label: string): Map<string, string> | null {
  const m = new RegExp(`${deliverableRe(tag, label)}(.*)$`, "is").exec(text);
  if (!m) return null;
  const out = new Map<string, string>();
  for (const part of (m[1] ?? "").split(/[;\n]/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part
      .slice(eq + 1)
      .trim()
      .replace(/[.。]+$/, "");
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

/** Parse an integer strictly (optional sign, digits only). */
export function parseIntStrict(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  return /^[-+]?\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}

/** Parse a finite decimal number. */
export function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function resolveMembers(opts?: GenerateOptions): string[] {
  const m = (opts?.members ?? DEFAULT_MEMBERS).filter((x) => x.trim().length > 0);
  if (m.length === 0) throw new Error("at least one crew member is required");
  return m;
}

/** Collect `private` steps into a member → messages map. */
export function privateMap(setup: SetupStep[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of setup) if (s.kind === "private") (out[s.member] ??= []).push(s.text);
  return out;
}

/** The sweep's deposit clause. */
export function depositClause(pool: string, format: string): string {
  return `Deposit EXACTLY ONE note into pool ${pool} formatted precisely: ${format} Nothing else in the note.`;
}
