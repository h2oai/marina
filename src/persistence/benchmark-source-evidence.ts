// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalJson } from "../engine/benchmark-ledger";
import type { ResolvedParticipant } from "../engine/benchmark-participants";

export interface BenchmarkSourceItem {
  item_id: string;
  correct: number;
  score: number | null;
  trace_id: string | null;
  participants: ResolvedParticipant[];
}

/** Local operator evidence; a hash provides integrity, not remote attestation. */
export interface BenchmarkSourceEvidence {
  schema: "marina.benchmark.source-evidence.v1";
  sourceRunId: string;
  benchmark: string;
  items: BenchmarkSourceItem[];
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}

/** Copy an allowlist only: no prompts, answers, credentials, or arbitrary nested payloads. */
export function sourceParticipants(value: unknown): ResolvedParticipant[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid source participants");
  return value.map((p) => {
    if (
      !p ||
      typeof p !== "object" ||
      (!identifier(p.agent) && !identifier(p.model)) ||
      (p.agent !== undefined && !identifier(p.agent)) ||
      (p.model !== undefined && !identifier(p.model)) ||
      (p.via !== "trace" && p.via !== "window") ||
      !Number.isSafeInteger(p.turns) ||
      p.turns < 1 ||
      (p.costUsd !== undefined && (!Number.isFinite(p.costUsd) || p.costUsd < 0)) ||
      (p.shared !== undefined && typeof p.shared !== "boolean") ||
      (p.tracedShared !== undefined && typeof p.tracedShared !== "boolean")
    ) {
      throw new Error("Source participant lacks valid trace/window evidence");
    }
    return {
      ...(p.agent ? { agent: p.agent } : {}),
      ...(p.model ? { model: p.model } : {}),
      via: p.via,
      turns: p.turns,
      ...(p.costUsd !== undefined ? { costUsd: p.costUsd } : {}),
      ...(p.shared !== undefined ? { shared: p.shared } : {}),
      ...(p.tracedShared !== undefined ? { tracedShared: p.tracedShared } : {}),
    };
  });
}

export function normalizeSourceEvidence(
  evidence: BenchmarkSourceEvidence,
): BenchmarkSourceEvidence {
  if (
    evidence.schema !== "marina.benchmark.source-evidence.v1" ||
    !identifier(evidence.sourceRunId) ||
    !identifier(evidence.benchmark) ||
    !Array.isArray(evidence.items) ||
    evidence.items.length < 1 ||
    evidence.items.length > 20_000
  ) {
    throw new Error("Invalid source evidence envelope");
  }
  const ids = new Set<string>();
  const items = evidence.items
    .map((it) => {
      if (
        !identifier(it.item_id) ||
        ids.has(it.item_id) ||
        (it.correct !== 0 && it.correct !== 1) ||
        (it.score !== null && !Number.isFinite(it.score)) ||
        (it.trace_id !== null && !identifier(it.trace_id))
      )
        throw new Error("Invalid source item identity/outcome");
      ids.add(it.item_id);
      const participants = sourceParticipants(it.participants);
      if (participants.length > 0 && !it.trace_id)
        throw new Error("Source participants require an item trace ID");
      return {
        item_id: it.item_id,
        correct: it.correct,
        score: it.score,
        trace_id: it.trace_id,
        participants,
      };
    })
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
  return {
    schema: evidence.schema,
    sourceRunId: evidence.sourceRunId,
    benchmark: evidence.benchmark,
    items,
  };
}

export function sourceEvidenceHash(evidence: BenchmarkSourceEvidence): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeSourceEvidence(evidence)))
    .digest("hex");
}
