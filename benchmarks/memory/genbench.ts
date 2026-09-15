#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * genbench — the memory-delta benchmark harness (Phase 1.7).
 *
 * Measures whether Marina's memory changes answer quality, under a reporting
 * standard designed so the number cannot flatter itself:
 *
 *   - fixed answering model + fixed judge with a published prompt
 *   - ≥5 seeds, Wilson 95% CIs on pooled accuracy, seed-level CI alongside
 *   - matched controls under the SAME harness: `bare`, `fullcontext`, `bm25`
 *   - tokens injected and latency per query, cost from reported usage
 *   - token-F1 AND judge accuracy, always both
 *   - held-out items: seed/eval split by seed-stable hash; a note written
 *     about item X is never allowed to score item X
 *
 * Memory injection goes through the RESIDENT path — the same functions the
 * agent continuation prompt uses to build its "Relevant Notes" section
 * (`recallNotes` → `expandMemoryRecall` → `renderRelevantNoteTiers`) — not
 * through SDK-side recall + string concatenation. `src/memory/unified-context.ts`
 * (`buildUnifiedContext` + `renderUnifiedContext`) appeared as uncommitted WIP
 * while this harness was written and the adapter now renders through it;
 * `buildResidentMemoryContext` below is the one function to swap once that
 * module is committed, bumping RESIDENT_CONTEXT_VERSION.
 *
 * `--model stub --judge stub` runs the entire pipeline offline and
 * deterministically; that is what CI exercises. Nothing here ever calls a
 * paid model unless you name one.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildUnifiedContext, renderUnifiedContext } from "../../src/memory/unified-context";
import { MarinaDB } from "../../src/persistence/database";
import * as downloads from "../download";
import type { DatasetItem, Message } from "../types";

// ─── Public constants ───────────────────────────────────────────────────────

export const ARMS = ["bare", "cold", "warm", "fullcontext", "bm25"] as const;
export type Arm = (typeof ARMS)[number];

export const RESULT_SCHEMA = "marina.memory.genbench.v1" as const;

/**
 * Identifies the memory-context construction in force. Bump when the
 * resident path changes (e.g. the switch to `buildUnifiedContext`), so old
 * result files can never be mistaken for new-code measurements.
 */
export const RESIDENT_CONTEXT_VERSION = "resident-v2:buildUnifiedContext+renderUnifiedContext";

/** Entity name that owns every note the harness writes. */
export const MEMORY_OWNER = "GenbenchAgent";

/** Fraction of items the stub model "already knows" (simulated prior knowledge). */
export const STUB_KNOWN_FRACTION = 0.6;

export const JUDGE_PROMPT_VERSION = "judge-v1";
/** Published judge prompt. `{question}`, `{gold}`, `{prediction}` are substituted. */
export const JUDGE_PROMPT_V1 = `You are grading a short answer against a reference answer.
Reply with exactly one word: CORRECT if the candidate answer expresses the same final answer as the reference (numeric equality, same choice letter, or same entity/quantity — wording may differ), otherwise INCORRECT. Do not explain.

Question: {question}
Reference answer: {gold}
Candidate answer: {prediction}

Verdict:`;

const LETTERS = "ABCDEFGHIJ";
const TOPIC_CHARS = 200;
const SYNTHETIC_ITEMS_PATH = join(import.meta.dir, "items", "synthetic-v1.json");
const DEFAULT_RESULTS_DIR = join(import.meta.dir, "..", "results", "memory");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryBenchmarkOptions {
  /** `synthetic-v1` (committed, offline) or a harness dataset name (`gsm8k`, `mmlu-pro`, …). */
  dataset: string;
  arms: readonly Arm[];
  /** `stub` or an OpenAI-compatible model id routed through `endpoint`. */
  model: string;
  /** `stub` (normalized exact-match) or a model id for the LLM judge. */
  judge: string;
  /** Number of seeds (≥1; the reporting standard asks for ≥5). */
  seeds: number;
  seedStart?: number;
  /** Cap on items loaded before the split (applied after a seeded shuffle for downloaded sets). */
  limit?: number;
  /** Salt folded into the split hash so a split can be pinned or deliberately changed. */
  splitSalt?: string;
  /** Fraction of items assigned to the seed set (rest is eval). */
  seedFraction?: number;
  /**
   * `item`: every item is assigned independently (a paraphrase's sibling lands
   * in the seed set only by chance — the reachable ceiling is ≈ seedFraction).
   * `paraphrase`: for datasets whose items carry `metadata.factId`, exactly one
   * paraphrase of every fact is held out and the rest are seeded, so every
   * eval item is reachable. Default: `paraphrase` when every item has a
   * factId (synthetic-v1), else `item`.
   */
  split?: SplitMode;
  /** `model`: warm DB holds what the model learned on the seed set. `gold`: oracle-seeded ceiling. */
  seedSource?: "model" | "gold";
  /** bm25 control top-k. */
  topK?: number;
  /** fullcontext control budget (tokens, chars/4 heuristic). */
  contextBudgetTokens?: number;
  /** cold/warm write a Q/A note after every answer (within-run learning). */
  learn?: boolean;
  endpoint?: string;
  apiKey?: string;
  judgeEndpoint?: string;
  judgeApiKey?: string;
  priceInPerMillion?: number;
  priceOutPerMillion?: number;
  resultsDir?: string;
  /** Refuse all network. Default: true iff model and judge are both `stub`. */
  offline?: boolean;
  quiet?: boolean;
  /** Worker count for arms that do not mutate memory (bare/fullcontext/bm25). */
  concurrency?: number;
  requestTimeoutMs?: number;
  /**
   * Sampling temperature sent to the model and the LLM judge. `null` (the
   * default) omits the field so the provider default applies: the Claude 5
   * family rejects an explicit temperature and GPT-5 reasoning models ignore
   * or reject non-default values, so a pinned 0 is not portable. Recorded in
   * `config.temperature`.
   */
  temperature?: number | null;
}

export interface QueryRecord {
  seed: number;
  id: string;
  category?: string;
  question: string;
  expected: string;
  prediction: string;
  correct: boolean;
  tokenF1: number;
  memoryHits: number;
  injectedChars: number;
  injectedTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  retrievalMs: number;
  modelMs: number;
  judgeMs: number;
  totalMs: number;
  error?: string;
}

export interface SeedSummary {
  seed: number;
  splitFingerprint: string;
  seedSetSize: number;
  evalSetSize: number;
  evalIds: string[];
  seedIds: string[];
  n: number;
  correct: number;
  accuracy: number;
  tokenF1Mean: number;
  /** Transfer ceiling of this seed's split (see `Split.reachable`). */
  reachable: number | null;
  /** Seeding-pass bookkeeping (never scored): notes written + seed-set accuracy. */
  seedPass?: { items: number; correct: number; notes: number };
}

export interface Interval {
  low: number;
  high: number;
}

export interface Percentiles {
  p50: number;
  p95: number;
}

export interface ArmMetrics {
  n: number;
  correct: number;
  errors: number;
  judgeAccuracy: {
    pooled: number;
    wilson95: Interval;
    perSeed: number[];
    seedMean: number;
    seedStd: number;
    seedCi95: Interval;
  };
  tokenF1: { mean: number; perSeed: number[] };
  /**
   * Eval-weighted mean of the per-seed reachable ceilings — the accuracy a
   * perfect memory could reach on this split. Compare memory arms against it,
   * not against 100 %. `null` for datasets without fact groups.
   */
  reachable: number | null;
  memoryHitRate: number;
  injectedTokens: { mean: number; p95: number; max: number };
  injectedChars: { mean: number; p95: number };
  promptTokens: { mean: number; total: number } | null;
  completionTokens: { total: number } | null;
  latencyMs: { total: Percentiles; retrieval: Percentiles; model: Percentiles };
  costUsd: number | null;
  skipped?: string;
}

export interface ArmConfig {
  arm: Arm;
  dataset: string;
  datasetItems: number;
  model: string;
  judge: string;
  judgePrompt: string;
  seeds: number[];
  splitSalt: string;
  seedFraction: number;
  splitMode: SplitMode;
  seedSource: "model" | "gold";
  learn: boolean;
  topK: number;
  contextBudgetTokens: number;
  endpoint: string | null;
  temperature: number | null;
  harnessGitSha: string;
  residentContextVersion: string;
  memoryOwner: string;
  offline: boolean;
  networkAttempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ArmResult {
  schema: typeof RESULT_SCHEMA;
  config: ArmConfig;
  metrics: ArmMetrics;
  perSeed: SeedSummary[];
  items: QueryRecord[];
}

export interface MemoryBenchmarkReport {
  results: ArmResult[];
  files: string[];
  summaryPath: string | null;
  summaryMarkdown: string;
  networkAttempts: number;
}

// ─── Deterministic primitives ───────────────────────────────────────────────

/**
 * FNV-1a 32-bit with a murmur3 avalanche finalizer. Stable across runs,
 * platforms, and Bun versions. The finalizer matters: raw FNV-1a over ids
 * that differ in one trailing character leaves the high bits correlated,
 * which skews a fraction-based split.
 */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Seed/eval split by seed-stable hash. Disjoint by construction; covers every item. */
export type SplitMode = "item" | "paraphrase";

export interface Split<T> {
  seedSet: T[];
  evalSet: T[];
  fingerprint: string;
  /**
   * Fraction of eval items whose fact (`metadata.factId`) has at least one
   * paraphrase in the seed set — the transfer CEILING for this split. `null`
   * when no eval item carries a factId (downloaded sets), where a Q/A note
   * about one item rarely helps another and the notion does not apply.
   */
  reachable: number | null;
}

type FactItem = { id: string; metadata?: Record<string, unknown> };

const factIdOf = (item: FactItem): string | undefined => {
  const value = item.metadata?.factId;
  return value === undefined || value === null ? undefined : String(value);
};

/** Share of eval items whose fact is represented in the seed set (see `Split.reachable`). */
export function reachableFraction<T extends FactItem>(
  seedSet: readonly T[],
  evalSet: readonly T[],
): number | null {
  const seeded = new Set(seedSet.map(factIdOf).filter((f): f is string => f !== undefined));
  const withFact = evalSet.filter((item) => factIdOf(item) !== undefined);
  if (withFact.length === 0) return null;
  return withFact.filter((item) => seeded.has(factIdOf(item)!)).length / withFact.length;
}

function fingerprintOf(evalSet: readonly { id: string }[]): string {
  return stableHash(
    evalSet
      .map((i) => i.id)
      .sort()
      .join("|"),
  )
    .toString(16)
    .padStart(8, "0");
}

/**
 * Paraphrase split: every fact with ≥ 2 paraphrases holds out exactly one
 * (chosen by a seed-stable hash of the factId) and seeds the rest; items
 * without a factId, or alone in their fact, fall back to the item split.
 * Disjoint and exhaustive by construction; reachable = 1 for the grouped part.
 */
export function splitParaphrases<T extends FactItem>(
  items: readonly T[],
  seed: number,
  salt: string,
  seedFraction: number,
): Split<T> {
  const groups = new Map<string, T[]>();
  const loose: T[] = [];
  for (const item of items) {
    const fact = factIdOf(item);
    if (fact === undefined) loose.push(item);
    else groups.set(fact, [...(groups.get(fact) ?? []), item]);
  }
  const seedSet: T[] = [];
  const evalSet: T[] = [];
  for (const [fact, members] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 2) {
      loose.push(...members);
      continue;
    }
    const ordered = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const held = stableHash(`${seed}:${salt}:${fact}`) % ordered.length;
    ordered.forEach((item, index) => (index === held ? evalSet : seedSet).push(item));
  }
  const rest = splitItems(loose, seed, salt, seedFraction);
  seedSet.push(...rest.seedSet);
  evalSet.push(...rest.evalSet);
  return {
    seedSet,
    evalSet,
    fingerprint: fingerprintOf(evalSet),
    reachable: reachableFraction(seedSet, evalSet),
  };
}

/** Choose the split for a dataset: `paraphrase` iff every item carries a factId. */
export function defaultSplitMode(items: readonly FactItem[]): SplitMode {
  return items.length > 0 && items.every((item) => factIdOf(item) !== undefined)
    ? "paraphrase"
    : "item";
}

export function splitDataset<T extends FactItem>(
  items: readonly T[],
  seed: number,
  salt: string,
  seedFraction: number,
  mode: SplitMode,
): Split<T> {
  return mode === "paraphrase"
    ? splitParaphrases(items, seed, salt, seedFraction)
    : splitItems(items, seed, salt, seedFraction);
}

export function splitItems<T extends { id: string }>(
  items: readonly T[],
  seed: number,
  salt: string,
  seedFraction: number,
): Split<T> {
  const seedSet: T[] = [];
  const evalSet: T[] = [];
  for (const item of items) {
    const unit = stableHash(`${seed}:${salt}:${item.id}`) / 0x1_0000_0000;
    (unit < seedFraction ? seedSet : evalSet).push(item);
  }
  return {
    seedSet,
    evalSet,
    fingerprint: fingerprintOf(evalSet),
    reachable: reachableFraction(seedSet as FactItem[], evalSet as FactItem[]),
  };
}

/** Wilson score interval, 95%. */
export function wilson95(correct: number, n: number): Interval {
  if (n <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** SQuAD-style answer normalization: lowercase, strip punctuation + articles, collapse spaces. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** SQuAD token-F1 between a prediction and a gold string. */
export function tokenF1(prediction: string, gold: string): number {
  const p = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const g = normalizeAnswer(gold).split(" ").filter(Boolean);
  if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const t of g) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/** chars/4 heuristic — labeled as such in every result file. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

// ─── Items ──────────────────────────────────────────────────────────────────

type ItemKind = "multiple-choice" | "numeric" | "short-answer";

function itemKind(item: DatasetItem): ItemKind {
  if (item.choices && item.choices.length > 0) return "multiple-choice";
  if (/^-?[\d,]*\.?\d+$/.test(item.answer.trim())) return "numeric";
  return "short-answer";
}

/** The gold answer as prose — for MC items the choice text, not the letter. */
export function goldText(item: DatasetItem): string {
  if (item.choices && item.choices.length > 0) {
    const idx = LETTERS.indexOf(item.answer.trim().toUpperCase());
    if (idx >= 0 && item.choices[idx]) return item.choices[idx];
  }
  return item.answer;
}

function topicFrom(question: string): string {
  return question.slice(0, TOPIC_CHARS).replace(/\s+/g, " ").trim();
}

/** The note the agent writes after answering — the `qa` learning mode. */
export function learnNoteText(item: DatasetItem, answer: string): string {
  const q = item.question.slice(0, 300).replace(/\s+/g, " ").trim();
  const a = answer.slice(0, 500).replace(/\s+/g, " ").trim();
  return `Q: ${q} | A: ${a}`;
}

function buildQuestionMessages(item: DatasetItem, memoryContext: string): Message[] {
  const kind = itemKind(item);
  const system =
    kind === "multiple-choice"
      ? "Answer the multiple-choice question. Reply with ONLY the letter of the correct answer."
      : kind === "numeric"
        ? "Solve the problem. Reply with ONLY the final numeric answer."
        : "Answer the question concisely with just the answer, no explanation.";
  const messages: Message[] = [{ role: "system", content: system }];
  if (memoryContext) messages.push({ role: "system", content: memoryContext });
  const choices = item.choices ?? [];
  const body =
    kind === "multiple-choice"
      ? `${item.question}\n\n${choices.map((c, i) => `${LETTERS[i]}) ${c}`).join("\n")}\n\nAnswer:`
      : item.question;
  messages.push({ role: "user", content: body });
  return messages;
}

export function loadSyntheticItems(): DatasetItem[] {
  const raw = JSON.parse(readFileSync(SYNTHETIC_ITEMS_PATH, "utf-8")) as { items: DatasetItem[] };
  return raw.items;
}

type Loader = (dir: string, limit?: number) => Promise<DatasetItem[]>;
const DATASET_LOADERS: Record<string, Loader> = {
  "mmlu-pro": downloads.downloadMMLUPro,
  truthfulqa: downloads.downloadTruthfulQA,
  "arc-challenge": downloads.downloadARC,
  hellaswag: downloads.downloadHellaSwag,
  musr: downloads.downloadMuSR,
  bbh: downloads.downloadBBH,
  gsm8k: downloads.downloadGSM8K,
  math: downloads.downloadMATH,
  "simple-qa": downloads.downloadSimpleQA,
  simpleqa: downloads.downloadSimpleQA,
  aime: downloads.downloadAIME,
};

export const DATASETS = ["synthetic-v1", ...Object.keys(DATASET_LOADERS)];

export async function loadDataset(name: string, limit?: number): Promise<DatasetItem[]> {
  if (name === "synthetic-v1") {
    const items = loadSyntheticItems();
    return limit ? items.slice(0, limit) : items;
  }
  const loader = DATASET_LOADERS[name];
  if (!loader) throw new Error(`Unknown dataset "${name}". Known: ${DATASETS.join(", ")}`);
  const items = await loader(join(import.meta.dir, "..", "datasets"), limit);
  // Deterministic subset — the split hash is per item id, so which items are
  // present must itself be stable. Fixed shuffle seed; the per-run seed only
  // varies the seed/eval assignment.
  const shuffled = downloads.seededShuffle(items, 20260913);
  return limit ? shuffled.slice(0, limit) : shuffled;
}

// ─── Memory context construction ────────────────────────────────────────────

export interface MemoryContext {
  text: string;
  hits: number;
}

/**
 * RESIDENT PATH. Mirrors `LeanAgentAdapter` §4 exactly: `recall <q> trusted`
 * and `recall <q>` (both `recallNotes` + `expandMemoryRecall`), rendered by
 * `renderRelevantNoteTiers` under the same section header. Once
 * `src/memory/unified-context.ts` is committed, replace this body with
 * `renderUnifiedContext(await buildUnifiedContext(db, owner, topic))` and bump
 * RESIDENT_CONTEXT_VERSION (the adapter already renders through it).
 */
export async function buildResidentMemoryContext(
  db: MarinaDB,
  owner: string,
  question: string,
): Promise<MemoryContext> {
  // Same code path the LeanAgentAdapter §4 uses (Phase 1.1): five labeled
  // tiers — skills, [trusted], [evidence], [proposal], [unverified] — within
  // the prompt byte budget. Legacy-only seeding means the durable tiers are
  // empty here unless the seed pass writes through `note` (which twins).
  const result = await buildUnifiedContext(db, owner, topicFrom(question));
  const hits = result.tiers.reduce((n, tier) => n + tier.items.length, 0);
  if (hits === 0) return { text: "", hits: 0 };
  // Same rendering the continuation prompt uses: one compact [degraded] line
  // rather than the full block (the structured result keeps every entry).
  return { text: renderUnifiedContext(result, { degraded: "compact" }), hits };
}

/** Control: legacy FTS recall, relevance-only weights, top-k verbatim, no tiering. */
export function buildBm25Context(
  db: MarinaDB,
  owner: string,
  question: string,
  topK: number,
): MemoryContext {
  const rows = db
    .recallNotes(owner, topicFrom(question), {
      weightImportance: 0,
      weightRecency: 0,
      weightRelevance: 1,
    })
    .slice(0, topK);
  if (rows.length === 0) return { text: "", hits: 0 };
  return {
    text: `Retrieved documents:\n${rows.map((r) => `- ${r.content}`).join("\n")}`,
    hits: rows.length,
  };
}

/** Control: the whole seeded corpus inline, when it fits the budget. */
export function buildFullContext(
  notes: readonly string[],
  budgetTokens: number,
): MemoryContext & { overBudget: boolean; tokens: number } {
  if (notes.length === 0) return { text: "", hits: 0, overBudget: false, tokens: 0 };
  const text = `Known facts:\n${notes.map((n) => `- ${n}`).join("\n")}`;
  const tokens = estimateTokens(text);
  if (tokens > budgetTokens) return { text: "", hits: 0, overBudget: true, tokens };
  return { text, hits: notes.length, overBudget: false, tokens };
}

// ─── Answering models ───────────────────────────────────────────────────────

interface ModelReply {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AnsweringModel {
  id: string;
  answer(messages: Message[], item: DatasetItem, memoryContext: string): Promise<ModelReply>;
}

export function stubKnows(id: string): boolean {
  return stableHash(`known:${id}`) % 1000 < STUB_KNOWN_FRACTION * 1000;
}

/**
 * Deterministic answering model. Correct iff the item is in the fixed "known"
 * subset or the gold answer text appears in the injected memory context.
 * Bare therefore lands at ~60%; memory arms rise exactly as far as recall
 * actually surfaces transferable notes — no more.
 */
export function createStubModel(): AnsweringModel {
  return {
    id: "stub",
    async answer(_messages, item, memoryContext) {
      const gold = goldText(item);
      const recalled =
        memoryContext.length > 0 && normalizeAnswer(memoryContext).includes(normalizeAnswer(gold));
      if (stubKnows(item.id) || recalled) {
        return { text: itemKind(item) === "multiple-choice" ? item.answer : gold };
      }
      if (itemKind(item) === "multiple-choice") {
        const idx = LETTERS.indexOf(item.answer.trim().toUpperCase());
        const wrong = LETTERS[(Math.max(idx, 0) + 1) % Math.max(item.choices?.length ?? 2, 2)];
        return { text: wrong ?? "A" };
      }
      return { text: "I do not know." };
    },
  };
}

async function openaiChat(
  endpoint: string,
  model: string,
  messages: Message[],
  apiKey: string | undefined,
  timeoutMs: number,
  temperature: number | null = null,
): Promise<ModelReply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      ...(temperature === null ? {} : { temperature }),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`model ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined,
  };
}

/**
 * Any OpenAI-compatible model id, routed through a Marina instance the way
 * `scripts/research/memory-live-runtime.ts` does: the harness only ever talks
 * to `endpoint`; provider credentials stay inside Marina. Pass `--api-key`
 * (or MARINA_API_KEY / MODEL_API_KEY) when the instance requires one.
 */
export function createRemoteModel(
  id: string,
  endpoint: string,
  apiKey: string | undefined,
  timeoutMs: number,
  temperature: number | null = null,
): AnsweringModel {
  return {
    id,
    answer: (messages) => openaiChat(endpoint, id, messages, apiKey, timeoutMs, temperature),
  };
}

// ─── Judges ─────────────────────────────────────────────────────────────────

interface Judge {
  id: string;
  prompt: string;
  grade(prediction: string, item: DatasetItem): Promise<boolean>;
}

function extractLetter(response: string): string {
  const cleaned = response.trim().toUpperCase();
  const explicit = [...cleaned.matchAll(/ANSWER\s*(?:IS|:|=)\s*\(?\**([A-J])\**\)?/g)];
  if (explicit.length > 0) return explicit[explicit.length - 1]?.[1] ?? "";
  if (cleaned.length <= 5) return cleaned.match(/\b([A-J])\b/)?.[1] ?? "";
  const all = [...cleaned.matchAll(/\b([A-J])\b/g)];
  return all[all.length - 1]?.[1] ?? "";
}

function lastNumber(text: string): string | null {
  const matches = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
  return matches ? (matches[matches.length - 1] ?? null) : null;
}

/**
 * Exact-match judge (normalized). MC → extracted letter; numeric → last
 * number equals gold; otherwise normalized equality or whole-answer
 * containment (the §5 retention rule). Deterministic, offline.
 */
export function exactMatchJudge(prediction: string, item: DatasetItem): boolean {
  const kind = itemKind(item);
  if (kind === "multiple-choice")
    return extractLetter(prediction) === item.answer.trim().toUpperCase();
  if (kind === "numeric") {
    const gold = Number(item.answer.replace(/,/g, ""));
    const got = lastNumber(prediction);
    return got !== null && Number(got) === gold;
  }
  const p = normalizeAnswer(prediction);
  const g = normalizeAnswer(item.answer);
  return g.length > 0 && (p === g || ` ${p} `.includes(` ${g} `));
}

function createStubJudge(): Judge {
  return {
    id: "stub",
    prompt: "exact-match (normalized; MC letter; numeric last-number; whole-answer containment)",
    grade: async (prediction, item) => exactMatchJudge(prediction, item),
  };
}

function createLlmJudge(
  id: string,
  endpoint: string,
  apiKey: string | undefined,
  timeoutMs: number,
  temperature: number | null = null,
): Judge {
  return {
    id,
    prompt: `${JUDGE_PROMPT_VERSION}: ${JUDGE_PROMPT_V1}`,
    async grade(prediction, item) {
      const content = JUDGE_PROMPT_V1.replace("{question}", item.question)
        .replace("{gold}", goldText(item))
        .replace("{prediction}", prediction.slice(0, 2000));
      const reply = await openaiChat(
        endpoint,
        id,
        [{ role: "user", content }],
        apiKey,
        timeoutMs,
        temperature,
      );
      return /^\W*CORRECT/i.test(reply.text.trim());
    },
  };
}

// ─── Offline guard ──────────────────────────────────────────────────────────

function installOfflineGuard(): { attempts: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let attempts = 0;
  const refuse = async (input: RequestInfo | URL) => {
    attempts++;
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`genbench offline mode refused network access to ${target}`);
  };
  globalThis.fetch = Object.assign(refuse, { preconnect: original.preconnect }) as typeof fetch;
  return {
    attempts: () => attempts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ─── Harness core ───────────────────────────────────────────────────────────

interface Resolved {
  dataset: string;
  arms: Arm[];
  model: AnsweringModel;
  judge: Judge;
  seeds: number[];
  splitSalt: string;
  split?: SplitMode;
  seedFraction: number;
  seedSource: "model" | "gold";
  topK: number;
  contextBudgetTokens: number;
  learn: boolean;
  endpoint: string | null;
  temperature: number | null;
  priceIn?: number;
  priceOut?: number;
  resultsDir: string;
  offline: boolean;
  quiet: boolean;
  concurrency: number;
}

function resolveOptions(options: MemoryBenchmarkOptions): Resolved {
  const offline = options.offline ?? (options.model === "stub" && options.judge === "stub");
  const endpoint = options.endpoint ?? "http://localhost:3300";
  const timeout = options.requestTimeoutMs ?? 120_000;
  const temperature = options.temperature ?? null;
  const apiKey = options.apiKey ?? process.env.MARINA_API_KEY ?? process.env.MODEL_API_KEY;
  if (offline && (options.model !== "stub" || options.judge !== "stub")) {
    throw new Error("offline mode requires --model stub and --judge stub");
  }
  const seeds = Array.from(
    { length: Math.max(1, options.seeds) },
    (_, i) => (options.seedStart ?? 1) + i,
  );
  for (const arm of options.arms) {
    if (!ARMS.includes(arm)) throw new Error(`Unknown arm "${arm}". Known: ${ARMS.join(", ")}`);
  }
  return {
    dataset: options.dataset,
    arms: [...options.arms],
    model:
      options.model === "stub"
        ? createStubModel()
        : createRemoteModel(options.model, endpoint, apiKey, timeout, temperature),
    judge:
      options.judge === "stub"
        ? createStubJudge()
        : createLlmJudge(
            options.judge,
            options.judgeEndpoint ?? endpoint,
            options.judgeApiKey ?? apiKey,
            timeout,
            temperature,
          ),
    seeds,
    splitSalt: options.splitSalt ?? "v1",
    seedFraction: options.seedFraction ?? 0.5,
    split: options.split,
    seedSource: options.seedSource ?? "model",
    topK: options.topK ?? 5,
    contextBudgetTokens: options.contextBudgetTokens ?? 8000,
    learn: options.learn ?? true,
    endpoint: options.model === "stub" && options.judge === "stub" ? null : endpoint,
    temperature,
    priceIn: options.priceInPerMillion,
    priceOut: options.priceOutPerMillion,
    resultsDir: options.resultsDir ?? DEFAULT_RESULTS_DIR,
    offline,
    quiet: options.quiet ?? false,
    concurrency: Math.max(1, options.concurrency ?? (options.model === "stub" ? 1 : 4)),
  };
}

function gitSha(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "ignore",
    });
    const sha = proc.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

class ScratchDb {
  readonly db: MarinaDB;
  private readonly dir: string;
  constructor(label: string) {
    this.dir = mkdtempSync(join(tmpdir(), `genbench-${label}-`));
    this.db = new MarinaDB(join(this.dir, "memory.db"));
  }
  close(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function writeNote(db: MarinaDB, text: string): void {
  db.createNote(MEMORY_OWNER, text, undefined, { noteType: "fact", tier: "fact" });
}

function seedNotesInto(db: MarinaDB, notes: readonly string[]): void {
  for (const note of notes) writeNote(db, note);
}

async function runOne(
  r: Resolved,
  seed: number,
  item: DatasetItem,
  context: MemoryContext,
  retrievalMs: number,
): Promise<QueryRecord> {
  const t0 = performance.now();
  const messages = buildQuestionMessages(item, context.text);
  let prediction = "";
  let error: string | undefined;
  let usage: ModelReply["usage"];
  let modelMs = 0;
  let judgeMs = 0;
  let correct = false;
  try {
    const tm = performance.now();
    const reply = await r.model.answer(messages, item, context.text);
    modelMs = performance.now() - tm;
    prediction = reply.text;
    usage = reply.usage;
    const tj = performance.now();
    correct = await r.judge.grade(prediction, item);
    judgeMs = performance.now() - tj;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    prediction = prediction || `ERROR: ${error}`;
  }
  return {
    seed,
    id: item.id,
    category: item.category,
    question: item.question,
    expected: item.answer,
    prediction: prediction.slice(0, 500),
    correct,
    tokenF1: error ? 0 : tokenF1(prediction, goldText(item)),
    memoryHits: context.hits,
    injectedChars: context.text.length,
    injectedTokens: estimateTokens(context.text),
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    retrievalMs,
    modelMs,
    judgeMs,
    totalMs: performance.now() - t0 + retrievalMs,
    error,
  };
}

/** Sequential when memory is mutated between items; pooled otherwise. */
async function mapPool<T, U>(
  inputs: readonly T[],
  concurrency: number,
  fn: (input: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(inputs.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= inputs.length) return;
      out[i] = await fn(inputs[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return out;
}

interface SeedCorpus {
  notes: string[];
  seedPass: SeedSummary["seedPass"];
}

/**
 * The seeding pass: the model answers every SEED-set item with memory on and
 * learning on, in a DB that is then snapshotted. Warm/bm25/fullcontext all
 * receive this same corpus — they differ only in the injection mechanism.
 * `gold` source skips the model and writes the reference answers (an oracle
 * ceiling, labeled as such in the config block).
 */
async function buildSeedCorpus(
  r: Resolved,
  seed: number,
  seedSet: DatasetItem[],
): Promise<SeedCorpus> {
  if (r.seedSource === "gold") {
    const notes = seedSet.map((item) => learnNoteText(item, goldText(item)));
    return {
      notes,
      seedPass: { items: seedSet.length, correct: seedSet.length, notes: notes.length },
    };
  }
  const scratch = new ScratchDb(`seed${seed}`);
  try {
    const notes: string[] = [];
    let correct = 0;
    for (const item of seedSet) {
      const tr = performance.now();
      const context = await buildResidentMemoryContext(scratch.db, MEMORY_OWNER, item.question);
      const record = await runOne(r, seed, item, context, performance.now() - tr);
      if (record.correct) correct++;
      if (!record.error) {
        const note = learnNoteText(item, record.prediction);
        writeNote(scratch.db, note);
        notes.push(note);
      }
    }
    return { notes, seedPass: { items: seedSet.length, correct, notes: notes.length } };
  } finally {
    scratch.close();
  }
}

async function runArmForSeed(
  r: Resolved,
  arm: Arm,
  seed: number,
  evalSet: DatasetItem[],
  corpus: SeedCorpus,
): Promise<{ records: QueryRecord[]; skipped?: string }> {
  if (arm === "bare") {
    const records = await mapPool(evalSet, r.concurrency, (item) =>
      runOne(r, seed, item, { text: "", hits: 0 }, 0),
    );
    return { records };
  }
  if (arm === "fullcontext") {
    const full = buildFullContext(corpus.notes, r.contextBudgetTokens);
    if (full.overBudget) {
      return {
        records: [],
        skipped: `fullcontext corpus is ${full.tokens} tokens > budget ${r.contextBudgetTokens}`,
      };
    }
    const records = await mapPool(evalSet, r.concurrency, (item) =>
      runOne(r, seed, item, { text: full.text, hits: full.hits }, 0),
    );
    return { records };
  }
  const scratch = new ScratchDb(`${arm}${seed}`);
  try {
    if (arm !== "cold") seedNotesInto(scratch.db, corpus.notes);
    if (arm === "bm25") {
      const records = await mapPool(evalSet, r.concurrency, async (item) => {
        const tr = performance.now();
        const context = buildBm25Context(scratch.db, MEMORY_OWNER, item.question, r.topK);
        return runOne(r, seed, item, context, performance.now() - tr);
      });
      return { records };
    }
    // cold / warm — resident path, sequential because learning mutates memory.
    const records: QueryRecord[] = [];
    for (const item of evalSet) {
      const tr = performance.now();
      const context = await buildResidentMemoryContext(scratch.db, MEMORY_OWNER, item.question);
      const record = await runOne(r, seed, item, context, performance.now() - tr);
      records.push(record);
      if (r.learn && !record.error) writeNote(scratch.db, learnNoteText(item, record.prediction));
    }
    return { records };
  } finally {
    scratch.close();
  }
}

function summarize(records: QueryRecord[], perSeed: SeedSummary[], r: Resolved): ArmMetrics {
  const ok = records.filter((x) => !x.error);
  const correct = records.filter((x) => x.correct).length;
  const n = records.length;
  const accs = perSeed.map((s) => s.accuracy);
  const seedMean = mean(accs);
  const seedStd = std(accs);
  const seedHalf = accs.length > 1 ? (1.959963984540054 * seedStd) / Math.sqrt(accs.length) : 0;
  const prompt = ok.map((x) => x.promptTokens).filter((x): x is number => typeof x === "number");
  const completion = ok
    .map((x) => x.completionTokens)
    .filter((x): x is number => typeof x === "number");
  const promptTotal = prompt.reduce((a, b) => a + b, 0);
  const completionTotal = completion.reduce((a, b) => a + b, 0);
  const cost =
    prompt.length > 0 && r.priceIn !== undefined && r.priceOut !== undefined
      ? (promptTotal * r.priceIn + completionTotal * r.priceOut) / 1e6
      : null;
  const pct = (xs: number[]): Percentiles => ({
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
  });
  return {
    n,
    correct,
    errors: records.length - ok.length,
    judgeAccuracy: {
      pooled: n > 0 ? correct / n : 0,
      wilson95: wilson95(correct, n),
      perSeed: accs,
      seedMean,
      seedStd,
      seedCi95: { low: Math.max(0, seedMean - seedHalf), high: Math.min(1, seedMean + seedHalf) },
    },
    tokenF1: { mean: mean(ok.map((x) => x.tokenF1)), perSeed: perSeed.map((s) => s.tokenF1Mean) },
    reachable: (() => {
      const withCeiling = perSeed.filter((s) => s.reachable !== null && s.evalSetSize > 0);
      const evalItems = withCeiling.reduce((acc, s) => acc + s.evalSetSize, 0);
      return evalItems === 0
        ? null
        : withCeiling.reduce((acc, s) => acc + (s.reachable as number) * s.evalSetSize, 0) /
            evalItems;
    })(),
    memoryHitRate: n > 0 ? records.filter((x) => x.memoryHits > 0).length / n : 0,
    injectedTokens: {
      mean: mean(records.map((x) => x.injectedTokens)),
      p95: percentile(
        records.map((x) => x.injectedTokens),
        0.95,
      ),
      max: Math.max(0, ...records.map((x) => x.injectedTokens)),
    },
    injectedChars: {
      mean: mean(records.map((x) => x.injectedChars)),
      p95: percentile(
        records.map((x) => x.injectedChars),
        0.95,
      ),
    },
    promptTokens: prompt.length > 0 ? { mean: mean(prompt), total: promptTotal } : null,
    completionTokens: completion.length > 0 ? { total: completionTotal } : null,
    latencyMs: {
      total: pct(ok.map((x) => x.totalMs)),
      retrieval: pct(ok.map((x) => x.retrievalMs)),
      model: pct(ok.map((x) => x.modelMs)),
    },
    costUsd: cost,
  };
}

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Never overwrite: append `-1`, `-2`, … when a path is taken. */
function freshPath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`);
  return candidate;
}

const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtCi = (ci: Interval) => `[${fmtPct(ci.low)}, ${fmtPct(ci.high)}]`;

export function renderSummaryMarkdown(results: ArmResult[]): string {
  const head = results[0];
  const lines: string[] = [];
  if (head) {
    lines.push(
      `# genbench — ${head.config.dataset} · model=${head.config.model} · judge=${head.config.judge}`,
      "",
      `seeds=${head.config.seeds.join(",")} · split=${head.config.splitMode}/${head.config.splitSalt}/${head.config.seedFraction} · seed-source=${head.config.seedSource} · learn=${head.config.learn} · temperature=${head.config.temperature ?? "provider-default"} · harness=${head.config.harnessGitSha.slice(0, 12)} · context=${head.config.residentContextVersion}`,
      "",
    );
  }
  lines.push(
    "| Arm | Model | n (eval×seeds) | Judge acc | Wilson 95% | Ceiling | Seed-mean ± CI | Token-F1 | Hit rate | Injected tok mean/p95 | Latency p50/p95 ms | Cost USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
    const m = r.metrics;
    if (m.skipped) {
      lines.push(
        `| ${r.config.arm} | ${r.config.model} | 0 | skipped | — | — | — | — | — | — | — | ${m.skipped} |`,
      );
      continue;
    }
    const seedCi = `${fmtPct(m.judgeAccuracy.seedMean)} ± ${fmtPct(m.judgeAccuracy.seedMean - m.judgeAccuracy.seedCi95.low)}`;
    lines.push(
      `| ${r.config.arm} | ${r.config.model} | ${m.n} | ${fmtPct(m.judgeAccuracy.pooled)} | ${fmtCi(m.judgeAccuracy.wilson95)} | ${m.reachable === null ? "n/a" : fmtPct(m.reachable)} | ${seedCi} | ${m.tokenF1.mean.toFixed(3)} | ${fmtPct(m.memoryHitRate)} | ${m.injectedTokens.mean.toFixed(0)}/${m.injectedTokens.p95} | ${m.latencyMs.total.p50.toFixed(1)}/${m.latencyMs.total.p95.toFixed(1)} | ${m.costUsd === null ? "n/a" : m.costUsd.toFixed(4)} |`,
    );
  }
  lines.push(
    "",
    "Injected tokens use the chars/4 heuristic; `promptTokens` in the JSON carries provider-reported usage when a real model ran. Held-out: every scored item is in the eval split; every note came from the seed split or from earlier eval items in the same arm (cold/warm learning). Ceiling = share of eval items whose fact has a seeded paraphrase (the accuracy a perfect memory could reach on this split); n/a for datasets without fact groups.",
  );
  return `${lines.join("\n")}\n`;
}

/** Structural validation of a result file. Returns a list of problems (empty = valid). */
export function validateArmResult(value: unknown): string[] {
  const problems: string[] = [];
  const v = value as Partial<ArmResult> | null;
  if (!v || typeof v !== "object") return ["not an object"];
  if (v.schema !== RESULT_SCHEMA) problems.push(`schema != ${RESULT_SCHEMA}`);
  const c = v.config;
  if (!c) problems.push("missing config");
  else {
    for (const key of [
      "arm",
      "dataset",
      "model",
      "judge",
      "judgePrompt",
      "splitSalt",
      "harnessGitSha",
      "residentContextVersion",
      "seedSource",
      "startedAt",
      "finishedAt",
    ] as const) {
      if (typeof c[key] !== "string") problems.push(`config.${key} must be a string`);
    }
    if (!Array.isArray(c.seeds) || c.seeds.length === 0)
      problems.push("config.seeds must be non-empty");
    if (typeof c.offline !== "boolean") problems.push("config.offline must be boolean");
    if (typeof c.networkAttempts !== "number")
      problems.push("config.networkAttempts must be number");
  }
  const m = v.metrics;
  if (!m) problems.push("missing metrics");
  else {
    if (typeof m.n !== "number") problems.push("metrics.n must be number");
    const ja = m.judgeAccuracy;
    if (!ja || typeof ja.pooled !== "number") problems.push("metrics.judgeAccuracy.pooled missing");
    if (
      !ja?.wilson95 ||
      typeof ja.wilson95.low !== "number" ||
      typeof ja.wilson95.high !== "number"
    )
      problems.push("metrics.judgeAccuracy.wilson95 missing");
    if (!ja?.seedCi95) problems.push("metrics.judgeAccuracy.seedCi95 missing");
    if (!m.tokenF1 || typeof m.tokenF1.mean !== "number") problems.push("metrics.tokenF1 missing");
    if (!m.injectedTokens || typeof m.injectedTokens.p95 !== "number")
      problems.push("metrics.injectedTokens missing");
    if (!m.latencyMs?.total || typeof m.latencyMs.total.p95 !== "number")
      problems.push("metrics.latencyMs missing");
    if (!("costUsd" in m)) problems.push("metrics.costUsd missing");
  }
  if (!Array.isArray(v.perSeed)) problems.push("perSeed must be an array");
  if (!Array.isArray(v.items)) problems.push("items must be an array");
  return problems;
}

/**
 * Run the full protocol. Returns every arm result plus the paths written.
 * Result files are never overwritten; the results directory is gitignored.
 */
export async function runMemoryBenchmark(
  options: MemoryBenchmarkOptions,
): Promise<MemoryBenchmarkReport> {
  const r = resolveOptions(options);
  const guard = r.offline ? installOfflineGuard() : null;
  const log = (line: string) => {
    if (!r.quiet) console.log(line);
  };
  try {
    const items = await loadDataset(r.dataset, options.limit);
    if (items.length < 4)
      throw new Error(`dataset ${r.dataset} has too few items (${items.length})`);
    const sha = gitSha();
    const startedAt = new Date();
    log(
      `genbench · dataset=${r.dataset} (${items.length} items) · model=${r.model.id} · judge=${r.judge.id} · seeds=${r.seeds.join(",")} · arms=${r.arms.join(",")} · offline=${r.offline}`,
    );

    // Per-seed split + seed corpus, shared across arms so controls are matched.
    const splitMode = r.split ?? defaultSplitMode(items);
    const perSeedState = new Map<number, { split: Split<DatasetItem>; corpus: SeedCorpus }>();
    const needsCorpus = r.arms.some((a) => a !== "bare" && a !== "cold");
    for (const seed of r.seeds) {
      const split = splitDataset(items, seed, r.splitSalt, r.seedFraction, splitMode);
      if (split.evalSet.length === 0 || split.seedSet.length === 0) {
        throw new Error(
          `seed ${seed}: degenerate split (${split.seedSet.length}/${split.evalSet.length})`,
        );
      }
      const corpus: SeedCorpus = needsCorpus
        ? await buildSeedCorpus(r, seed, split.seedSet)
        : { notes: [], seedPass: undefined };
      perSeedState.set(seed, { split, corpus });
      log(
        `  seed ${seed}: seed-set=${split.seedSet.length} eval-set=${split.evalSet.length} fingerprint=${split.fingerprint}${split.reachable === null ? "" : ` reachable=${fmtPct(split.reachable)}`}${corpus.seedPass ? ` seed-pass acc=${fmtPct(corpus.seedPass.correct / Math.max(1, corpus.seedPass.items))} notes=${corpus.seedPass.notes}` : ""}`,
      );
    }

    const results: ArmResult[] = [];
    for (const arm of r.arms) {
      const armStart = new Date();
      const t0 = performance.now();
      const records: QueryRecord[] = [];
      const perSeed: SeedSummary[] = [];
      let skipped: string | undefined;
      for (const seed of r.seeds) {
        const state = perSeedState.get(seed);
        if (!state) continue;
        const { split, corpus } = state;
        const out = await runArmForSeed(r, arm, seed, split.evalSet, corpus);
        if (out.skipped) {
          skipped = out.skipped;
          break;
        }
        records.push(...out.records);
        const correct = out.records.filter((x) => x.correct).length;
        perSeed.push({
          seed,
          splitFingerprint: split.fingerprint,
          seedSetSize: split.seedSet.length,
          evalSetSize: split.evalSet.length,
          evalIds: split.evalSet.map((i) => i.id),
          seedIds: split.seedSet.map((i) => i.id),
          n: out.records.length,
          correct,
          accuracy: out.records.length > 0 ? correct / out.records.length : 0,
          tokenF1Mean: mean(out.records.filter((x) => !x.error).map((x) => x.tokenF1)),
          reachable: split.reachable,
          seedPass: arm === "bare" || arm === "cold" ? undefined : corpus.seedPass,
        });
      }
      const metrics = summarize(records, perSeed, r);
      if (skipped) metrics.skipped = skipped;
      const finishedAt = new Date();
      results.push({
        schema: RESULT_SCHEMA,
        config: {
          arm,
          dataset: r.dataset,
          datasetItems: items.length,
          model: r.model.id,
          judge: r.judge.id,
          judgePrompt: r.judge.prompt,
          seeds: r.seeds,
          splitSalt: r.splitSalt,
          seedFraction: r.seedFraction,
          splitMode,
          seedSource: r.seedSource,
          learn: r.learn,
          topK: r.topK,
          contextBudgetTokens: r.contextBudgetTokens,
          endpoint: r.endpoint,
          temperature: r.temperature,
          harnessGitSha: sha,
          residentContextVersion: RESIDENT_CONTEXT_VERSION,
          memoryOwner: MEMORY_OWNER,
          offline: r.offline,
          networkAttempts: guard?.attempts() ?? 0,
          startedAt: armStart.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: performance.now() - t0,
        },
        metrics,
        perSeed,
        items: records,
      });
      log(
        `  ${arm.padEnd(11)} acc=${fmtPct(metrics.judgeAccuracy.pooled)} ${fmtCi(metrics.judgeAccuracy.wilson95)}${metrics.reachable === null ? "" : ` ceiling=${fmtPct(metrics.reachable)}`} f1=${metrics.tokenF1.mean.toFixed(3)} hits=${fmtPct(metrics.memoryHitRate)} inj=${metrics.injectedTokens.mean.toFixed(0)}tok${skipped ? ` SKIPPED: ${skipped}` : ""}`,
      );
    }

    // Persist — one file per arm plus a markdown summary, never overwriting.
    mkdirSync(r.resultsDir, { recursive: true });
    const stamp = timestamp(startedAt);
    const files: string[] = [];
    for (const result of results) {
      const path = freshPath(
        r.resultsDir,
        `${stamp}-${result.config.arm}-${slug(r.model.id)}`,
        ".json",
      );
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      files.push(path);
    }
    const summaryMarkdown = renderSummaryMarkdown(results);
    const summaryPath = freshPath(r.resultsDir, `${stamp}-summary-${slug(r.model.id)}`, ".md");
    writeFileSync(summaryPath, summaryMarkdown);
    log(`\n${summaryMarkdown}`);
    log(`Results: ${files.length} arm file(s) + summary in ${r.resultsDir}`);
    return {
      results,
      files,
      summaryPath,
      summaryMarkdown,
      networkAttempts: guard?.attempts() ?? 0,
    };
  } finally {
    guard?.restore();
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `genbench — Marina memory-delta benchmark (Phase 1.7)

Usage:
  bun --env-file=/dev/null run benchmarks/memory/genbench.ts [options]

Options:
  --dataset <name>        synthetic-v1 (default, offline) | ${Object.keys(DATASET_LOADERS).join(" | ")}
  --arms <a,b,..>         subset of: ${ARMS.join(", ")} (default: all)
  --model <id>            stub (default) | any model id routed via --endpoint (e.g. marina/default)
  --judge <id>            stub (default, exact-match) | model id for the LLM judge
  --seeds <n>             number of seeds (default 5; standard requires >=5)
  --seed-start <n>        first seed (default 1)
  --limit <n>             cap items before the split
  --split-salt <s>        salt for the seed/eval hash (default v1)
  --split <mode>          item | paraphrase (default: paraphrase when every item has metadata.factId, else item)
  --seed-fraction <f>     fraction of items in the seed set (default 0.5)
  --seed-source <m>       model (default: warm holds what the model learned) | gold (oracle ceiling)
  --top-k <n>             bm25 control top-k (default 5)
  --context-budget <n>    fullcontext budget in tokens (default 8000)
  --no-learn              disable within-run learning in cold/warm
  --endpoint <url>        Marina OpenAI-compatible endpoint (default http://localhost:3300)
  --api-key <key>         bearer for --endpoint (or MARINA_API_KEY / MODEL_API_KEY)
  --judge-endpoint <url>  endpoint for the LLM judge (default: --endpoint)
  --price-in <usd/M>      input price per million tokens (enables cost estimate)
  --price-out <usd/M>     output price per million tokens
  --temperature <n|none>  sampling temperature for model + judge (default none = provider default;
                          Claude 5 rejects an explicit value, GPT-5 reasoning models ignore it)
  --results-dir <dir>     default benchmarks/results/memory (gitignored)
  --concurrency <n>       workers for non-mutating arms (default 4 for real models, 1 for stub)
  --online                allow network even with stub model+judge (default: offline when both stub)
  --quiet
  --help
`;

export async function runCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: "string", default: "synthetic-v1" },
      arms: { type: "string", default: ARMS.join(",") },
      model: { type: "string", default: "stub" },
      judge: { type: "string", default: "stub" },
      seeds: { type: "string", default: "5" },
      "seed-start": { type: "string", default: "1" },
      limit: { type: "string" },
      "split-salt": { type: "string", default: "v1" },
      split: { type: "string" },
      "seed-fraction": { type: "string", default: "0.5" },
      "seed-source": { type: "string", default: "model" },
      "top-k": { type: "string", default: "5" },
      "context-budget": { type: "string", default: "8000" },
      "no-learn": { type: "boolean", default: false },
      endpoint: { type: "string" },
      "api-key": { type: "string" },
      "judge-endpoint": { type: "string" },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
      "results-dir": { type: "string" },
      temperature: { type: "string" },
      concurrency: { type: "string" },
      online: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const seedSource = values["seed-source"];
  if (seedSource !== "model" && seedSource !== "gold") {
    console.error(`--seed-source must be model|gold (got ${seedSource})`);
    return 2;
  }
  const arms = (values.arms ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean) as Arm[];
  const report = await runMemoryBenchmark({
    dataset: values.dataset ?? "synthetic-v1",
    arms,
    model: values.model ?? "stub",
    judge: values.judge ?? "stub",
    seeds: Number(values.seeds ?? "5"),
    seedStart: Number(values["seed-start"] ?? "1"),
    limit: num(values.limit),
    splitSalt: values["split-salt"],
    split: values.split === "item" || values.split === "paraphrase" ? values.split : undefined,
    seedFraction: Number(values["seed-fraction"] ?? "0.5"),
    seedSource,
    topK: Number(values["top-k"] ?? "5"),
    contextBudgetTokens: Number(values["context-budget"] ?? "8000"),
    learn: !values["no-learn"],
    endpoint: values.endpoint,
    apiKey: values["api-key"],
    judgeEndpoint: values["judge-endpoint"],
    priceInPerMillion: num(values["price-in"]),
    priceOutPerMillion: num(values["price-out"]),
    resultsDir: values["results-dir"],
    temperature:
      values.temperature === undefined || values.temperature === "none"
        ? null
        : Number(values.temperature),
    concurrency: num(values.concurrency),
    offline: values.online ? false : undefined,
    quiet: values.quiet,
  });
  return report.results.some((r) => r.metrics.errors > 0) ? 1 : 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`genbench failed: ${error instanceof Error ? error.message : error}`);
      process.exit(2);
    },
  );
}
