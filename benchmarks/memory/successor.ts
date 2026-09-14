#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * successor — the cold-start / generational-transmission benchmark (Tier 4,
 * Phase 3.7 scaffold).
 *
 * genbench asks "does memory help the SAME agent?". This harness asks the
 * generational question Marina's memory architecture is actually built for:
 *
 *   1. **Cold start.** A fresh account that INHERITS a predecessor's shared
 *      pool versus a fresh account that does not — on the predecessor's
 *      synthetic domain, how quickly does each reach its first correct
 *      answer, and how many of the first k tasks does it get right?
 *   2. **Transmission fidelity.** When the inherited lessons are re-summarised
 *      by successive generations (each generation summarises what it
 *      inherited and hands the summary on), how many of the original facts
 *      survive k re-summarisations?
 *
 * Both arms read through the SAME resident read path a real successor uses
 * for shared knowledge — `gatherRetrievalContext` (the `recap` / `ask` / `dig`
 * core: personal notes + the platform guide pool + shared pools, with the
 * group-pool membership guard). Inheritance is a shared pool the predecessor
 * deposited into (the `inheritance export/import` bundle is the portable form
 * of the same thing; it is capped at 12 artifacts per token, so the benchmark
 * seeds the pool directly and records that choice in `config`).
 *
 * Everything is deterministic and offline with `--model stub`: the stub
 * answering model, the exact-match judge and the split/CI utilities are
 * genbench's, so the two harnesses cannot drift apart in their scoring rules.
 * The stub *summariser* is a lossy, deterministic digest (top-N by importance
 * within a byte budget that shrinks per generation) — a plumbing stand-in
 * that exercises the fidelity metric, not a claim about any model's
 * summarisation. Fact retention is judged EMBEDDING-FREE: a fact is retained
 * when its normalized gold answer is contained in the generation's digest.
 *
 * Nothing here ever calls a paid model unless you name one.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gatherRetrievalContext } from "../../src/engine/commands/retrieval-core";
import { MarinaDB } from "../../src/persistence/database";
import type { EntityId } from "../../src/types";
import type { DatasetItem } from "../types";
import {
  createRemoteModel,
  createStubModel,
  defaultSplitMode,
  estimateTokens,
  exactMatchJudge,
  goldText,
  type Interval,
  learnNoteText,
  loadSyntheticItems,
  normalizeAnswer,
  type SplitMode,
  splitDataset,
  stableHash,
  stubKnows,
  tokenF1,
  wilson95,
} from "./genbench";

// ─── Public constants ───────────────────────────────────────────────────────

export const SUCCESSOR_RESULT_SCHEMA = "marina.memory.successor.v1" as const;
export const SUCCESSOR_KIND = "successor" as const;
export const SUCCESSOR_ARMS = ["fresh", "inherit"] as const;
export type SuccessorArm = (typeof SUCCESSOR_ARMS)[number];

/** Names of the accounts the harness plays. */
export const PREDECESSOR_NAME = "Predecessor";
export const SUCCESSOR_NAME = "Successor";
/** The shared pool the predecessor deposits into and the inheriting successor reads. */
export const INHERITANCE_POOL = "tradition:predecessor";

/** Identifies the shared-read path in force; bump when it changes. */
export const SUCCESSOR_CONTEXT_VERSION =
  "successor-v1:gatherRetrievalContext(personal+guide+pools)";

/** Byte budget the generation-0 digest may use; each generation keeps this fraction of the previous. */
export const FIDELITY_BUDGET_BYTES = 2048;
export const FIDELITY_BUDGET_DECAY = 0.7;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SuccessorOptions {
  /** `stub` or an OpenAI-compatible model id routed through `endpoint`. */
  model: string;
  /** Number of seeds (≥1). */
  seeds: number;
  seedStart?: number;
  /** Cap on items before the split. */
  limit?: number;
  splitSalt?: string;
  /** `paraphrase` (default: one paraphrase of every fact held out, its sibling learned) | `item`. */
  split?: SplitMode;
  /** Fraction of items the predecessor learns (rest is the successor's task stream). */
  seedFraction?: number;
  /** k for first-k success. Default 5. */
  firstK?: number;
  /** Re-summarisation generations for fidelity. Default 3. */
  generations?: number;
  /** Successor learns a Q/A note after every answer. Default true. */
  learn?: boolean;
  endpoint?: string;
  apiKey?: string;
  /** `model` (default for a real model: the answering model re-summarises) or `stub` (truncating digest). */
  summarizer?: "model" | "stub";
  resultsDir?: string;
  /** Refuse all network. Default: true iff model is `stub`. */
  offline?: boolean;
  quiet?: boolean;
  requestTimeoutMs?: number;
  /** Sampling temperature; `null` (default) omits it so the provider default applies. */
  temperature?: number | null;
}

export interface SuccessorQueryRecord {
  seed: number;
  arm: SuccessorArm;
  /** 1-based position in the successor's task stream. */
  position: number;
  id: string;
  question: string;
  expected: string;
  prediction: string;
  correct: boolean;
  /** Correct AND not in the stub's known subset — memory transfer, not prior knowledge. */
  transfer: boolean;
  tokenF1: number;
  memoryHits: number;
  inheritedHits: number;
  injectedChars: number;
  injectedTokens: number;
  retrievalMs: number;
  modelMs: number;
  error?: string;
}

export interface SuccessorSeedSummary {
  seed: number;
  arm: SuccessorArm;
  splitFingerprint: string;
  /** Transfer ceiling of this seed's split (share of tasks whose fact the predecessor learned). */
  reachable: number | null;
  predecessorNotes: number;
  n: number;
  correct: number;
  accuracy: number;
  /** 1-based index of the first correct answer; null when none. */
  timeToFirstCorrect: number | null;
  /** 1-based index of the first correct answer the stub did not already know; null when none. */
  timeToFirstTransfer: number | null;
  /** Correct answers among the first k tasks. */
  firstK: { k: number; correct: number; rate: number };
}

export interface SuccessorArmMetrics {
  arm: SuccessorArm;
  n: number;
  correct: number;
  errors: number;
  accuracy: { pooled: number; wilson95: Interval; perSeed: number[] };
  /** Mean over seeds that reached a first correct answer; null when none did. */
  timeToFirstCorrect: { mean: number | null; perSeed: (number | null)[] };
  timeToFirstTransfer: { mean: number | null; perSeed: (number | null)[] };
  firstK: { k: number; pooled: number; wilson95: Interval; perSeed: number[] };
  transferRate: number;
  memoryHitRate: number;
  inheritedHitRate: number;
  injectedTokens: { mean: number; max: number };
  tokenF1: { mean: number };
}

export interface FidelityGeneration {
  generation: number;
  budgetBytes: number;
  digestBytes: number;
  /** Facts whose gold answer survives in this generation's digest. */
  retained: number;
  total: number;
  retention: number;
}

export interface SuccessorFidelity {
  generations: number;
  judge: "exact-match-containment";
  summarizer: string;
  perSeed: { seed: number; chain: FidelityGeneration[] }[];
  /** Mean retention per generation across seeds (index = generation). */
  meanRetention: number[];
}

export interface SuccessorConfig {
  kind: typeof SUCCESSOR_KIND;
  dataset: "synthetic-v1";
  datasetItems: number;
  model: string;
  judge: "stub";
  seeds: number[];
  splitSalt: string;
  splitMode: SplitMode;
  seedFraction: number;
  firstK: number;
  generations: number;
  learn: boolean;
  inheritance: "shared-pool";
  inheritancePool: string;
  contextVersion: string;
  endpoint: string | null;
  harnessGitSha: string;
  offline: boolean;
  networkAttempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface SuccessorResult {
  schema: typeof SUCCESSOR_RESULT_SCHEMA;
  config: SuccessorConfig;
  arms: Record<SuccessorArm, SuccessorArmMetrics>;
  /** inherit − fresh on the headline numbers. */
  delta: {
    accuracy: number;
    firstK: number;
    timeToFirstCorrect: number | null;
    timeToFirstTransfer: number | null;
  };
  fidelity: SuccessorFidelity;
  perSeed: SuccessorSeedSummary[];
  items: SuccessorQueryRecord[];
}

export interface SuccessorReport {
  result: SuccessorResult;
  file: string | null;
  summaryPath: string | null;
  summaryMarkdown: string;
  networkAttempts: number;
}

// ─── Summariser (fidelity) ──────────────────────────────────────────────────

export interface Summarizer {
  id: string;
  /** Produce the next generation's digest from what this generation inherited. */
  summarize(inherited: readonly string[], budgetBytes: number): Promise<string>;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/**
 * Deterministic lossy digest: keep lines in a seed-stable order until the
 * byte budget is exhausted. Lines are never rewritten, so a retained fact is
 * retained verbatim and a dropped fact is gone — exactly the failure mode
 * re-summarisation has in practice, minus paraphrase drift (which needs a
 * real model to study).
 */
export function createStubSummarizer(): Summarizer {
  return {
    id: "stub-truncating-digest",
    async summarize(inherited, budgetBytes) {
      const ordered = [...inherited].sort(
        (a, b) => stableHash(`digest:${a}`) - stableHash(`digest:${b}`) || a.localeCompare(b),
      );
      const kept: string[] = [];
      let used = 0;
      for (const line of ordered) {
        const size = bytes(line) + 1;
        if (used + size > budgetBytes) continue;
        kept.push(line);
        used += size;
      }
      return kept.join("\n");
    },
  };
}

/**
 * Model-backed summariser: the answering model rewrites what a generation
 * inherited into a digest that must fit the byte budget, with an explicit
 * instruction to keep every distinct fact and its exact values. Anything over
 * budget is hard-truncated (a real successor's context is finite too), so a
 * verbose model loses facts exactly the way an over-long handover would. This
 * is the paraphrase-drift condition the stub cannot study.
 */
export function createModelSummarizer(model: AnsweringModel): Summarizer {
  return {
    id: `model-digest:${model.id}`,
    async summarize(inherited, budgetBytes) {
      if (inherited.length === 0) return "";
      const messages = [
        {
          role: "system" as const,
          content:
            "You are handing your knowledge to a successor who will never see the original notes. " +
            `Rewrite the lessons below into a compact digest of at most ${budgetBytes} characters. ` +
            "Keep every distinct fact with its exact names, numbers and units; merge duplicates; " +
            "drop only what the limit forces you to drop. Output the digest only, one fact per line.",
        },
        { role: "user" as const, content: inherited.join("\n") },
      ];
      const reply = await model.answer(
        messages,
        { id: "summarize", question: "", answer: "", category: "synthetic" } as DatasetItem,
        "",
      );
      let digest = reply.text.trim();
      while (bytes(digest) > budgetBytes) digest = digest.slice(0, -1);
      return digest;
    },
  };
}

/** Embedding-free retention: the fact survives when its normalized answer is in the digest. */
export function factsRetained(digest: string, facts: readonly DatasetItem[]): number {
  const haystack = ` ${normalizeAnswer(digest)} `;
  let retained = 0;
  for (const fact of facts) {
    const needle = normalizeAnswer(goldText(fact));
    if (needle.length > 0 && haystack.includes(` ${needle} `)) retained++;
  }
  return retained;
}

/** Run the k-generation re-summarisation chain over the predecessor's lessons. */
export async function fidelityChain(
  summarizer: Summarizer,
  lessons: readonly string[],
  facts: readonly DatasetItem[],
  generations: number,
  budgetBytes = FIDELITY_BUDGET_BYTES,
  decay = FIDELITY_BUDGET_DECAY,
): Promise<FidelityGeneration[]> {
  const chain: FidelityGeneration[] = [];
  const total = facts.length;
  const gen0 = lessons.join("\n");
  chain.push({
    generation: 0,
    budgetBytes: bytes(gen0),
    digestBytes: bytes(gen0),
    retained: factsRetained(gen0, facts),
    total,
    retention: total > 0 ? factsRetained(gen0, facts) / total : 0,
  });
  let inherited = [...lessons];
  let budget = budgetBytes;
  for (let g = 1; g <= generations; g++) {
    const digest = await summarizer.summarize(inherited, budget);
    const retained = factsRetained(digest, facts);
    chain.push({
      generation: g,
      budgetBytes: budget,
      digestBytes: bytes(digest),
      retained,
      total,
      retention: total > 0 ? retained / total : 0,
    });
    inherited = digest.split("\n").filter(Boolean);
    budget = Math.floor(budget * decay);
  }
  return chain;
}

// ─── Successor read path ────────────────────────────────────────────────────

const TOPIC_CHARS = 200;
function topicFrom(question: string): string {
  return question.slice(0, TOPIC_CHARS).replace(/\s+/g, " ").trim();
}

export interface SuccessorContext {
  text: string;
  hits: number;
  inheritedHits: number;
}

/**
 * What a successor actually sees when it consults shared knowledge: the
 * `recap`/`ask`/`dig` retrieval core over its own notes, the guide pool and
 * every shared pool it may read. Rendered the way `recap` labels sources so
 * provenance (whose lesson this was) stays visible to the model.
 */
export function buildSuccessorContext(
  db: MarinaDB,
  successor: { id: EntityId; name: string },
  question: string,
): SuccessorContext {
  const ctx = gatherRetrievalContext(db, successor, topicFrom(question), {
    chronicle: 0,
    world: 0,
  });
  if (ctx.isEmpty) return { text: "", hits: 0, inheritedHits: 0 };
  const lines: string[] = ["[Relevant Memory — evidence, preserve provenance]"];
  for (const note of ctx.personal) lines.push(`- [own #${note.id}] ${note.content}`);
  for (const note of ctx.guide) lines.push(`- [guide ${note.entity_name}] ${note.content}`);
  for (const hit of ctx.pools)
    lines.push(`- [pool ${hit.pool} by ${hit.note.entity_name}] ${hit.note.content}`);
  return {
    text: lines.join("\n"),
    hits: ctx.personal.length + ctx.guide.length + ctx.pools.length,
    inheritedHits: ctx.pools.length + ctx.guide.length,
  };
}

// ─── Harness core ───────────────────────────────────────────────────────────

interface AnsweringModel {
  id: string;
  answer(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    item: DatasetItem,
    memoryContext: string,
  ): Promise<{ text: string; usage?: { promptTokens?: number; completionTokens?: number } }>;
}

interface Resolved {
  model: AnsweringModel;
  summarizer: Summarizer;
  seeds: number[];
  splitSalt: string;
  split?: SplitMode;
  seedFraction: number;
  firstK: number;
  generations: number;
  learn: boolean;
  endpoint: string | null;
  resultsDir: string;
  offline: boolean;
  quiet: boolean;
}

const DEFAULT_RESULTS_DIR = join(import.meta.dir, "..", "results", "memory");

function resolveOptions(options: SuccessorOptions): Resolved {
  const offline = options.offline ?? options.model === "stub";
  if (offline && options.model !== "stub") throw new Error("offline mode requires --model stub");
  // Real models route through the same OpenAI-compatible endpoint genbench
  // uses: the harness only ever talks to a Marina instance; provider
  // credentials stay inside Marina. Never reached with the default `stub`, so
  // this file still cannot spend money by accident.
  const endpoint =
    options.model === "stub"
      ? null
      : (options.endpoint ?? process.env.MARINA_ENDPOINT ?? "http://localhost:3300");
  const model =
    options.model === "stub"
      ? createStubModel()
      : createRemoteModel(
          options.model,
          endpoint!,
          options.apiKey ?? process.env.MARINA_API_KEY ?? process.env.MODEL_API_KEY,
          options.requestTimeoutMs ?? 120_000,
          options.temperature ?? null,
        );
  const summarizerKind = options.summarizer ?? (options.model === "stub" ? "stub" : "model");
  if (summarizerKind === "model" && options.model === "stub")
    throw new Error("--summarizer model needs a real --model");
  const seeds = Array.from(
    { length: Math.max(1, options.seeds) },
    (_, i) => (options.seedStart ?? 1) + i,
  );
  return {
    model,
    summarizer: summarizerKind === "model" ? createModelSummarizer(model) : createStubSummarizer(),
    seeds,
    splitSalt: options.splitSalt ?? "v1",
    split: options.split,
    seedFraction: options.seedFraction ?? 0.5,
    firstK: Math.max(1, options.firstK ?? 5),
    generations: Math.max(1, options.generations ?? 3),
    learn: options.learn ?? true,
    endpoint,
    resultsDir: options.resultsDir ?? DEFAULT_RESULTS_DIR,
    offline,
    quiet: options.quiet ?? false,
  };
}

function installOfflineGuard(): { attempts: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let attempts = 0;
  const refuse = async (input: RequestInfo | URL) => {
    attempts++;
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`successor offline mode refused network access to ${target}`);
  };
  globalThis.fetch = Object.assign(refuse, { preconnect: original.preconnect }) as typeof fetch;
  return {
    attempts: () => attempts,
    restore: () => {
      globalThis.fetch = original;
    },
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
    this.dir = mkdtempSync(join(tmpdir(), `successor-${label}-`));
    this.db = new MarinaDB(join(this.dir, "memory.db"));
  }
  close(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The predecessor's lessons — one `Q: … | A: <gold>` line per fact it learned. */
export function predecessorLessons(seedSet: readonly DatasetItem[]): string[] {
  // One lesson per fact, not per paraphrase: the predecessor learned the fact.
  const byFact = new Map<string, DatasetItem>();
  for (const item of seedSet) {
    const factId = String(item.metadata?.factId ?? item.id);
    if (!byFact.has(factId)) byFact.set(factId, item);
  }
  return [...byFact.values()].map((item) => learnNoteText(item, goldText(item)));
}

/** Seed one scratch world: users for both accounts; the inheritance pool only in the inherit arm. */
function seedWorld(db: MarinaDB, arm: SuccessorArm, lessons: readonly string[]): number {
  db.createUser({ id: `u_${PREDECESSOR_NAME.toLowerCase()}`, name: PREDECESSOR_NAME });
  db.createUser({ id: `u_${SUCCESSOR_NAME.toLowerCase()}`, name: SUCCESSOR_NAME });
  if (arm !== "inherit") return 0;
  db.createMemoryPool("pool_inheritance", INHERITANCE_POOL, PREDECESSOR_NAME);
  let deposited = 0;
  for (const lesson of lessons) {
    // Reflection tier: this is a lesson handed on, and the read path pays the
    // predecessor when the successor recalls it (generational credit).
    db.addPoolNote("pool_inheritance", PREDECESSOR_NAME, lesson, 7, "episode", {
      tier: "reflection",
    });
    deposited++;
  }
  return deposited;
}

async function runSuccessorArm(
  r: Resolved,
  arm: SuccessorArm,
  seed: number,
  evalSet: readonly DatasetItem[],
  lessons: readonly string[],
  fingerprint: string,
): Promise<{ records: SuccessorQueryRecord[]; summary: SuccessorSeedSummary }> {
  const scratch = new ScratchDb(`${arm}${seed}`);
  try {
    const deposited = seedWorld(scratch.db, arm, lessons);
    const successor = { id: "e_successor" as EntityId, name: SUCCESSOR_NAME };
    const records: SuccessorQueryRecord[] = [];
    let position = 0;
    for (const item of evalSet) {
      position++;
      const tr = performance.now();
      const context = buildSuccessorContext(scratch.db, successor, item.question);
      const retrievalMs = performance.now() - tr;
      const messages = [
        { role: "system" as const, content: "Answer concisely with just the answer." },
        ...(context.text ? [{ role: "system" as const, content: context.text }] : []),
        { role: "user" as const, content: item.question },
      ];
      let prediction = "";
      let error: string | undefined;
      let modelMs = 0;
      let correct = false;
      try {
        const tm = performance.now();
        const reply = await r.model.answer(messages, item, context.text);
        modelMs = performance.now() - tm;
        prediction = reply.text;
        correct = exactMatchJudge(prediction, item);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        prediction = prediction || `ERROR: ${error}`;
      }
      records.push({
        seed,
        arm,
        position,
        id: item.id,
        question: item.question,
        expected: item.answer,
        prediction: prediction.slice(0, 500),
        correct,
        // Stub: correct AND outside its fixed "known" subset. Real model: the
        // facts are fictional (no model can know them), so every correct
        // answer is transfer; the `fresh` arm's accuracy is the empirical prior.
        transfer: correct && (r.model.id === "stub" ? !stubKnows(item.id) : true),
        tokenF1: error ? 0 : tokenF1(prediction, goldText(item)),
        memoryHits: context.hits,
        inheritedHits: context.inheritedHits,
        injectedChars: context.text.length,
        injectedTokens: estimateTokens(context.text),
        retrievalMs,
        modelMs,
        error,
      });
      if (r.learn && !error) {
        scratch.db.createNote(SUCCESSOR_NAME, learnNoteText(item, prediction), undefined, {
          noteType: "fact",
          tier: "fact",
        });
      }
    }
    const correct = records.filter((x) => x.correct).length;
    const firstCorrect = records.find((x) => x.correct)?.position ?? null;
    const firstTransfer = records.find((x) => x.transfer)?.position ?? null;
    const head = records.slice(0, r.firstK);
    const headCorrect = head.filter((x) => x.correct).length;
    return {
      records,
      summary: {
        seed,
        arm,
        splitFingerprint: fingerprint,
        reachable: null,
        predecessorNotes: deposited,
        n: records.length,
        correct,
        accuracy: records.length > 0 ? correct / records.length : 0,
        timeToFirstCorrect: firstCorrect,
        timeToFirstTransfer: firstTransfer,
        firstK: {
          k: r.firstK,
          correct: headCorrect,
          rate: head.length > 0 ? headCorrect / head.length : 0,
        },
      },
    };
  } finally {
    scratch.close();
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function meanOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : mean(present);
}

function summarizeArm(
  arm: SuccessorArm,
  records: SuccessorQueryRecord[],
  perSeed: SuccessorSeedSummary[],
  firstK: number,
): SuccessorArmMetrics {
  const ok = records.filter((x) => !x.error);
  const correct = records.filter((x) => x.correct).length;
  const n = records.length;
  const headTotal = perSeed.reduce((sum, s) => sum + Math.min(firstK, s.n), 0);
  const headCorrect = perSeed.reduce((sum, s) => sum + s.firstK.correct, 0);
  return {
    arm,
    n,
    correct,
    errors: n - ok.length,
    accuracy: {
      pooled: n > 0 ? correct / n : 0,
      wilson95: wilson95(correct, n),
      perSeed: perSeed.map((s) => s.accuracy),
    },
    timeToFirstCorrect: {
      mean: meanOrNull(perSeed.map((s) => s.timeToFirstCorrect)),
      perSeed: perSeed.map((s) => s.timeToFirstCorrect),
    },
    timeToFirstTransfer: {
      mean: meanOrNull(perSeed.map((s) => s.timeToFirstTransfer)),
      perSeed: perSeed.map((s) => s.timeToFirstTransfer),
    },
    firstK: {
      k: firstK,
      pooled: headTotal > 0 ? headCorrect / headTotal : 0,
      wilson95: wilson95(headCorrect, headTotal),
      perSeed: perSeed.map((s) => s.firstK.rate),
    },
    transferRate: n > 0 ? records.filter((x) => x.transfer).length / n : 0,
    memoryHitRate: n > 0 ? records.filter((x) => x.memoryHits > 0).length / n : 0,
    inheritedHitRate: n > 0 ? records.filter((x) => x.inheritedHits > 0).length / n : 0,
    injectedTokens: {
      mean: mean(records.map((x) => x.injectedTokens)),
      max: Math.max(0, ...records.map((x) => x.injectedTokens)),
    },
    tokenF1: { mean: mean(ok.map((x) => x.tokenF1)) },
  };
}

// ─── Output ─────────────────────────────────────────────────────────────────

const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtCi = (ci: Interval) => `[${fmtPct(ci.low)}, ${fmtPct(ci.high)}]`;
const fmtPos = (x: number | null) => (x === null ? "never" : x.toFixed(1));

export function renderSuccessorMarkdown(result: SuccessorResult): string {
  const c = result.config;
  const lines = [
    `# successor — cold start + transmission fidelity · model=${c.model} · judge=${c.judge}`,
    "",
    `seeds=${c.seeds.join(",")} · split=${c.splitSalt}/${c.seedFraction} · k=${c.firstK} · generations=${c.generations} · inheritance=${c.inheritance} (${c.inheritancePool}) · harness=${c.harnessGitSha.slice(0, 12)} · context=${c.contextVersion}`,
    "",
    "| Arm | n | Accuracy | Wilson 95% | First-k success | Time to first correct | Time to first transfer | Transfer rate | Inherited hit rate | Injected tok mean |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of SUCCESSOR_ARMS) {
    const m = result.arms[arm];
    lines.push(
      `| ${arm} | ${m.n} | ${fmtPct(m.accuracy.pooled)} | ${fmtCi(m.accuracy.wilson95)} | ${fmtPct(m.firstK.pooled)} ${fmtCi(m.firstK.wilson95)} | ${fmtPos(m.timeToFirstCorrect.mean)} | ${fmtPos(m.timeToFirstTransfer.mean)} | ${fmtPct(m.transferRate)} | ${fmtPct(m.inheritedHitRate)} | ${m.injectedTokens.mean.toFixed(0)} |`,
    );
  }
  lines.push(
    "",
    `Δ inherit − fresh: accuracy ${fmtPct(result.delta.accuracy)} · first-k ${fmtPct(result.delta.firstK)} · time-to-first-correct ${result.delta.timeToFirstCorrect === null ? "n/a" : result.delta.timeToFirstCorrect.toFixed(1)} · time-to-first-transfer ${result.delta.timeToFirstTransfer === null ? "n/a" : result.delta.timeToFirstTransfer.toFixed(1)}`,
    "",
    `## Transmission fidelity (${result.fidelity.summarizer}, ${result.fidelity.judge})`,
    "",
    "| Generation | Mean retention |",
    "|---|---|",
    ...result.fidelity.meanRetention.map((r, g) => `| ${g} | ${fmtPct(r)} |`),
    "",
    result.config.model === "stub"
      ? "Stub-model numbers are plumbing checks, not evidence about any real model. Retention is exact-match containment of the gold answer in each generation's digest (embedding-free); the stub summariser drops whole lines under a shrinking byte budget and never paraphrases."
      : `Real-model run (${result.config.model}; summariser ${result.fidelity.summarizer}). Retention is exact-match containment of the gold answer in each generation's digest (embedding-free), so a paraphrased value that changes units or wording counts as lost — a conservative bound on transmission fidelity.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Structural validation of a result. Returns a list of problems (empty = valid). */
export function validateSuccessorResult(value: unknown): string[] {
  const problems: string[] = [];
  const v = value as Partial<SuccessorResult> | null;
  if (!v || typeof v !== "object") return ["not an object"];
  if (v.schema !== SUCCESSOR_RESULT_SCHEMA) problems.push(`schema != ${SUCCESSOR_RESULT_SCHEMA}`);
  const c = v.config;
  if (!c) problems.push("missing config");
  else {
    if (c.kind !== SUCCESSOR_KIND) problems.push(`config.kind != ${SUCCESSOR_KIND}`);
    for (const key of [
      "model",
      "judge",
      "splitSalt",
      "harnessGitSha",
      "contextVersion",
      "inheritancePool",
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
  for (const arm of SUCCESSOR_ARMS) {
    const m = v.arms?.[arm];
    if (!m) {
      problems.push(`missing arms.${arm}`);
      continue;
    }
    if (typeof m.n !== "number") problems.push(`arms.${arm}.n must be number`);
    if (!m.accuracy?.wilson95) problems.push(`arms.${arm}.accuracy.wilson95 missing`);
    if (!m.firstK || typeof m.firstK.k !== "number") problems.push(`arms.${arm}.firstK missing`);
    if (!m.timeToFirstCorrect || !("mean" in m.timeToFirstCorrect))
      problems.push(`arms.${arm}.timeToFirstCorrect missing`);
  }
  if (!v.fidelity || !Array.isArray(v.fidelity.meanRetention))
    problems.push("fidelity.meanRetention missing");
  if (!Array.isArray(v.perSeed)) problems.push("perSeed must be an array");
  if (!Array.isArray(v.items)) problems.push("items must be an array");
  return problems;
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
function freshPath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`);
  return candidate;
}

/** Run the whole protocol. Writes one JSON + one markdown summary (never overwriting). */
export async function runSuccessorBenchmark(options: SuccessorOptions): Promise<SuccessorReport> {
  const r = resolveOptions(options);
  const guard = r.offline ? installOfflineGuard() : null;
  const log = (line: string) => {
    if (!r.quiet) console.log(line);
  };
  try {
    const all = loadSyntheticItems();
    const items = options.limit ? all.slice(0, options.limit) : all;
    if (items.length < 4) throw new Error(`too few items (${items.length})`);
    const startedAt = new Date();
    const t0 = performance.now();
    log(
      `successor · items=${items.length} · model=${r.model.id} · seeds=${r.seeds.join(",")} · k=${r.firstK} · generations=${r.generations} · offline=${r.offline}`,
    );
    const records: SuccessorQueryRecord[] = [];
    const perSeed: SuccessorSeedSummary[] = [];
    const fidelityPerSeed: SuccessorFidelity["perSeed"] = [];
    const splitMode = r.split ?? defaultSplitMode(items);
    for (const seed of r.seeds) {
      const split = splitDataset(items, seed, r.splitSalt, r.seedFraction, splitMode);
      if (split.seedSet.length === 0 || split.evalSet.length === 0)
        throw new Error(`seed ${seed}: degenerate split`);
      const lessons = predecessorLessons(split.seedSet);
      for (const arm of SUCCESSOR_ARMS) {
        const out = await runSuccessorArm(r, arm, seed, split.evalSet, lessons, split.fingerprint);
        records.push(...out.records);
        perSeed.push({ ...out.summary, reachable: split.reachable });
        log(
          `  seed ${seed} ${arm.padEnd(7)} acc=${fmtPct(out.summary.accuracy)} first-${r.firstK}=${out.summary.firstK.correct}/${Math.min(r.firstK, out.summary.n)} ttfc=${fmtPos(out.summary.timeToFirstCorrect)} ttft=${fmtPos(out.summary.timeToFirstTransfer)}`,
        );
      }
      // Fidelity is judged against the facts the predecessor actually learned.
      const chain = await fidelityChain(r.summarizer, lessons, split.seedSet, r.generations);
      fidelityPerSeed.push({ seed, chain });
      log(`  seed ${seed} fidelity ${chain.map((g) => fmtPct(g.retention)).join(" → ")}`);
    }
    const arms = Object.fromEntries(
      SUCCESSOR_ARMS.map((arm) => [
        arm,
        summarizeArm(
          arm,
          records.filter((x) => x.arm === arm),
          perSeed.filter((s) => s.arm === arm),
          r.firstK,
        ),
      ]),
    ) as Record<SuccessorArm, SuccessorArmMetrics>;
    const meanRetention = Array.from({ length: r.generations + 1 }, (_, g) =>
      mean(fidelityPerSeed.map((s) => s.chain[g]?.retention ?? 0)),
    );
    const finishedAt = new Date();
    const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
    const result: SuccessorResult = {
      schema: SUCCESSOR_RESULT_SCHEMA,
      config: {
        kind: SUCCESSOR_KIND,
        dataset: "synthetic-v1",
        datasetItems: items.length,
        model: r.model.id,
        judge: "stub",
        seeds: r.seeds,
        splitSalt: r.splitSalt,
        splitMode,
        seedFraction: r.seedFraction,
        firstK: r.firstK,
        generations: r.generations,
        learn: r.learn,
        inheritance: "shared-pool",
        inheritancePool: INHERITANCE_POOL,
        contextVersion: SUCCESSOR_CONTEXT_VERSION,
        endpoint: r.endpoint,
        harnessGitSha: gitSha(),
        offline: r.offline,
        networkAttempts: guard?.attempts() ?? 0,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: performance.now() - t0,
      },
      arms,
      delta: {
        accuracy: arms.inherit.accuracy.pooled - arms.fresh.accuracy.pooled,
        firstK: arms.inherit.firstK.pooled - arms.fresh.firstK.pooled,
        timeToFirstCorrect: diff(
          arms.inherit.timeToFirstCorrect.mean,
          arms.fresh.timeToFirstCorrect.mean,
        ),
        timeToFirstTransfer: diff(
          arms.inherit.timeToFirstTransfer.mean,
          arms.fresh.timeToFirstTransfer.mean,
        ),
      },
      fidelity: {
        generations: r.generations,
        judge: "exact-match-containment",
        summarizer: r.summarizer.id,
        perSeed: fidelityPerSeed,
        meanRetention,
      },
      perSeed,
      items: records,
    };
    const summaryMarkdown = renderSuccessorMarkdown(result);
    let file: string | null = null;
    let summaryPath: string | null = null;
    if (options.resultsDir !== "") {
      mkdirSync(r.resultsDir, { recursive: true });
      const stamp = timestamp(startedAt);
      file = freshPath(r.resultsDir, `${stamp}-successor-${r.model.id}`, ".json");
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      summaryPath = freshPath(r.resultsDir, `${stamp}-successor-summary-${r.model.id}`, ".md");
      writeFileSync(summaryPath, summaryMarkdown);
    }
    log(`\n${summaryMarkdown}`);
    return {
      result,
      file,
      summaryPath,
      summaryMarkdown,
      networkAttempts: guard?.attempts() ?? 0,
    };
  } finally {
    guard?.restore();
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `successor — Marina cold-start + transmission-fidelity benchmark (Tier 4 scaffold)

Usage:
  bun --env-file=/dev/null run benchmarks/memory/successor.ts [options]

Options:
  --model <id>            stub (default, offline) | any model id routed via --endpoint (e.g. marina)
  --endpoint <url>        Marina OpenAI-compatible endpoint (default http://localhost:3300)
  --api-key <key>         bearer for --endpoint (or MARINA_API_KEY / MODEL_API_KEY)
  --summarizer <kind>     model (default with a real model: the model re-summarises) | stub (truncating digest)
  --seeds <n>             number of seeds (default 5)
  --seed-start <n>        first seed (default 1)
  --limit <n>             cap items before the split
  --split-salt <s>        salt for the predecessor/successor split (default v1)
  --split <mode>          paraphrase (default) | item
  --seed-fraction <f>     fraction of facts the predecessor learned (default 0.5)
  --first-k <n>           k for first-k success (default 5)
  --generations <n>       re-summarisation generations for fidelity (default 3)
  --no-learn              successor does not write Q/A notes while answering
  --temperature <n|none>  sampling temperature (default none = provider default)
  --results-dir <dir>     default benchmarks/results/memory (gitignored)
  --online                allow network even with the stub model
  --quiet
  --help
`;

export async function runCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string", default: "stub" },
      seeds: { type: "string", default: "5" },
      "seed-start": { type: "string", default: "1" },
      limit: { type: "string" },
      "split-salt": { type: "string", default: "v1" },
      split: { type: "string" },
      "seed-fraction": { type: "string", default: "0.5" },
      "first-k": { type: "string", default: "5" },
      generations: { type: "string", default: "3" },
      "no-learn": { type: "boolean", default: false },
      endpoint: { type: "string" },
      "api-key": { type: "string" },
      summarizer: { type: "string" },
      "results-dir": { type: "string" },
      temperature: { type: "string" },
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
  const report = await runSuccessorBenchmark({
    model: values.model ?? "stub",
    seeds: Number(values.seeds ?? "5"),
    seedStart: Number(values["seed-start"] ?? "1"),
    limit: num(values.limit),
    splitSalt: values["split-salt"],
    split: values.split === "item" || values.split === "paraphrase" ? values.split : undefined,
    seedFraction: Number(values["seed-fraction"] ?? "0.5"),
    firstK: Number(values["first-k"] ?? "5"),
    generations: Number(values.generations ?? "3"),
    learn: !values["no-learn"],
    endpoint: values.endpoint,
    apiKey: values["api-key"],
    summarizer:
      values.summarizer === "stub" || values.summarizer === "model" ? values.summarizer : undefined,
    resultsDir: values["results-dir"],
    temperature:
      values.temperature === undefined || values.temperature === "none"
        ? null
        : Number(values.temperature),
    offline: values.online ? false : undefined,
    quiet: values.quiet,
  });
  return Object.values(report.result.arms).some((m) => m.errors > 0) ? 1 : 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`successor failed: ${error instanceof Error ? error.message : error}`);
      process.exit(2);
    },
  );
}
