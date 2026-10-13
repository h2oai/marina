// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * IFBench through a Marina `/v1`: answer each prompt with one chat completion,
 * grade with the official IFBench grader (`run_eval`, unmodified), and turn its
 * per-prompt verdicts into a ledger file. There is no agent harness: the answer
 * is the model's single reply, so this module owns the small request loop.
 *
 * Ledger items are keyed by the input's `key`; correct = `follow_all_instructions`,
 * score = the fraction of the prompt's instructions followed. Prompt and response
 * text never reach the ledger — they are only read locally to match the grader's
 * output (which has no key) back to its input.
 */

import type { HarnessResultFile } from "../../src/engine/benchmark-ledger";

/** The ledger's benchmark id for strict grading (also the `x-marina-eval` board name). */
export const IFBENCH_BENCHMARK = "ifbench";

export type IfbenchMode = "strict" | "loose";

/** One line of the IFBench input JSONL (only what this module reads). */
export interface IfbenchInput {
  key: string | number;
  prompt: string;
  [k: string]: unknown;
}

/** One line this module writes for the grader (`prompt`, `response`) plus local bookkeeping. */
export interface IfbenchResponse {
  key: string | number;
  prompt: string;
  response: string;
  model?: string;
  latencyMs?: number;
  traceId?: string;
  /** Set when no answer was obtained (an infrastructure failure, never a model answer). */
  error?: string;
}

/** One line of the grader's `eval_results_<mode>.jsonl`. */
export interface IfbenchGraded {
  prompt?: string;
  follow_all_instructions?: boolean;
  follow_instruction_list?: boolean[];
}

/** Parse JSONL text (blank lines skipped). Throws on a malformed line, naming it. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
  }
  return out;
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** The first `limit` inputs, in file order (the kit's fixed, reproducible subset). */
export function subsetInputs(inputs: readonly IfbenchInput[], limit?: number): IfbenchInput[] {
  return limit === undefined ? [...inputs] : inputs.slice(0, Math.max(0, limit));
}

/** `KEY=VALUE` header flags → a header record (the value may itself contain `=`). */
export function parseHeaderFlags(flags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const at = f.indexOf("=");
    if (at <= 0) throw new Error(`header must be KEY=VALUE (got '${f}')`);
    out[f.slice(0, at).trim()] = f.slice(at + 1).trim();
  }
  return out;
}

export interface AnswerOptions {
  /** Marina base URL (`http://localhost:<port>`); `/v1/chat/completions` is appended. */
  endpoint: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  concurrency?: number;
  /** Extra attempts after a transport error or a 502/503/504 (default 2). */
  retries?: number;
  fetch?: typeof fetch;
  /** Wait before a retry (injectable so tests never sleep). */
  wait?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([502, 503, 504]);

function replyText(body: unknown): string | undefined {
  const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("");
  }
  return undefined;
}

async function answerOne(inp: IfbenchInput, o: AnswerOptions): Promise<IfbenchResponse> {
  const doFetch = o.fetch ?? fetch;
  const wait = o.wait ?? ((ms: number) => Bun.sleep(ms));
  const url = `${o.endpoint.replace(/\/+$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(o.headers ?? {}),
    ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
  };
  const body = JSON.stringify({
    model: o.model,
    messages: [{ role: "user", content: inp.prompt }],
  });
  const base = { key: inp.key, prompt: inp.prompt, model: o.model };
  let lastError = "no attempt";
  for (let attempt = 0; attempt <= (o.retries ?? 2); attempt++) {
    if (attempt > 0) await wait(2000 * attempt);
    const started = Date.now();
    try {
      const resp = await doFetch(url, { method: "POST", headers, body });
      const traceId = resp.headers.get("x-request-id") ?? undefined;
      const text = await resp.text();
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
        if (RETRYABLE.has(resp.status)) continue;
        break;
      }
      const reply = replyText(JSON.parse(text) as unknown);
      if (reply === undefined) {
        lastError = "reply has no message content";
        break;
      }
      return {
        ...base,
        response: reply,
        latencyMs: Date.now() - started,
        ...(traceId ? { traceId } : {}),
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  // The grader still gets a line (an empty response fails every instruction);
  // the converter sees `error` and treats the prompt as an infrastructure failure.
  return { ...base, response: "", error: lastError };
}

/** Answer every input, at most `concurrency` at a time; output order = input order. */
export async function answerAll(
  inputs: readonly IfbenchInput[],
  o: AnswerOptions,
): Promise<IfbenchResponse[]> {
  const out: IfbenchResponse[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const i = next++;
      out[i] = await answerOne(inputs[i]!, o);
    }
  };
  const n = Math.max(1, Math.min(o.concurrency ?? 4, inputs.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** Which grader output file holds `mode` (upstream names it `eval_results_<mode>.jsonl`, forks prefix it). */
export function gradedFileFor(files: readonly string[], mode: IfbenchMode): string | undefined {
  const matches = files.filter((f) => f.endsWith(`eval_results_${mode}.jsonl`));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface IfbenchConversion {
  file: HarnessResultFile;
  infrastructure: string[];
}

/**
 * Grader verdicts → the harness result shape `benchmark:import` reads. Every
 * input must have a graded line (matched by prompt text, as the grader matches
 * responses) and an answer without `error`; anything else is an infrastructure
 * failure, filed as a fallback.
 */
export function ifbenchToHarness(
  inputs: readonly IfbenchInput[],
  graded: readonly IfbenchGraded[],
  responses: readonly IfbenchResponse[],
  opts: { mode?: IfbenchMode; model?: string; stack?: string } = {},
): IfbenchConversion {
  const mode = opts.mode ?? "strict";
  const byPrompt = new Map<string, IfbenchGraded>();
  for (const g of graded) {
    if (typeof g.prompt !== "string") continue;
    byPrompt.set(g.prompt, g);
    byPrompt.set(g.prompt.trim(), g);
  }
  const answers = new Map(responses.map((r) => [String(r.key), r]));
  const infrastructure: string[] = [];
  const items: NonNullable<HarnessResultFile["items"]> = [];
  let durationMs = 0;
  for (const inp of inputs) {
    const id = String(inp.key);
    const g = byPrompt.get(inp.prompt) ?? byPrompt.get(inp.prompt.trim());
    const a = answers.get(id);
    const reason = !a
      ? "no answer"
      : a.error
        ? `no answer (${a.error.slice(0, 120)})`
        : !g
          ? "not graded"
          : undefined;
    if (reason) infrastructure.push(`${id}: ${reason}`);
    const followed = g?.follow_instruction_list ?? [];
    durationMs += a?.latencyMs ?? 0;
    items.push({
      id,
      correct: !reason && g?.follow_all_instructions === true,
      ...(followed.length && !reason
        ? { score: followed.filter(Boolean).length / followed.length }
        : {}),
      ...(typeof a?.latencyMs === "number" ? { latencyMs: a.latencyMs } : {}),
      ...(a?.traceId ? { traceId: a.traceId } : {}),
      ...(reason ? { fallback: true } : {}),
    });
  }
  return {
    file: {
      config: {
        dataset: mode === "strict" ? IFBENCH_BENCHMARK : `${IFBENCH_BENCHMARK}-${mode}`,
        model: opts.model ?? responses.find((r) => r.model)?.model ?? "unknown",
        lessons_mode: "measure",
        judge: { model: `IFBench official grader (${mode})` },
        ...(opts.stack ? { stack: opts.stack } : {}),
        infrastructureErrors: infrastructure.length,
      },
      timestamp: Date.now(),
      duration_ms: durationMs,
      items,
    },
    infrastructure,
  };
}
