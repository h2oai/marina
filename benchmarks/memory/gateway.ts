#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * gateway — "lift per injected token" for Marina's passthru memory gateway.
 *
 * genbench asks whether memory helps an agent that lives INSIDE Marina. This
 * harness asks the Phase-2 gateway question from the OUTSIDE: when an ordinary
 * OpenAI-compatible client (an editor, an SDK, curl) calls Marina's
 * `/v1/chat/completions` with a bound `secret:entity` key, how much do the
 * bytes Marina injects into the upstream prompt improve that client's answers —
 * per token injected?
 *
 * The harness is a pure client. It never opens the database, never imports the
 * engine, and never calls a paid model: everything goes through the endpoint it
 * is pointed at, exactly as a third-party tool would.
 *
 *   1. Split `synthetic-v1` with genbench's `splitParaphrases` (one paraphrase
 *      of every fact held out, its sibling seeded — transfer ceiling 100 %).
 *   2. Seed the bound entity's memory THROUGH MARINA via the `/mem` REST API
 *      (`MEM_API_KEYS=<secret>:<entity>`): one `Q: … | A: <gold>` note per seed
 *      paraphrase (`learnNoteText`). `/mem` writes notes under `entity_name =
 *      <agent>`, and passthru injection reads the bound entity's legacy notes
 *      by the same name, so the two keys must name the SAME entity.
 *   3. For every eval item send the same `POST /v1/chat/completions` twice:
 *      arm `injected` (`X-Marina-Context: on`, honored for bound keys) and arm
 *      `off` (`X-Marina-Context: off` — the byte-identical proxy control).
 *      Grade with `exactMatchJudge`; parse `x-marina-memory-receipt`.
 *   4. Headline: lift per injected kilotoken =
 *      (acc_injected − acc_off) / (mean injected tokens / 1000).
 *
 * Passthru also CAPTURES every injected exchange as a `[passthru]` note in the
 * entity's memory, so the harness wipes the entity's `/mem` namespace before
 * every seed (and refuses to run against a namespace that already holds notes
 * unless `--force` is given). Use a dedicated benchmark entity.
 *
 * The budget (`MARINA_PASSTHRU_INJECT_BYTES`, or the entity property
 * `passthruInjectBytes`) is server-side configuration with no client-facing
 * setter, so a budget sweep is one server per budget: pass `--budget <bytes>`
 * to record the expectation and the harness verifies every receipt against it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sanitizeEntityName } from "../../src/engine/entity-name";
import {
  MEMORY_RECEIPT_HEADER,
  MEMORY_RECEIPT_SCHEMA,
  type MemoryReceipt,
  parseMemoryReceipt,
} from "../../src/net/memory-receipt";
import type { DatasetItem, Message } from "../types";
import {
  estimateTokens,
  exactMatchJudge,
  goldText,
  type Interval,
  learnNoteText,
  loadSyntheticItems,
  type Percentiles,
  splitParaphrases,
  tokenF1,
  wilson95,
} from "./genbench";

// ─── Public constants ───────────────────────────────────────────────────────

export const GATEWAY_RESULT_SCHEMA = "marina.memory.gateway.v1" as const;
export const GATEWAY_ARMS = ["off", "injected"] as const;
export type GatewayArm = (typeof GATEWAY_ARMS)[number];

/** Identifies the client-side protocol in force; bump when it changes. */
export const GATEWAY_HARNESS_VERSION =
  "gateway-v1:/v1/chat/completions+X-Marina-Context+x-marina-memory-receipt";
/** How the seed notes reach the entity (recorded in `config.seedingPath`). */
export const GATEWAY_SEEDING_PATH = "mem-rest:POST /mem/notes (MEM_API_KEYS secret:entity)";
export const GATEWAY_DATASET = "synthetic-v1";
export const DEFAULT_MODEL_ID = "marina";
export const DEFAULT_SPLIT_SALT = "v1";
export const DEFAULT_SEED_FRACTION = 0.5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_RESULTS_DIR = join(import.meta.dir, "..", "results", "memory");
const MAX_RATE_LIMIT_RETRIES = 8;
const WIPE_PAGE = 200;
const WIPE_MAX_PAGES = 50;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GatewayOptions {
  /** Marina base URL, e.g. `http://localhost:3300`. */
  endpoint: string;
  /** The MODEL_API_KEYS secret — MUST be a bound `secret:entity` entry. */
  apiKey: string;
  /** Entity the key is bound to; also the `/mem` namespace to seed. */
  entity: string;
  /** MEM_API_KEYS secret for the same entity (default: `apiKey`). */
  memApiKey?: string;
  /** Model id sent to the server (default `marina`, the passthru id). */
  model?: string;
  seeds: number;
  seedStart?: number;
  /** Cap on items before the split (use an even number to keep paraphrase pairs). */
  limit?: number;
  splitSalt?: string;
  seedFraction?: number;
  /** Expected server-side injection budget in bytes; every receipt is checked against it. */
  budget?: number;
  /** Allow running against an entity whose namespace already holds notes (they will be wiped). */
  force?: boolean;
  resultsDir?: string;
  quiet?: boolean;
  requestTimeoutMs?: number;
  /** Sampling temperature; `null` (default) omits it so the provider default applies. */
  temperature?: number | null;
  /** Transport override (tests pass the real fetch while stubbing the server's upstream). */
  fetchImpl?: typeof fetch;
}

export interface ReceiptSummary {
  /** The header was present and parsed as a full receipt. */
  present: boolean;
  /** The header was the ≤2 KB stub (`truncatedHeader: true`) — byte counts unknown. */
  stub: boolean;
  requestId: string | null;
  entity: string | null;
  usedBytes: number | null;
  budgetBytes: number | null;
  truncated: boolean | null;
  tiers: { tier: string; items: number; bytes: number }[];
  degraded: string[];
}

export interface GatewayQueryRecord {
  seed: number;
  arm: GatewayArm;
  id: string;
  factId: string | null;
  question: string;
  expected: string;
  prediction: string;
  correct: boolean;
  tokenF1: number;
  /** `x-request-id` from the response — the id for `trace show`. */
  requestId: string | null;
  /** `null` when the response carried no receipt header at all. */
  receipt: ReceiptSummary | null;
  /** Receipt `usedBytes`; null without a full receipt. */
  injectedBytes: number | null;
  /** bytes/4 heuristic over `injectedBytes` (labeled; matches genbench chars/4 on ASCII). */
  injectedTokens: number | null;
  /** chars/4 heuristic over the client's own message text. */
  clientTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  responseModel: string | null;
  status: number;
  latencyMs: number;
  error?: string;
}

export interface GatewaySeedSummary {
  seed: number;
  splitFingerprint: string;
  seedSetSize: number;
  evalSetSize: number;
  seedIds: string[];
  evalIds: string[];
  reachable: number | null;
  notesSeeded: number;
  /** Notes found in the namespace before this seed's wipe (captures from the previous seed). */
  notesWiped: number;
  perArm: Record<GatewayArm, { n: number; correct: number; accuracy: number; tokenF1Mean: number }>;
}

export interface Distribution {
  mean: number;
  p95: number;
  max: number;
}

export interface GatewayArmMetrics {
  n: number;
  correct: number;
  errors: number;
  accuracy: {
    pooled: number;
    wilson95: Interval;
    perSeed: number[];
    seedMean: number;
    seedStd: number;
    seedCi95: Interval;
  };
  tokenF1: { mean: number; perSeed: number[] };
  receipts: { full: number; stub: number; missing: number };
  /** From full receipts only; null when none. */
  injectedBytes: Distribution | null;
  injectedTokens: Distribution | null;
  truncatedRate: number | null;
  /** Receipt `degraded` codes and how many receipts carried each. */
  degraded: Record<string, number>;
  promptTokens: { mean: number; total: number } | null;
  completionTokens: { total: number } | null;
  latencyMs: Percentiles;
}

export interface GatewayLift {
  /** acc_injected − acc_off — also the lift per request (extra correct answers per call). */
  accuracyDelta: number;
  /** Wald 95 % interval on the difference of pooled proportions. */
  accuracyDeltaCi95: Interval;
  liftPerRequest: number;
  tokenF1Delta: number;
  meanInjectedTokens: number | null;
  /** HEADLINE: accuracyDelta / (meanInjectedTokens / 1000). Null without receipts. */
  liftPerKilotoken: number | null;
  /** mean(prompt_tokens injected) − mean(prompt_tokens off), provider-reported, when both present. */
  providerPromptTokenDelta: number | null;
  liftPerProviderKilotoken: number | null;
}

export interface GatewayConfig {
  endpoint: string;
  entity: string;
  /** Entity name the server reported in receipts (must equal `entity`). */
  entityResolved: string | null;
  /** sha256 prefix of the secret — never the secret. */
  apiKeyFingerprint: string;
  memApiKeySameAsModelKey: boolean;
  model: string;
  /** `/v1/models` ids the server listed. */
  serverModels: string[];
  /** `model` field of the first completion — the upstream the server pinned. */
  responseModel: string | null;
  budgetBytes: { requested: number | null; observed: number | null };
  dataset: string;
  datasetItems: number;
  seeds: number[];
  splitMode: "paraphrase";
  splitSalt: string;
  seedFraction: number;
  seedingPath: string;
  wipeBetweenSeeds: true;
  injectedHeader: "on";
  offHeader: "off";
  judge: "exact-match";
  temperature: number | null;
  requestTimeoutMs: number;
  harnessGitSha: string;
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface GatewayResult {
  schema: typeof GATEWAY_RESULT_SCHEMA;
  config: GatewayConfig;
  arms: Record<GatewayArm, GatewayArmMetrics>;
  lift: GatewayLift;
  perSeed: GatewaySeedSummary[];
  items: GatewayQueryRecord[];
  warnings: string[];
}

export interface GatewayReport {
  result: GatewayResult;
  jsonPath: string;
  markdownPath: string;
}

/** Thrown when the server does not meet the run requirements; message is operator-facing. */
export class GatewayPreflightError extends Error {}

// ─── Small helpers ──────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  return { mean: mean(values), p95: percentile(values, 0.95), max: Math.max(...values) };
}

/** bytes/4 — the same heuristic as genbench's `estimateTokens` (chars/4), over receipt bytes. */
export function tokensFromBytes(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 4);
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

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function factIdOf(item: DatasetItem): string | null {
  const value = item.metadata?.factId;
  return value === undefined || value === null ? null : String(value);
}

/** Summarize a receipt header value. `null` header → null (no receipt at all). */
export function summarizeReceiptHeader(header: string | null): ReceiptSummary | null {
  if (header === null) return null;
  const full = parseMemoryReceipt(header);
  if (full) return summarizeReceipt(full);
  let stub: { schema?: unknown; requestId?: unknown; truncatedHeader?: unknown } | null = null;
  try {
    stub = JSON.parse(header);
  } catch {
    stub = null;
  }
  const isStub = !!stub && stub.schema === MEMORY_RECEIPT_SCHEMA && stub.truncatedHeader === true;
  return {
    present: false,
    stub: isStub,
    requestId: isStub && typeof stub?.requestId === "string" ? stub.requestId : null,
    entity: null,
    usedBytes: null,
    budgetBytes: null,
    truncated: null,
    tiers: [],
    degraded: [],
  };
}

function summarizeReceipt(receipt: MemoryReceipt): ReceiptSummary {
  return {
    present: true,
    stub: false,
    requestId: receipt.requestId,
    entity: receipt.entity,
    usedBytes: receipt.usedBytes,
    budgetBytes: receipt.budgetBytes,
    truncated: receipt.truncated,
    tiers: receipt.tiers.map((t) => ({ tier: t.tier, items: t.ids.length, bytes: t.bytes })),
    degraded: [...receipt.degraded],
  };
}

function buildQuestionMessages(item: DatasetItem): Message[] {
  return [
    {
      role: "system",
      content: "Answer the question concisely with just the answer, no explanation.",
    },
    { role: "user", content: item.question },
  ];
}

// ─── HTTP client ────────────────────────────────────────────────────────────

interface ChatOutcome {
  status: number;
  latencyMs: number;
  requestId: string | null;
  receiptHeader: string | null;
  json: Record<string, unknown> | null;
  text: string;
}

/** Marina as seen by an external OpenAI-compatible client plus the `/mem` REST API. */
export class GatewayClient {
  private readonly base: string;
  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly memApiKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.base = endpoint.replace(/\/$/, "");
  }

  /** fetch with 429 backoff (the model API is 2 req/s per IP; `/mem` 10 req/s per agent). */
  private async request(path: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      await Bun.sleep(Math.max(delay, Math.min(5_000, 250 * 2 ** attempt)));
      attempt++;
    }
  }

  private modelHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...extra,
    };
  }

  private memHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.memApiKey}` };
  }

  async models(): Promise<{ status: number; ids: string[] }> {
    const response = await this.request("/v1/models", { headers: this.modelHeaders() });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, ids: [] };
    }
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return { status: response.status, ids };
  }

  async chat(
    model: string,
    messages: Message[],
    context: "on" | "off",
    temperature: number | null,
  ): Promise<ChatOutcome> {
    const started = performance.now();
    const response = await this.request("/v1/chat/completions", {
      method: "POST",
      headers: this.modelHeaders({ "X-Marina-Context": context }),
      body: JSON.stringify({
        model,
        messages,
        ...(temperature === null ? {} : { temperature }),
      }),
    });
    const text = await response.text();
    const latencyMs = performance.now() - started;
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text);
      json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      latencyMs,
      requestId: response.headers.get("x-request-id"),
      receiptHeader: response.headers.get(MEMORY_RECEIPT_HEADER),
      json,
      text,
    };
  }

  async memStats(): Promise<{ status: number; agent: string | null; notes: number | null }> {
    const response = await this.request("/mem/stats", { headers: this.memHeaders() });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, agent: null, notes: null };
    }
    const body = (await response.json()) as { agent?: unknown; notes?: unknown };
    return {
      status: response.status,
      agent: typeof body.agent === "string" ? body.agent : null,
      notes: typeof body.notes === "number" ? body.notes : null,
    };
  }

  async memCreate(content: string): Promise<number> {
    const response = await this.request("/mem/notes", {
      method: "POST",
      headers: this.memHeaders(),
      body: JSON.stringify({ content, type: "observation", importance: 5 }),
    });
    if (response.status !== 201) {
      const body = await response.text().catch(() => "");
      throw new GatewayPreflightError(
        `POST /mem/notes failed with ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "number") throw new Error("POST /mem/notes returned no id");
    return body.id;
  }

  private async memListIds(): Promise<number[]> {
    const response = await this.request(`/mem/notes?all=1&limit=${WIPE_PAGE}`, {
      headers: this.memHeaders(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GET /mem/notes failed with ${response.status}: ${body.slice(0, 200)}`);
    }
    const body = (await response.json()) as { notes?: { id?: unknown }[] };
    return (body.notes ?? []).map((n) => n.id).filter((id): id is number => typeof id === "number");
  }

  /** Delete every note in the namespace. Returns how many were removed. */
  async memWipe(): Promise<number> {
    let removed = 0;
    for (let page = 0; page < WIPE_MAX_PAGES; page++) {
      const ids = await this.memListIds();
      if (ids.length === 0) break;
      let deletedThisPage = 0;
      for (const id of ids) {
        const response = await this.request(`/mem/notes/${id}`, {
          method: "DELETE",
          headers: this.memHeaders(),
        });
        await response.body?.cancel();
        if (response.ok) deletedThisPage++;
      }
      removed += deletedThisPage;
      if (deletedThisPage === 0) break; // nothing writable left — avoid spinning
    }
    return removed;
  }
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export function computeArmMetrics(
  records: GatewayQueryRecord[],
  perSeed: GatewaySeedSummary[],
  arm: GatewayArm,
): GatewayArmMetrics {
  const ok = records.filter((r) => !r.error);
  const n = ok.length;
  const correct = ok.filter((r) => r.correct).length;
  const accs = perSeed.map((s) => s.perArm[arm].accuracy);
  const seedMean = mean(accs);
  const seedStd = std(accs);
  const seedHalf = accs.length > 1 ? (1.96 * seedStd) / Math.sqrt(accs.length) : 0;
  const full = ok.filter((r) => r.receipt?.present);
  const bytes = full.map((r) => r.injectedBytes as number);
  const prompt = ok.map((r) => r.promptTokens).filter((x): x is number => typeof x === "number");
  const completion = ok
    .map((r) => r.completionTokens)
    .filter((x): x is number => typeof x === "number");
  const degraded: Record<string, number> = {};
  for (const r of full) {
    for (const code of r.receipt?.degraded ?? []) degraded[code] = (degraded[code] ?? 0) + 1;
  }
  return {
    n,
    correct,
    errors: records.length - ok.length,
    accuracy: {
      pooled: n > 0 ? correct / n : 0,
      wilson95: wilson95(correct, n),
      perSeed: accs,
      seedMean,
      seedStd,
      seedCi95: { low: Math.max(0, seedMean - seedHalf), high: Math.min(1, seedMean + seedHalf) },
    },
    tokenF1: {
      mean: mean(ok.map((r) => r.tokenF1)),
      perSeed: perSeed.map((s) => s.perArm[arm].tokenF1Mean),
    },
    receipts: {
      full: full.length,
      stub: ok.filter((r) => r.receipt && !r.receipt.present && r.receipt.stub).length,
      missing: ok.filter((r) => r.receipt === null).length,
    },
    injectedBytes: distribution(bytes),
    injectedTokens: distribution(bytes.map(tokensFromBytes)),
    truncatedRate:
      full.length > 0 ? full.filter((r) => r.receipt?.truncated).length / full.length : null,
    degraded,
    promptTokens:
      prompt.length > 0 ? { mean: mean(prompt), total: prompt.reduce((a, b) => a + b, 0) } : null,
    completionTokens:
      completion.length > 0 ? { total: completion.reduce((a, b) => a + b, 0) } : null,
    latencyMs: {
      p50: percentile(
        ok.map((r) => r.latencyMs),
        0.5,
      ),
      p95: percentile(
        ok.map((r) => r.latencyMs),
        0.95,
      ),
    },
  };
}

export function computeLift(off: GatewayArmMetrics, injected: GatewayArmMetrics): GatewayLift {
  const p1 = injected.accuracy.pooled;
  const p0 = off.accuracy.pooled;
  const delta = p1 - p0;
  const se =
    injected.n > 0 && off.n > 0
      ? Math.sqrt((p1 * (1 - p1)) / injected.n + (p0 * (1 - p0)) / off.n)
      : 0;
  const meanTokens = injected.injectedTokens?.mean ?? null;
  const promptDelta =
    injected.promptTokens && off.promptTokens
      ? injected.promptTokens.mean - off.promptTokens.mean
      : null;
  return {
    accuracyDelta: delta,
    accuracyDeltaCi95: {
      low: Math.max(-1, delta - 1.96 * se),
      high: Math.min(1, delta + 1.96 * se),
    },
    liftPerRequest: delta,
    tokenF1Delta: injected.tokenF1.mean - off.tokenF1.mean,
    meanInjectedTokens: meanTokens,
    liftPerKilotoken: meanTokens !== null && meanTokens > 0 ? delta / (meanTokens / 1000) : null,
    providerPromptTokenDelta: promptDelta,
    liftPerProviderKilotoken:
      promptDelta !== null && promptDelta > 0 ? delta / (promptDelta / 1000) : null,
  };
}

// ─── Rendering + validation ─────────────────────────────────────────────────

const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtCi = (ci: Interval) => `[${fmtPct(ci.low)}, ${fmtPct(ci.high)}]`;
const fmtNum = (x: number | null, digits = 0) => (x === null ? "n/a" : x.toFixed(digits));

export function renderGatewayMarkdown(result: GatewayResult): string {
  const c = result.config;
  const lines: string[] = [
    `# gateway — lift per injected token · entity=${c.entity} · model=${c.model}${c.responseModel ? ` (upstream ${c.responseModel})` : ""}`,
    "",
    `endpoint=${c.endpoint} · seeds=${c.seeds.join(",")} · split=${c.splitMode}/${c.splitSalt}/${c.seedFraction} · dataset=${c.dataset} (${c.datasetItems} items) · budget requested=${c.budgetBytes.requested ?? "n/a"} observed=${c.budgetBytes.observed ?? "n/a"} B · harness=${c.harnessGitSha.slice(0, 12)} · ${c.harnessVersion}`,
    "",
    "| Arm | n (eval×seeds) | Accuracy | Wilson 95% | Seed-mean ± CI | Token-F1 | Receipts full/stub/missing | Injected B mean/p95 | Injected tok mean/p95 | Truncated | Prompt tok mean | Latency p50/p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of GATEWAY_ARMS) {
    const m = result.arms[arm];
    const seedCi = `${fmtPct(m.accuracy.seedMean)} ± ${fmtPct(m.accuracy.seedMean - m.accuracy.seedCi95.low)}`;
    lines.push(
      `| ${arm} | ${m.n} | ${fmtPct(m.accuracy.pooled)} | ${fmtCi(m.accuracy.wilson95)} | ${seedCi} | ${m.tokenF1.mean.toFixed(3)} | ${m.receipts.full}/${m.receipts.stub}/${m.receipts.missing} | ${fmtNum(m.injectedBytes?.mean ?? null)}/${fmtNum(m.injectedBytes?.p95 ?? null)} | ${fmtNum(m.injectedTokens?.mean ?? null)}/${fmtNum(m.injectedTokens?.p95 ?? null)} | ${m.truncatedRate === null ? "n/a" : fmtPct(m.truncatedRate)} | ${fmtNum(m.promptTokens?.mean ?? null, 1)} | ${m.latencyMs.p50.toFixed(1)}/${m.latencyMs.p95.toFixed(1)} |`,
    );
  }
  const l = result.lift;
  lines.push(
    "",
    `**Lift per request** (acc_injected − acc_off): ${fmtPct(l.liftPerRequest)} ${fmtCi(l.accuracyDeltaCi95)} (Wald)`,
    "",
    `**Lift per injected kilotoken**: ${l.liftPerKilotoken === null ? "n/a (no full receipts)" : `${(l.liftPerKilotoken * 100).toFixed(2)} accuracy points per 1 000 injected tokens`} (mean injected ${fmtNum(l.meanInjectedTokens)} tok, bytes/4 heuristic from receipts)`,
    "",
    `Provider-reported prompt-token delta: ${l.providerPromptTokenDelta === null ? "n/a" : `${l.providerPromptTokenDelta.toFixed(1)} tok → ${l.liftPerProviderKilotoken === null ? "n/a" : `${(l.liftPerProviderKilotoken * 100).toFixed(2)} pts / 1 000 tok`}`}. Token-F1 delta: ${l.tokenF1Delta.toFixed(3)}.`,
    "",
    "`off` is the byte-identical proxy (`X-Marina-Context: off`, no receipt). `injected` is `X-Marina-Context: on` for the bound key. Injected bytes/tokens come from `x-marina-memory-receipt` (`usedBytes`, framing included); a stub header (>2 KB receipt) leaves them unknown and is counted under `stub`. Every scored item is a held-out paraphrase whose sibling was seeded through `/mem` (ceiling 100 %). Exact-match judge.",
  );
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((w) => `- ${w}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Structural validation of a result file. Returns a list of problems (empty = valid). */
export function validateGatewayResult(value: unknown): string[] {
  const problems: string[] = [];
  const v = value as Partial<GatewayResult> | null;
  if (!v || typeof v !== "object") return ["not an object"];
  if (v.schema !== GATEWAY_RESULT_SCHEMA) problems.push(`schema != ${GATEWAY_RESULT_SCHEMA}`);
  const c = v.config;
  if (!c) problems.push("missing config");
  else {
    for (const key of [
      "endpoint",
      "entity",
      "apiKeyFingerprint",
      "model",
      "dataset",
      "splitSalt",
      "seedingPath",
      "harnessGitSha",
      "harnessVersion",
      "startedAt",
      "finishedAt",
    ] as const) {
      if (typeof c[key] !== "string") problems.push(`config.${key} must be a string`);
    }
    if (!Array.isArray(c.seeds) || c.seeds.length === 0)
      problems.push("config.seeds must be non-empty");
    if (!Array.isArray(c.serverModels)) problems.push("config.serverModels must be an array");
    if (!c.budgetBytes || typeof c.budgetBytes !== "object")
      problems.push("config.budgetBytes missing");
    if (c.splitMode !== "paraphrase") problems.push("config.splitMode must be paraphrase");
  }
  if (!v.arms) problems.push("missing arms");
  else {
    for (const arm of GATEWAY_ARMS) {
      const m = v.arms[arm];
      if (!m) {
        problems.push(`arms.${arm} missing`);
        continue;
      }
      if (typeof m.n !== "number") problems.push(`arms.${arm}.n must be number`);
      if (!m.accuracy || typeof m.accuracy.pooled !== "number")
        problems.push(`arms.${arm}.accuracy.pooled missing`);
      if (
        !m.accuracy?.wilson95 ||
        typeof m.accuracy.wilson95.low !== "number" ||
        typeof m.accuracy.wilson95.high !== "number"
      )
        problems.push(`arms.${arm}.accuracy.wilson95 missing`);
      if (!m.tokenF1 || typeof m.tokenF1.mean !== "number")
        problems.push(`arms.${arm}.tokenF1 missing`);
      if (!m.receipts || typeof m.receipts.full !== "number")
        problems.push(`arms.${arm}.receipts missing`);
      if (!("injectedTokens" in m)) problems.push(`arms.${arm}.injectedTokens missing`);
      if (!m.latencyMs || typeof m.latencyMs.p95 !== "number")
        problems.push(`arms.${arm}.latencyMs missing`);
    }
  }
  const l = v.lift;
  if (!l) problems.push("missing lift");
  else {
    if (typeof l.accuracyDelta !== "number") problems.push("lift.accuracyDelta must be number");
    if (typeof l.liftPerRequest !== "number") problems.push("lift.liftPerRequest must be number");
    if (!("liftPerKilotoken" in l)) problems.push("lift.liftPerKilotoken missing");
    if (!l.accuracyDeltaCi95) problems.push("lift.accuracyDeltaCi95 missing");
  }
  if (!Array.isArray(v.perSeed)) problems.push("perSeed must be an array");
  if (!Array.isArray(v.items)) problems.push("items must be an array");
  if (!Array.isArray(v.warnings)) problems.push("warnings must be an array");
  return problems;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const BINDING_CHECKLIST = [
  "the run needs a BOUND key: MODEL_API_KEYS=<secret>:<entity> (a plain secret is the anonymous shared identity and is never injected; MARINA_OPEN_API anonymous callers likewise)",
  'the model endpoint must be in passthru mode: PUT /api/model-endpoint {"mode":"passthru"} (the default `agents` mode falls back to the upstream WITHOUT injection when no agent answers)',
  "injection must be on for the identity: the `local` trust profile injects by default and the harness sends X-Marina-Context: on, which is honored for bound keys only",
  "MEM_API_KEYS=<secret>:<entity> must name the SAME entity so the seeded notes land in the memory the passthru identity reads",
];

interface Resolved {
  endpoint: string;
  apiKey: string;
  memApiKey: string;
  entity: string;
  model: string;
  seeds: number[];
  limit?: number;
  splitSalt: string;
  seedFraction: number;
  budget: number | null;
  force: boolean;
  resultsDir: string;
  quiet: boolean;
  requestTimeoutMs: number;
  temperature: number | null;
  fetchImpl: typeof fetch;
}

function resolveOptions(options: GatewayOptions): Resolved {
  if (!options.endpoint) throw new GatewayPreflightError("--endpoint is required");
  if (!options.apiKey) throw new GatewayPreflightError("--api-key is required");
  if (!options.entity) throw new GatewayPreflightError("--entity is required");
  if (!Number.isInteger(options.seeds) || options.seeds < 1)
    throw new GatewayPreflightError("--seeds must be a positive integer");
  const start = options.seedStart ?? 1;
  return {
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    memApiKey: options.memApiKey ?? options.apiKey,
    entity: options.entity,
    model: options.model ?? DEFAULT_MODEL_ID,
    seeds: Array.from({ length: options.seeds }, (_, i) => start + i),
    limit: options.limit,
    splitSalt: options.splitSalt ?? DEFAULT_SPLIT_SALT,
    seedFraction: options.seedFraction ?? DEFAULT_SEED_FRACTION,
    budget: options.budget ?? null,
    force: options.force ?? false,
    resultsDir: options.resultsDir ?? DEFAULT_RESULTS_DIR,
    quiet: options.quiet ?? false,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    temperature: options.temperature ?? null,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

async function preflight(
  r: Resolved,
  client: GatewayClient,
): Promise<{ serverModels: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const sanitized = sanitizeEntityName(r.entity);
  if (sanitized !== r.entity) {
    throw new GatewayPreflightError(
      `--entity "${r.entity}" is not a canonical entity name: the server binds the key to "${sanitized}" (alphanumeric + underscore, ≤20 chars) while /mem would seed the namespace "${r.entity}". Use "${sanitized}" in both MODEL_API_KEYS and MEM_API_KEYS and pass --entity ${sanitized}.`,
    );
  }
  let models: Awaited<ReturnType<GatewayClient["models"]>>;
  try {
    models = await client.models();
  } catch (error) {
    throw new GatewayPreflightError(
      `cannot reach ${r.endpoint}: ${error instanceof Error ? error.message : String(error)} — is Marina running there?`,
    );
  }
  if (models.status === 401 || models.status === 403) {
    throw new GatewayPreflightError(
      `GET /v1/models rejected the key (${models.status}). Set MODEL_API_KEYS=<secret>:${r.entity} on the server and pass the same secret as --api-key.`,
    );
  }
  if (models.status !== 200) {
    throw new GatewayPreflightError(
      `GET /v1/models returned ${models.status} — is ${r.endpoint} a Marina instance?`,
    );
  }
  if (!models.ids.includes(r.model)) {
    warnings.push(
      `model "${r.model}" is not listed by /v1/models (${models.ids.join(", ") || "none"}); passthru forwards it anyway`,
    );
  }
  const stats = await client.memStats();
  if (stats.status === 401) {
    throw new GatewayPreflightError(
      `GET /mem/stats rejected the memory key (401). Set MEM_API_KEYS=<secret>:${r.entity} on the server (the harness uses --mem-api-key, defaulting to --api-key).`,
    );
  }
  if (stats.status !== 200) {
    throw new GatewayPreflightError(
      `GET /mem/stats returned ${stats.status}; the /mem REST API must be reachable to seed memory`,
    );
  }
  if (stats.agent !== r.entity) {
    throw new GatewayPreflightError(
      `MEM_API_KEYS binds this secret to "${stats.agent}" but --entity is "${r.entity}"; both keys must name the same entity.`,
    );
  }
  if ((stats.notes ?? 0) > 0 && !r.force) {
    throw new GatewayPreflightError(
      `entity "${r.entity}" already holds ${stats.notes} note(s). The harness WIPES the namespace before every seed — use a dedicated benchmark entity, or pass --force to wipe this one.`,
    );
  }
  return { serverModels: models.ids, warnings };
}

async function wipeUntilEmpty(client: GatewayClient): Promise<number> {
  // Passthru capture is fire-and-forget on the server; a late capture from the
  // previous seed's last request may land after the first sweep.
  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    removed += await client.memWipe();
    const stats = await client.memStats();
    if ((stats.notes ?? 0) === 0) break;
    await Bun.sleep(50);
  }
  return removed;
}

export async function runGatewayBenchmark(options: GatewayOptions): Promise<GatewayReport> {
  const r = resolveOptions(options);
  const log = (line: string) => {
    if (!r.quiet) console.log(line);
  };
  const client = new GatewayClient(
    r.endpoint,
    r.apiKey,
    r.memApiKey,
    r.requestTimeoutMs,
    r.fetchImpl,
  );
  const startedAt = new Date();
  const allItems = loadSyntheticItems();
  const items = r.limit ? allItems.slice(0, r.limit) : allItems;
  if (items.length < 4) throw new GatewayPreflightError(`too few items (${items.length})`);
  if (r.limit !== undefined && r.limit % 2 === 1) {
    log(
      "note: odd --limit leaves one paraphrase without its sibling; it falls back to the item split",
    );
  }

  const { serverModels, warnings } = await preflight(r, client);
  log(
    `gateway · endpoint=${r.endpoint} · entity=${r.entity} · model=${r.model} · seeds=${r.seeds.join(",")} · items=${items.length} · budget=${r.budget ?? "server default"}`,
  );

  const records: GatewayQueryRecord[] = [];
  const perSeed: GatewaySeedSummary[] = [];
  let entityResolved: string | null = null;
  let responseModel: string | null = null;
  let observedBudget: number | null = null;
  let budgetMismatches = 0;

  try {
    for (const seed of r.seeds) {
      const split = splitParaphrases(items, seed, r.splitSalt, r.seedFraction);
      if (split.evalSet.length === 0 || split.seedSet.length === 0) {
        throw new GatewayPreflightError(
          `seed ${seed}: degenerate split (${split.seedSet.length}/${split.evalSet.length})`,
        );
      }
      const notesWiped = await wipeUntilEmpty(client);
      let notesSeeded = 0;
      for (const item of split.seedSet) {
        await client.memCreate(learnNoteText(item, goldText(item)));
        notesSeeded++;
      }
      const stats = await client.memStats();
      if ((stats.notes ?? 0) < notesSeeded) {
        throw new GatewayPreflightError(
          `seed ${seed}: seeded ${notesSeeded} notes but /mem/stats reports ${stats.notes}; the /mem namespace is not the entity the key is bound to`,
        );
      }

      const seedRecords: GatewayQueryRecord[] = [];
      for (const item of split.evalSet) {
        const messages = buildQuestionMessages(item);
        const clientTokens = estimateTokens(messages.map((m) => m.content).join("\n"));
        for (const arm of GATEWAY_ARMS) {
          const outcome = await client.chat(
            r.model,
            messages,
            arm === "injected" ? "on" : "off",
            r.temperature,
          );
          const receipt = summarizeReceiptHeader(outcome.receiptHeader);
          const choice = (
            outcome.json?.choices as { message?: { content?: unknown } }[] | undefined
          )?.[0];
          const content = choice?.message?.content;
          const prediction = typeof content === "string" ? content : "";
          const usage = outcome.json?.usage as
            | { prompt_tokens?: unknown; completion_tokens?: unknown }
            | undefined;
          const model = outcome.json?.model;
          const error =
            outcome.status !== 200
              ? `HTTP ${outcome.status}: ${outcome.text.slice(0, 200)}`
              : typeof content !== "string"
                ? "no choices[0].message.content in response"
                : undefined;
          const record: GatewayQueryRecord = {
            seed,
            arm,
            id: item.id,
            factId: factIdOf(item),
            question: item.question,
            expected: item.answer,
            prediction,
            correct: !error && exactMatchJudge(prediction, item),
            tokenF1: error ? 0 : tokenF1(prediction, goldText(item)),
            requestId: outcome.requestId,
            receipt,
            injectedBytes: receipt?.present ? receipt.usedBytes : null,
            injectedTokens:
              receipt?.present && receipt.usedBytes !== null
                ? tokensFromBytes(receipt.usedBytes)
                : null,
            clientTokens,
            ...(typeof usage?.prompt_tokens === "number"
              ? { promptTokens: usage.prompt_tokens }
              : {}),
            ...(typeof usage?.completion_tokens === "number"
              ? { completionTokens: usage.completion_tokens }
              : {}),
            responseModel: typeof model === "string" ? model : null,
            status: outcome.status,
            latencyMs: outcome.latencyMs,
            ...(error ? { error } : {}),
          };
          seedRecords.push(record);
          if (record.responseModel && !responseModel) responseModel = record.responseModel;
          if (receipt?.present) {
            if (receipt.entity && !entityResolved) entityResolved = receipt.entity;
            if (receipt.budgetBytes !== null) {
              if (observedBudget === null) observedBudget = receipt.budgetBytes;
              if (r.budget !== null && receipt.budgetBytes !== r.budget) budgetMismatches++;
            }
          }
          if (arm === "off" && receipt !== null) {
            warnings.push(
              `seed ${seed} ${item.id}: the off arm received a receipt header — X-Marina-Context: off was not honored (unbound key?)`,
            );
          }
        }
      }

      // Fail fast after the first seed when the injected arm never produced a receipt.
      const injectedOk = seedRecords.filter((x) => x.arm === "injected" && !x.error);
      if (injectedOk.length > 0 && injectedOk.every((x) => x.receipt === null)) {
        throw new GatewayPreflightError(
          `seed ${seed}: ${injectedOk.length} injected requests succeeded but none carried x-marina-memory-receipt — memory injection is not happening. Check:\n  - ${BINDING_CHECKLIST.join("\n  - ")}`,
        );
      }
      if (entityResolved && entityResolved !== r.entity) {
        throw new GatewayPreflightError(
          `receipts name entity "${entityResolved}" but --entity is "${r.entity}"; MODEL_API_KEYS and MEM_API_KEYS must bind the same entity`,
        );
      }

      const perArm = {} as GatewaySeedSummary["perArm"];
      for (const arm of GATEWAY_ARMS) {
        const ok = seedRecords.filter((x) => x.arm === arm && !x.error);
        const correct = ok.filter((x) => x.correct).length;
        perArm[arm] = {
          n: ok.length,
          correct,
          accuracy: ok.length > 0 ? correct / ok.length : 0,
          tokenF1Mean: mean(ok.map((x) => x.tokenF1)),
        };
      }
      perSeed.push({
        seed,
        splitFingerprint: split.fingerprint,
        seedSetSize: split.seedSet.length,
        evalSetSize: split.evalSet.length,
        seedIds: split.seedSet.map((i) => i.id),
        evalIds: split.evalSet.map((i) => i.id),
        reachable: split.reachable,
        notesSeeded,
        notesWiped,
        perArm,
      });
      records.push(...seedRecords);
      log(
        `  seed ${seed}: off=${fmtPct(perArm.off.accuracy)} injected=${fmtPct(perArm.injected.accuracy)} (n=${perArm.injected.n}, seeded ${notesSeeded}, wiped ${notesWiped})`,
      );
    }
  } catch (error) {
    // A fail-fast after seeding must not strand the seed notes in the namespace.
    await wipeUntilEmpty(client).catch(() => undefined);
    throw error;
  }
  // Leave the namespace clean (captures from the last seed included).
  await wipeUntilEmpty(client);

  if (budgetMismatches > 0) {
    warnings.push(
      `${budgetMismatches} receipt(s) reported budgetBytes != --budget ${r.budget}; the server budget is ${observedBudget}`,
    );
  }
  const stubs = records.filter((x) => x.receipt && !x.receipt.present && x.receipt.stub).length;
  if (stubs > 0) {
    warnings.push(
      `${stubs} receipt header(s) were the >2 KB stub; their injected bytes are unknown (usedBytes n/a) — use trace show <x-request-id> for the full receipt`,
    );
  }

  const arms = {} as Record<GatewayArm, GatewayArmMetrics>;
  for (const arm of GATEWAY_ARMS) {
    arms[arm] = computeArmMetrics(
      records.filter((x) => x.arm === arm),
      perSeed,
      arm,
    );
  }
  const finishedAt = new Date();
  const result: GatewayResult = {
    schema: GATEWAY_RESULT_SCHEMA,
    config: {
      endpoint: r.endpoint,
      entity: r.entity,
      entityResolved,
      apiKeyFingerprint: fingerprint(r.apiKey),
      memApiKeySameAsModelKey: r.memApiKey === r.apiKey,
      model: r.model,
      serverModels,
      responseModel,
      budgetBytes: { requested: r.budget, observed: observedBudget },
      dataset: GATEWAY_DATASET,
      datasetItems: items.length,
      seeds: r.seeds,
      splitMode: "paraphrase",
      splitSalt: r.splitSalt,
      seedFraction: r.seedFraction,
      seedingPath: GATEWAY_SEEDING_PATH,
      wipeBetweenSeeds: true,
      injectedHeader: "on",
      offHeader: "off",
      judge: "exact-match",
      temperature: r.temperature,
      requestTimeoutMs: r.requestTimeoutMs,
      harnessGitSha: gitSha(),
      harnessVersion: GATEWAY_HARNESS_VERSION,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    arms,
    lift: computeLift(arms.off, arms.injected),
    perSeed,
    items: records,
    warnings,
  };

  mkdirSync(r.resultsDir, { recursive: true });
  const stamp = timestamp(startedAt);
  const base = `${stamp}-gateway-${slug(responseModel ?? r.model)}`;
  const jsonPath = freshPath(r.resultsDir, base, ".json");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const markdown = renderGatewayMarkdown(result);
  const markdownPath = freshPath(r.resultsDir, base, ".md");
  writeFileSync(markdownPath, markdown);
  log(`\n${markdown}`);
  log(`Results: ${jsonPath}\n         ${markdownPath}`);
  return { result, jsonPath, markdownPath };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `gateway — lift per injected token for Marina's passthru memory gateway

Usage:
  bun --env-file=/dev/null run benchmarks/memory/gateway.ts --endpoint <url> --api-key <secret> --entity <name> [options]

Server requirements (the harness checks them and prints what is missing):
  MODEL_API_KEYS=<secret>:<entity>   bound key — a plain secret is anonymous and never injected
  MEM_API_KEYS=<secret>:<entity>     same entity — the harness seeds memory via POST /mem/notes
  endpoint mode passthru             PUT /api/model-endpoint {"mode":"passthru"} (default agents mode bypasses injection)
  an upstream provider key           e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY on the server
  memory injection on                local trust profile default; the harness also sends X-Marina-Context: on
  a DEDICATED entity                 the namespace is wiped before every seed (passthru captures exchanges)

Options:
  --endpoint <url>        Marina base URL (default http://localhost:3300)
  --api-key <secret>      MODEL_API_KEYS secret bound to --entity (or MARINA_API_KEY env)
  --mem-api-key <secret>  MEM_API_KEYS secret for the same entity (default: --api-key)
  --entity <name>         the bound entity / memory namespace (canonical: [A-Za-z0-9_]{1,20})
  --model <id>            model id to request (default marina)
  --seeds <n>             number of seeds (default 5)
  --seed-start <n>        first seed (default 1)
  --limit <n>             cap items before the split (even numbers keep paraphrase pairs)
  --split-salt <s>        salt for the split hash (default v1)
  --budget <bytes>        expected server budget (MARINA_PASSTHRU_INJECT_BYTES); verified against receipts.
                          A sweep is one server per budget: rerun with the env changed and a new --budget.
  --temperature <n>       sampling temperature (default: omitted, provider default)
  --timeout-ms <n>        per-request timeout (default ${DEFAULT_REQUEST_TIMEOUT_MS})
  --results-dir <dir>     default benchmarks/results/memory (gitignored)
  --force                 allow wiping an entity namespace that already holds notes
  --quiet
  --help
`;

export async function runCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      endpoint: { type: "string", default: "http://localhost:3300" },
      "api-key": { type: "string" },
      "mem-api-key": { type: "string" },
      entity: { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL_ID },
      seeds: { type: "string", default: "5" },
      "seed-start": { type: "string", default: "1" },
      limit: { type: "string" },
      "split-salt": { type: "string", default: DEFAULT_SPLIT_SALT },
      budget: { type: "string" },
      temperature: { type: "string" },
      "timeout-ms": { type: "string" },
      "results-dir": { type: "string" },
      force: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const apiKey = values["api-key"] ?? process.env.MARINA_API_KEY ?? process.env.MODEL_API_KEY;
  if (!apiKey || !values.entity) {
    console.error("--api-key and --entity are required (see --help)");
    return 2;
  }
  const num = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number(value);
  try {
    await runGatewayBenchmark({
      endpoint: values.endpoint!,
      apiKey,
      memApiKey: values["mem-api-key"],
      entity: values.entity,
      model: values.model,
      seeds: Number(values.seeds),
      seedStart: Number(values["seed-start"]),
      limit: num(values.limit),
      splitSalt: values["split-salt"],
      budget: num(values.budget),
      temperature: values.temperature === undefined ? null : Number(values.temperature),
      requestTimeoutMs: num(values["timeout-ms"]),
      resultsDir: values["results-dir"],
      force: values.force,
      quiet: values.quiet,
    });
    return 0;
  } catch (error) {
    if (error instanceof GatewayPreflightError) {
      console.error(`gateway: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(await runCli(Bun.argv.slice(2)));
}
