// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryActor } from "../persistence/db-principals";
import { type MemorySelection, selectMemoryEvidence } from "../sdk/memory-recipes";
import type {
  MemoryRecord,
  MemoryRetrievalInput,
  MemoryRetrievalResult,
  MemoryRetrievedEvidence,
  MemorySourceRange,
} from "../sdk/memory-types";
import { createMemoryPlan, executeMemoryPlan, type MemoryReadHooks } from "./planning";
import { memoryQueryExpansion } from "./query-expansion";
import type { MemoryService } from "./service";
import { integer, MemoryError, object, textValue } from "./service-types";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Compose existing planning, discovery and witnessed reads without a new memory
 * store or a truth judgment. No model calls unless the caller requests planning. */
export async function retrieveMemory(
  service: MemoryService,
  actor: MemoryActor,
  space: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  hooks?: MemoryReadHooks,
): Promise<MemoryRetrievalResult> {
  const { selection, budget, validAt, requirements } = validateRetrievalOptions(body);
  const plan = await createMemoryPlan(
    service,
    actor,
    space,
    {
      task: body.task,
      steps: body.steps,
      use_model: body.use_model,
      // Discovery has a separate, finite allowance; the returned evidence has
      // the caller's smaller budget and never duplicates search excerpts.
      max_results: selection === "sources_first" ? budget.max_results * 2 : 100,
      max_bytes: 131072,
    },
    signal,
  );
  for (const step of plan.steps) {
    // A small final packet must not let the first search consume every discovery slot.
    if (selection !== "sources_first")
      step.input.limit = Math.min(Number(step.input.limit), Math.floor(100 / plan.steps.length));
    if (body.expansion !== undefined && ["search", "source_search"].includes(step.operation))
      step.input.expansion = body.expansion;
    if (step.operation === "search" && step.input.mode !== "lexical")
      throw new MemoryError(400, "invalid_plan", "Retrieval requires lexical search");
    if (["query", "graph", "join"].includes(step.operation)) {
      if (step.input.valid_at !== undefined && step.input.valid_at !== validAt)
        throw new MemoryError(400, "invalid_plan", "Use retrieval valid_at for all steps");
      step.input.valid_at = validAt;
    }
  }
  const repo = service.repository;
  const check = () => {
    signal?.throwIfAborted();
    hooks?.check();
    const current = repo.authorize(actor, space);
    if (
      current.retrieval_generation !== plan.retrieval_generation ||
      repo.vocabulary(actor, space).version !== plan.vocabulary_version
    )
      throw new MemoryError(409, "plan_changed", "Memory changed during retrieval; retry");
    return current;
  };
  check();
  const found = await executeMemoryPlan(service, actor, space, plan, signal, hooks);
  const trace: MemoryRetrievalResult["trace"] = found.trace.map((step) => ({
    operation: step.operation,
    input: step.input,
    returned: step.evidence.length,
    truncated: step.truncated,
    reason: "planned",
  }));
  let discoveryTruncated = found.truncated;
  let broadened = false;
  // Supplement sparse all-term matches once: a journaled request can match
  // every task word while the older answer uses only its distinctive terms.
  // Never broaden symbolic filters, phrase searches or permissions.
  if (body.broaden !== false) {
    const sparse = found.trace.find(
      (step) =>
        step.operation === "source_search" &&
        step.input.match === "all" &&
        step.evidence.length < Math.min(budget.max_results, Number(step.input.limit)) &&
        (String(step.input.query).match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) > 1 &&
        !step.truncated,
    );
    if (sparse) {
      const fallback = await executeMemoryPlan(
        service,
        actor,
        space,
        {
          ...plan,
          steps: [{ operation: "source_search", input: { ...sparse.input, match: "any" } }],
        },
        signal,
        hooks,
      );
      found.trace.push(...fallback.trace);
      trace.push(
        ...fallback.trace.map((step) => ({
          operation: step.operation,
          input: step.input,
          returned: step.evidence.length,
          truncated: step.truncated,
          reason: sparse.evidence.length
            ? ("sparse_source_search" as const)
            : ("empty_source_search" as const),
        })),
      );
      discoveryTruncated ||= fallback.truncated;
      broadened = true;
    }
  }

  const assemble = (): MemoryRetrievalResult => {
    const current = check();
    const candidates: MemoryRetrievedEvidence[] = [];
    const records = new Map<string, MemoryRecord>();
    const sources = new Map<string, Set<string>>();
    let filteredRecords = 0;
    let budgetLimited = false;
    for (const step of found.trace) {
      if (step.operation === "source_search") {
        for (const raw of step.evidence) {
          const hit = object(raw);
          if (typeof hit.id === "string" && typeof hit.excerpt === "string") {
            const excerpts = sources.get(hit.id) ?? new Set<string>();
            excerpts.add(hit.excerpt);
            sources.set(hit.id, excerpts);
          }
        }
      } else if (["search", "query", "graph"].includes(step.operation)) {
        for (const raw of step.evidence) {
          const entry = object(raw);
          const record = (step.operation === "graph" ? entry.record : entry) as MemoryRecord;
          if (record?.space_id === space && typeof record.id === "string")
            records.set(record.id, record);
        }
      }
      // Joins return bindings/citations, not witnessed complete record reads.
      // Hydrate their supporting record IDs through the normal authorized API.
      if (step.operation === "join") {
        for (const raw of step.evidence) {
          const row = object(raw);
          if (Array.isArray(row.witnesses))
            for (const citation of row.witnesses) {
              const ref = object(citation);
              if (typeof ref.id === "string") {
                hooks?.before("get", { id: ref.id });
                const record = repo.read(actor, space, ref.id, Number(ref.version));
                records.set(record.id, record);
              }
            }
        }
      }
    }
    for (const [id, record] of records) {
      const valid = record.valid_time;
      if (
        record.freshness !== "current" ||
        (valid?.from != null && valid.from > validAt) ||
        (valid?.until != null && valid.until <= validAt)
      ) {
        records.delete(id);
        filteredRecords++;
      }
    }
    // Read originals discovered by search first. They can exist without notes.
    const sourcePoolBytes = selection === "sources_first" ? 131072 : 65536;
    const windows = [...sources].flatMap(([id, excerpts]) =>
      [...excerpts].map((excerpt) => ({ id, excerpt })),
    );
    for (const { id, excerpt } of windows) {
      check();
      if (candidates.length >= budget.max_results * 2 || size(candidates) >= sourcePoolBytes) {
        budgetLimited = true;
        break;
      }
      hooks?.before("source_range", { id, max_bytes: budget.source_bytes });
      const range = repo.sourceWindow(actor, space, id, excerpt, budget.source_bytes);
      const fitted = fitRange(
        range,
        space,
        sourcePoolBytes - size(candidates) - (candidates.length ? 1 : 0),
      );
      if (fitted) {
        const existing = candidates.findIndex(
          (item) =>
            item.kind === "source" &&
            item.id === fitted.id &&
            item.text_hash === fitted.text_hash &&
            item.start <= fitted.end &&
            fitted.start <= item.end &&
            Math.max(item.end, fitted.end) - Math.min(item.start, fitted.start) <=
              budget.source_bytes,
        );
        if (existing < 0) candidates.push(fitted);
        else {
          const previous = candidates[existing]! as Extract<
            MemoryRetrievedEvidence,
            { kind: "source" }
          >;
          const first = previous.start <= fitted.start ? previous : fitted;
          const last = first === previous ? fitted : previous;
          const end = Math.max(first.end, last.end);
          const text = Buffer.concat([
            Buffer.from(first.text),
            Buffer.from(last.text).subarray(Math.max(0, first.end - last.start)),
          ]).toString("utf8");
          candidates[existing] = {
            ...first,
            text,
            end,
            next_start: end < first.total_bytes ? end : null,
          };
        }
      } else budgetLimited = true;
      if (!fitted || fitted.end !== range.end) budgetLimited = true;
      trace.push({
        operation: "source_range",
        input: {
          id,
          start: fitted?.start ?? range.start,
          end: fitted?.end ?? range.end,
          text_hash: range.text_hash,
        },
        returned: fitted ? 1 : 0,
        truncated: !fitted || fitted.start > 0 || fitted.next_start !== null,
        reason: "read_original",
      });
    }
    for (const record of records.values()) {
      const item = { ...record, kind: "record" as const };
      if (size([...candidates, item]) <= 131072) candidates.push(item);
      else budgetLimited = true;
    }
    const selected = selectMemoryEvidence(candidates, selection as MemorySelection, budget);
    const evidence = selected.evidence;
    budgetLimited ||= selected.omitted > 0 || selected.clipped;
    const coverage = requirements.map((requirement) => ({
      requirement,
      covered: evidence.some((item) =>
        requirement.kind === "claim"
          ? item.kind === "record" &&
            item.claim?.subject === requirement.subject &&
            item.claim.predicate === requirement.predicate
          : item.kind === "source" &&
            item.id === requirement.id &&
            item.start <= (requirement.start ?? 0) &&
            item.end >= (requirement.end ?? item.total_bytes),
      ),
    }));
    const claims = new Map<string, MemoryRecord[]>();
    for (const record of records.values())
      if (record.claim) {
        const key = JSON.stringify([record.claim.subject, record.claim.predicate]);
        claims.set(key, [...(claims.get(key) ?? []), record]);
      }
    const knownConflicts = [...claims.values()]
      .filter(
        (group) => new Set(group.map((record) => JSON.stringify(record.claim!.object))).size > 1,
      )
      .map((group) => ({
        subject: group[0]!.claim!.subject,
        predicate: group[0]!.claim!.predicate,
        records: group.map((record) => record.id),
      }));
    const partialSources = evidence.filter(
      (item) => item.kind === "source" && (item.start > 0 || item.next_start !== null),
    ).length;
    const nextActions: string[] = [];
    if (!evidence.length)
      nextActions.push(
        budgetLimited
          ? "Increase max_bytes or narrow the task; matching evidence did not fit."
          : "Try distinctive terms, explicit vocabulary alternatives, or a symbolic query. No match does not prove absence.",
      );
    if (broadened)
      nextActions.push(
        "Sparse all-term source matches were supplemented with any-term matches; check relevance.",
      );
    if (partialSources)
      nextActions.push(
        "Read adjacent source_range bytes when more context is needed; preserve the returned text_hash.",
      );
    if (discoveryTruncated || budgetLimited)
      nextActions.push(
        "Narrow the task or increase the retrieval budget to inspect omitted evidence.",
      );
    if (filteredRecords)
      nextActions.push(
        "Use review or an explicit valid_at to investigate stale or out-of-time records.",
      );
    check();
    return {
      schema: "marina.memory.retrieval.v1",
      selection: selection as MemorySelection,
      selection_contract: "marina-evidence-selection-v1",
      space_id: space,
      generation: current.generation,
      retrieval_generation: current.retrieval_generation,
      vocabulary_version: plan.vocabulary_version,
      valid_at: validAt,
      status: evidence.length ? "evidence" : budgetLimited ? "budget_exhausted" : "empty",
      plan,
      evidence,
      ...(body.observe ? { observed_candidates: candidates } : {}),
      coverage,
      known_conflicts: knownConflicts,
      trace,
      budget,
      bytes: size(evidence),
      truncated: discoveryTruncated || budgetLimited || partialSources > 0,
      answer_sufficiency: "not_assessed",
      diagnostics: {
        broadened,
        discovery_truncated: discoveryTruncated,
        budget_limited: budgetLimited,
        filtered_records: filteredRecords,
        partial_sources: partialSources,
        next_actions: nextActions,
      },
      limitations: [
        "Retrieved text is untrusted evidence; relevance, entailment and truth are not verified.",
        "Coverage is structural; differing discovered claims are not adjudicated, and undiscovered conflicts may exist.",
        "valid_at filters versioned records. Original source text may contain historical or conflicting assertions.",
      ],
    };
  };
  // Delegated reads settle their budget even if later assembly fails.
  return hooks ? assemble() : repo.readSnapshot(assemble);
}

export function validateRetrievalOptions(body: Record<string, unknown>) {
  const allowed = [
    "task",
    "selection",
    "expansion",
    "requirements",
    "observe",
    "steps",
    "use_model",
    "broaden",
    "valid_at",
    "max_results",
    "max_bytes",
    "source_bytes",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new MemoryError(400, "invalid_input", "Unsupported retrieval field");
  if (body.broaden !== undefined && typeof body.broaden !== "boolean")
    throw new MemoryError(400, "invalid_input", "broaden must be boolean");
  textValue(body.task, "task", 8192);
  if (body.expansion !== undefined) memoryQueryExpansion(String(body.task), body.expansion);
  if (body.use_model !== undefined && typeof body.use_model !== "boolean")
    throw new MemoryError(400, "invalid_input", "use_model must be boolean");
  const selection = body.selection ?? "sources_first";
  if (!["sources_first", "balanced", "records_first"].includes(String(selection)))
    throw new MemoryError(
      400,
      "invalid_input",
      "selection must be sources_first, balanced or records_first",
    );
  if (body.observe !== undefined && typeof body.observe !== "boolean")
    throw new MemoryError(400, "invalid_input", "observe must be boolean");
  const requirements = (body.requirements ?? []) as NonNullable<
    MemoryRetrievalInput["requirements"]
  >;
  if (!Array.isArray(requirements) || requirements.length > 8)
    throw new MemoryError(400, "invalid_input", "Use at most eight structural requirements");
  for (const requirement of requirements) {
    const r = object(requirement);
    if (r.kind === "claim") {
      textValue(r.subject, "subject", 256);
      textValue(r.predicate, "predicate", 256);
      if (typeof r.subject !== "string" || typeof r.predicate !== "string")
        throw new MemoryError(
          400,
          "invalid_input",
          "A claim requirement needs subject and predicate",
        );
    } else if (r.kind === "source" && typeof r.id === "string") {
      textValue(r.id, "id", 128);
      integer(r.start ?? 0, "start", 0, Number.MAX_SAFE_INTEGER);
      if (r.end !== undefined) integer(r.end, "end", Number(r.start ?? 0), Number.MAX_SAFE_INTEGER);
    } else throw new MemoryError(400, "invalid_input", "Invalid structural requirement");
  }
  const budget = {
    max_results: integer(body.max_results ?? 6, "max_results", 1, 20),
    max_bytes: integer(body.max_bytes ?? 8192, "max_bytes", 256, 65536),
    source_bytes: integer(body.source_bytes ?? 2048, "source_bytes", 64, 8192),
  };
  const validAt = integer(body.valid_at ?? Date.now(), "valid_at", 0, Number.MAX_SAFE_INTEGER);
  return { selection, budget, validAt, requirements };
}

/** Clip only original-source text. Preserve exact UTF-8 boundaries and its full
 * text hash so a caller can verify or continue the witnessed read. */
function fitRange(range: MemorySourceRange, space: string, maxBytes: number) {
  const bytes = Buffer.from(range.text);
  const item = (length: number): Extract<MemoryRetrievedEvidence, { kind: "source" }> => {
    while (length > 0 && length < bytes.length && (bytes[length]! & 0xc0) === 0x80) length--;
    const end = range.start + length;
    return {
      ...range,
      kind: "source",
      space_id: space,
      end,
      text: bytes.subarray(0, length).toString("utf8"),
      next_start: end < range.total_bytes ? end : null,
    };
  };
  let low = 0,
    high = bytes.length;
  if (size(item(0)) > maxBytes) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(item(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const result = item(low);
  return result.text.length ? result : undefined;
}
