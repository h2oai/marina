// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalPortableMemory } from "./memory-portable";
import type {
  MemoryRetrievalInput,
  MemoryRetrievalResult,
  MemoryRetrievedEvidence,
} from "./memory-types";

export type MemorySelection = "sources_first" | "balanced" | "records_first";
export interface MemoryRecipe {
  schema: "marina.memory.policy.v1";
  name: string;
  description: string;
  retrieval: Omit<MemoryRetrievalInput, "task" | "observe" | "use_model">;
  prerequisites: string[];
  exceptions: string[];
  compatibility: "marina.memory.retrieval.v1";
  evidence: { space_id: string; id: string; version: number }[];
}
export interface MemoryRetrievalObservation {
  schema: "marina.memory.observation.v1";
  input: MemoryRetrievalInput;
  result: MemoryRetrievalResult;
  /** Authored/exported observations are evidence, not certified executions. */
  attribution: string;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The same bounded selection interpreter is used by live reads and offline comparisons. */
export function selectMemoryEvidence(
  candidates: MemoryRetrievedEvidence[],
  selection: MemorySelection,
  budget: { max_results: number; max_bytes: number },
): { evidence: MemoryRetrievedEvidence[]; bytes: number; omitted: number; clipped: boolean } {
  if (
    !["sources_first", "balanced", "records_first"].includes(selection) ||
    !Number.isSafeInteger(budget.max_results) ||
    budget.max_results < 1 ||
    budget.max_results > 20 ||
    !Number.isSafeInteger(budget.max_bytes) ||
    budget.max_bytes < 256 ||
    budget.max_bytes > 65536
  )
    throw new RangeError("Invalid evidence selection or budget");
  const sources = candidates.filter((item) => item.kind === "source");
  const records = candidates.filter((item) => item.kind === "record");
  let ordered: MemoryRetrievedEvidence[];
  if (selection === "balanced") {
    ordered = [];
    for (let i = 0; i < Math.max(sources.length, records.length); i++) {
      if (records[i]) ordered.push(records[i]!);
      if (sources[i]) ordered.push(sources[i]!);
    }
  } else
    ordered = selection === "records_first" ? [...records, ...sources] : [...sources, ...records];
  const evidence: MemoryRetrievedEvidence[] = [];
  let clipped = false;
  for (let item of ordered) {
    if (evidence.length >= budget.max_results) break;
    const reserve =
      selection === "balanced" &&
      budget.max_results > 1 &&
      !evidence.some((entry) => entry.kind !== item.kind) &&
      candidates.some((entry) => entry.kind !== item.kind);
    const itemBudget = reserve
      ? bytes(evidence) + Math.floor((budget.max_bytes - bytes(evidence)) / 2)
      : budget.max_bytes;
    if (bytes([...evidence, item]) > itemBudget && item.kind === "source") {
      const original = item;
      const encoded = new TextEncoder().encode(original.text);
      let low = 0,
        high = encoded.length;
      const clip = (length: number) => {
        while (length > 0 && length < encoded.length && (encoded[length]! & 0xc0) === 0x80)
          length--;
        const end = original.start + length;
        return {
          ...original,
          text: new TextDecoder().decode(encoded.slice(0, length)),
          end,
          next_start: end < original.total_bytes ? end : null,
        };
      };
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes([...evidence, clip(middle)]) <= itemBudget) low = middle;
        else high = middle - 1;
      }
      item = clip(low);
      clipped ||= item.end !== original.end;
      if (!item.text) continue;
    }
    if (bytes([...evidence, item]) <= itemBudget) evidence.push(item);
  }
  return {
    evidence,
    bytes: bytes(evidence),
    omitted: candidates.length - evidence.length,
    clipped,
  };
}

/** No I/O. Different discovery, temporal context, or larger observation envelopes require a live trial. */
export function compareMemoryRecipes(
  observation: MemoryRetrievalObservation,
  recipes: MemoryRecipe[],
) {
  const { result, input } = observation;
  const discovery = (value: MemoryRetrievalInput) =>
    canonicalPortableMemory({
      task: value.task,
      steps: value.steps ?? null,
      expansion: value.expansion ?? null,
      requirements: value.requirements ?? [],
      source_bytes: value.source_bytes ?? 2048,
      broaden: value.broaden ?? true,
      use_model: value.use_model ?? false,
      valid_at: value.valid_at ?? result.valid_at,
    });
  return {
    schema: "marina.experience.comparison.v1" as const,
    attribution: observation.attribution,
    context: {
      space_id: result.space_id,
      retrieval_generation: result.retrieval_generation,
      vocabulary_version: result.vocabulary_version,
      valid_at: result.valid_at,
    },
    candidates: recipes.map((recipe) => {
      const requested: MemoryRetrievalInput = {
        ...recipe.retrieval,
        task: input.task,
        use_model: false,
      };
      const maxResults = requested.max_results ?? 6;
      const maxBytes = requested.max_bytes ?? 8192;
      if (
        result.selection_contract !== "marina-evidence-selection-v1" ||
        recipe.schema !== "marina.memory.policy.v1" ||
        recipe.compatibility !== "marina.memory.retrieval.v1" ||
        !result.observed_candidates ||
        discovery(requested) !== discovery(input) ||
        maxResults > result.budget.max_results ||
        maxBytes > result.budget.max_bytes ||
        maxResults < 1 ||
        maxBytes < 256
      ) {
        return {
          name: recipe.name,
          status: "unsupported" as const,
          reason: "Requires an unobserved read or a larger envelope; run a new live trial.",
        };
      }
      const selected = selectMemoryEvidence(
        result.observed_candidates,
        requested.selection ?? "sources_first",
        { max_results: maxResults, max_bytes: maxBytes },
      );
      return {
        name: recipe.name,
        status: "observed_only" as const,
        ...selected,
        discovery_truncated: result.diagnostics.discovery_truncated,
      };
    }),
    answer_quality: "not_assessed" as const,
    limitations: [
      "Selection comparison over recorded candidates only; no simulated model answers, correctness scores or counterfactual latency.",
    ],
  };
}
