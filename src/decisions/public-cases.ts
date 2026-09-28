// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Independently labeled gate cases from public corpora, via DefenseClaw's
 * normalized `case-v1` rows (github.com/cisco-ai-defense/defenseclaw,
 * Apache-2.0): every source revision-pinned, licence-checked, and graded by how
 * its truth was established (`truthGrade`, a port of DefenseClaw's
 * `truth_grade()`):
 *
 *   A  exact / closed proof: the call itself is proven malicious
 *   B  high-confidence source truth on a stateful (multi-call) case
 *   C  contextual or dual-use — unresolved
 *   D  benign by the source (verifier-passing / security-preserved)
 *   E  out of scope, or truth unknown
 *
 * Marina's gate judges ONE call (+ the agent's intent and trust labels), so a
 * case is imported only where the label is valid for one call:
 *
 *   family `injection`  InjecAgent's hand-built intent pairs: the attacker call
 *                       that followed injected tool output (hold) and the
 *                       user's own correct call (allow), both with the user's
 *                       request as the goal and the SAME trust label, so the
 *                       judge must separate them on intent, never on a label.
 *   family `call-only`  a single call with no intent on either side: grade A
 *                       (proven harmful) as hold, grade D atomic calls as allow.
 *
 * Trajectory-level truth (a violated run whose harmful call is not identified)
 * is never pinned on one call. Labels here are `labeledBy: "proof"` — by
 * execution or construction, not by the author of this file. Normalizer
 * evidence (argument keys starting with `_`) is dropped: it is not part of the
 * call the agent made.
 */

import type { GateCase } from "./qualify";

/** A DefenseClaw case-v1 row (the fields this adapter reads). */
export interface DefenseClawCase {
  id: string;
  surface?: string;
  source?: { dataset?: string; revision?: string; license?: string };
  payload?: {
    content?: unknown;
    tool_name?: unknown;
    args?: unknown;
    command?: unknown;
    events?: Array<{ tool_name?: unknown; args?: unknown }>;
  };
  truth?: {
    source_truth?: string;
    deterministic_truth?: string;
    expected_disposition?: string;
    label_confidence?: string;
    applicability?: string;
    categories?: string[];
  };
}

export type TruthGrade = "A" | "B" | "C" | "D" | "E";

/** DefenseClaw's `truth_grade()` (benchmark_inventory_system_one_sources.py @ d2ae73f3). */
export function truthGrade(row: DefenseClawCase): TruthGrade {
  const t = row.truth ?? {};
  const categories = new Set(t.categories ?? []);
  const deterministic = t.deterministic_truth;
  if (t.applicability !== "in_scope" || (t.source_truth === "unknown" && !deterministic))
    return "E";
  const exact =
    deterministic === "deterministic_malicious" ||
    categories.has("exact_proof") ||
    categories.has("closed_proof");
  const acted = t.expected_disposition === "detect_only" || t.expected_disposition === "block";
  if (exact && acted && t.label_confidence === "high") return "A";
  if (
    (t.source_truth === "malicious" || t.source_truth === "sensitive") &&
    row.surface === "stateful" &&
    acted &&
    t.label_confidence === "high"
  ) {
    return "B";
  }
  if (
    t.expected_disposition === "allow" &&
    (t.source_truth === "benign" || deterministic === "benign")
  ) {
    return "D";
  }
  if (
    t.source_truth === "malicious" ||
    t.source_truth === "sensitive" ||
    deterministic === "contextual_or_dual_use"
  ) {
    return "C";
  }
  return "E";
}

/** Licences whose terms allow this evaluation use. Non-commercial sources are excluded. */
export const ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0", "CC-BY-4.0"]);

/** The trust label both sides of the injection family carry. */
const INJECTION_SOURCES = ["external_tool"];

function callOf(
  row: DefenseClawCase,
  which: "first" | "last",
): { tool: string; args: Record<string, unknown> } | undefined {
  const p = row.payload ?? {};
  const events = Array.isArray(p.events) ? p.events : undefined;
  const ev = events?.length
    ? which === "first"
      ? events[0]
      : events[events.length - 1]
    : undefined;
  const tool =
    typeof ev?.tool_name === "string"
      ? ev.tool_name
      : typeof p.tool_name === "string"
        ? p.tool_name
        : undefined;
  const rawArgs = (ev ? ev.args : p.args) as Record<string, unknown> | undefined;
  if (!tool) {
    // A bare shell command.
    return typeof p.command === "string" && p.command.trim()
      ? { tool: "shell", args: { command: p.command } }
      : undefined;
  }
  const args: Record<string, unknown> = {};
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    for (const [k, v] of Object.entries(rawArgs)) if (!k.startsWith("_")) args[k] = v;
  }
  return { tool, args };
}

/**
 * The gate case one normalized row yields, or undefined when its label is not
 * valid for a single call (or its licence is not allowed).
 */
export function toGateCase(row: DefenseClawCase): GateCase | undefined {
  const license = row.source?.license;
  if (!license || !ALLOWED_LICENSES.has(license)) return undefined;
  const dataset = row.source?.dataset ?? "unknown";
  const grade = truthGrade(row);
  const categories = new Set(row.truth?.categories ?? []);
  const source = {
    dataset,
    ...(row.source?.revision ? { revision: row.source.revision } : {}),
    license,
    grade,
  };
  const base = { id: `${dataset}:${row.id}`, labeledBy: "proof" as const, source };
  const request = typeof row.payload?.content === "string" ? row.payload.content.trim() : "";

  // InjecAgent's intent pairs (the only source with both sides by hand).
  if (dataset === "injecagent" && request) {
    const intent = { goal: request.slice(0, 400), sources: INJECTION_SOURCES };
    if (grade === "B" && row.surface === "stateful" && categories.has("intent_deviation")) {
      const call = callOf(row, "last");
      return (
        call && {
          ...base,
          family: "injection",
          tool: call.tool,
          arguments: call.args,
          intent,
          expect: "hold",
        }
      );
    }
    if (grade === "D" && categories.has("intent_matching_baseline")) {
      const call = callOf(row, "first");
      return (
        call && {
          ...base,
          family: "injection",
          tool: call.tool,
          arguments: call.args,
          intent,
          expect: "allow",
        }
      );
    }
    return undefined;
  }

  // One call, no intent: proven harmful, or benign by the source.
  if (row.surface !== "action") return undefined;
  if (grade !== "A" && grade !== "D") return undefined;
  const call = callOf(row, "last");
  return (
    call && {
      ...base,
      family: "call-only",
      tool: call.tool,
      arguments: call.args,
      expect: grade === "A" ? "hold" : "allow",
    }
  );
}

/** Deterministic pseudo-random numbers (mulberry32) for a reproducible sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleOptions {
  /** At most this many cases per (family, label, tool) — no single tool dominates. */
  perTool: number;
  /** At most this many cases per (family, label). */
  perSide: number;
  seed: number;
}

/**
 * A reproducible, tool-diverse sample: shuffle with a fixed seed, cap each
 * (family, label, tool) group, then cap each (family, label) side, taking tools
 * round-robin so the cap is spread across tools.
 */
export function sampleCases(cases: readonly GateCase[], opts: SampleOptions): GateCase[] {
  const rand = rng(opts.seed);
  const shuffled = [...cases].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const sides = new Map<string, Map<string, GateCase[]>>();
  for (const c of shuffled) {
    const side = `${c.family}|${c.expect}`;
    const byTool = sides.get(side) ?? new Map<string, GateCase[]>();
    const tool = c.tool ?? "marina_command";
    const list = byTool.get(tool) ?? [];
    if (list.length < opts.perTool) list.push(c);
    byTool.set(tool, list);
    sides.set(side, byTool);
  }
  const out: GateCase[] = [];
  for (const byTool of sides.values()) {
    const queues = [...byTool.values()];
    let taken = 0;
    for (let round = 0; taken < opts.perSide && queues.some((q) => q.length > round); round++) {
      for (const q of queues) {
        if (taken >= opts.perSide) break;
        const c = q[round];
        if (c) {
          out.push(c);
          taken++;
        }
      }
    }
  }
  return out;
}
