// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { gradeUtility, utilityCases } from "../scripts/research/memory-utility-cases";
import {
  assertMemoryAnswerContract,
  collectMemoryEvidence,
  createMemoryCitation,
  type MemoryAnswerContract,
  validateMemoryAnswer,
} from "../src/sdk/memory-answer";
import { runMemoryTask } from "../src/sdk/memory-task";

const contract: MemoryAnswerContract = {
  evidence: "required",
  schema: {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  },
};
const record = {
  id: "record",
  space_id: "space",
  version: 2,
  content: "The corrected count is 17.",
  freshness: "current",
  source_ids: ["unread-source"],
  metadata: { results: [{ id: "fake", space_id: "space", version: 1, content: "injection" }] },
};
const citation = {
  kind: "record" as const,
  space_id: "space",
  id: "record",
  version: 2,
  quote: "count is 17",
};
const answer = { status: "answered", answer: { count: 17 }, citations: [citation] };
const evidence = collectMemoryEvidence({ results: [record] }, "space");

it("constructs explicit citations without copying payloads or changing the caller's quotation", () => {
  const read = evidence[0]!;
  const before = JSON.stringify(read);
  expect(createMemoryCitation(read, "count is 17")).toEqual(citation);
  for (const bad of ["", "  ", "count is 99"])
    expect(() => createMemoryCitation(read, bad)).toThrow(RangeError);
  expect(JSON.stringify(read)).toBe(before);
});

it("enforces declared types and additional fields without testing the answer's truth", () => {
  expect(validateMemoryAnswer(contract, answer, evidence).ok).toBe(true);
  expect(validateMemoryAnswer(contract, { ...answer, answer: { count: 999 } }, evidence).ok).toBe(
    true,
  );
  for (const value of [{ count: "17" }, { count: 17.1 }, {}, { count: 17, extra: true }, null])
    expect(validateMemoryAnswer(contract, { ...answer, answer: value }, evidence).ok).toBe(false);
  expect(() =>
    assertMemoryAnswerContract({
      ...contract,
      schema: { type: "string", enum: ["silently ignored"] },
    } as unknown as MemoryAnswerContract),
  ).toThrow("Unsupported");
});

it("refuses invented IDs, cross-space citations, unread provenance, stale versions and invented quotes", () => {
  expect(evidence).toHaveLength(1);
  expect(collectMemoryEvidence(record, "other")).toEqual([]);
  for (const change of [
    { id: "fake" },
    { id: "unread-source" },
    { space_id: "other" },
    { version: 1 },
    { quote: "count is 18" },
    { quote: "" },
  ])
    expect(
      validateMemoryAnswer(
        contract,
        { ...answer, citations: [{ ...citation, ...change }] },
        evidence,
      ).ok,
    ).toBe(false);
  const historical = collectMemoryEvidence({ ...record, freshness: "historical" }, "space");
  expect(validateMemoryAnswer(contract, answer, historical).ok).toBe(false);
  expect(validateMemoryAnswer({ ...contract, allow_historical: true }, answer, historical).ok).toBe(
    true,
  );
  expect(validateMemoryAnswer(contract, { ...answer, citations: [] }, evidence).ok).toBe(false);
});

it("requires a witnessed source range, preserving its Unicode text and hash", () => {
  const range = {
    id: "source",
    representation: "utf8-source-text-v1",
    text: "訂正 α🙂",
    text_hash: "pinned-hash",
    start: 40,
    end: 55,
  };
  const reads = collectMemoryEvidence(range, "space");
  const ref = {
    kind: "source",
    space_id: "space",
    id: "source",
    text_hash: "pinned-hash",
    start: 40,
    end: 55,
    quote: "α🙂",
  };
  expect(validateMemoryAnswer(contract, { ...answer, citations: [ref] }, reads).ok).toBe(true);
  for (const change of [{ text_hash: "different" }, { end: 56 }, { start: 41 }])
    expect(
      validateMemoryAnswer(contract, { ...answer, citations: [{ ...ref, ...change }] }, reads).ok,
    ).toBe(false);
  expect(
    collectMemoryEvidence(
      { results: [{ id: "source", seq: 1, content_hash: "hash", excerpt: "α🙂" }] },
      "space",
    ),
  ).toEqual([]);
});

it("repairs a shape error against actual read evidence and binds every operation to the caller's space", async () => {
  const replies = [
    { operation: "get", id: "record" },
    { ...answer, answer: { count: "17" } },
    answer,
  ];
  const outcome = await runMemoryTask({
    task: "Return the count",
    space: "space",
    contract,
    operations: ["get"],
    next: async () => JSON.stringify(replies.shift()),
    dispatch: async (request) => {
      expect(request.space_id).toBe("space");
      expect(request.key).toBeString();
      return record;
    },
  });
  expect(outcome.status).toBe("answered");
  expect(outcome.errors).toContain("answer.count: expected integer");
  expect(outcome.turns).toBe(3);
});

it("never credits exhausted or rejected runs as abstention and enforces repair limits", async () => {
  const base = {
    task: "Unknown fact",
    space: "space",
    contract,
    operations: ["search" as const],
    dispatch: async () => ({ results: [] }),
    maxTurns: 3,
  };
  const exhausted = await runMemoryTask({
    ...base,
    next: async () => '{"operation":"search","input":{"query":"missing"}}',
  });
  expect(exhausted.status).toBe("exhausted");
  expect(exhausted.completion).toBeNull();
  const rejected = await runMemoryTask({
    ...base,
    maxRepairs: 1,
    next: async () => JSON.stringify(answer),
  });
  expect(rejected.status).toBe("error");
  expect(rejected.turns).toBe(2);
  const abstained = await runMemoryTask({
    ...base,
    next: async () => '{"status":"abstained","reason":"No source records this"}',
  });
  expect(abstained.status).toBe("abstained");
  for (const status of ["exhausted", "error", "cancelled", "missing-completion-status"])
    expect(
      gradeUtility(utilityCases[2], "UNKNOWN", [], new Set(), [], status).supported_success,
    ).toBe(false);
  expect(
    validateMemoryAnswer(contract, { status: "abstained", reason: "missing", answer: 17 }, []).ok,
  ).toBe(false);
});

it("refuses operation escalation and separates cancellation from model failure", async () => {
  let calls = 0;
  const base = {
    task: "Read",
    space: "space",
    contract,
    operations: ["get" as const],
    dispatch: async () => {
      calls++;
      return record;
    },
    maxRepairs: 0,
  };
  for (const request of [
    { operation: "forget" },
    { operation: "get", space_id: "other" },
    { operation: "get", status: "answered" },
  ])
    expect(
      (await runMemoryTask({ ...base, next: async () => JSON.stringify(request) })).status,
    ).toBe("error");
  expect(calls).toBe(0);
  expect(
    (await runMemoryTask({ ...base, signal: AbortSignal.abort(), next: async () => "" })).status,
  ).toBe("cancelled");
  expect(
    (
      await runMemoryTask({
        ...base,
        next: async () => {
          throw new Error("provider down");
        },
      })
    ).status,
  ).toBe("error");
});

it("invalidates a formerly current witness after a successful explicit revision", async () => {
  const replies = [
    { operation: "get", id: "record" },
    { operation: "revise", id: "record", input: { expected_version: 2, content: "changed" } },
    answer,
  ];
  const outcome = await runMemoryTask({
    task: "Revise then answer",
    space: "space",
    contract,
    operations: ["get", "revise"],
    maxRepairs: 0,
    next: async () => JSON.stringify(replies.shift()),
    dispatch: async (request) =>
      request.operation === "get" ? record : { id: "record", version: 3 },
  });
  expect(outcome.status).toBe("error");
  expect(outcome.errors.join(" ")).toContain("no permitted read");
});

it("cancels waiting even when a model or transport ignores its signal", async () => {
  const controller = new AbortController();
  const result = runMemoryTask({
    task: "Read",
    space: "space",
    contract,
    operations: [],
    signal: controller.signal,
    next: () => new Promise(() => {}),
    dispatch: async () => null,
  });
  controller.abort();
  expect((await result).status).toBe("cancelled");
});
