// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import {
  regradeUtilityGrounding,
  returnedEvidenceIds,
} from "../scripts/research/memory-evidence-ids";
import { gradeUtility, utilityCases } from "../scripts/research/memory-utility-cases";

it("requires an exact functional coding result and returned supporting citations", () => {
  const task = utilityCases[0];
  const correct = JSON.stringify({ delays: [75, 150, 300, 600], baseDelayMs: 75, maxRetries: 4 });
  expect(
    gradeUtility(task, correct, ["current"], new Set(["current"]), ["current"]).supported_success,
  ).toBe(true);
  expect(gradeUtility(task, correct, [], new Set(["current"]), ["current"]).supported_success).toBe(
    false,
  );
  expect(
    gradeUtility(task, correct, ["current", "fabricated"], new Set(["current"]), ["current"])
      .grounded,
  ).toBe(false);
  expect(
    gradeUtility(task, correct, ["historical"], new Set(["historical"]), ["current"]).cited,
  ).toBe(false);
  expect(
    gradeUtility(
      task,
      JSON.stringify({ ...task.expected, delays: [75, 150, 300] }),
      ["current"],
      new Set(["current"]),
      ["current"],
    ).functional,
  ).toBe(false);
});

it("accepts returned provenance and source identities without trusting payload IDs", () => {
  const record = {
    id: "record",
    space_id: "space",
    version: 2,
    content: "Current fact",
    source_ids: ["provenance", 123],
    depends_on: ["unread-premise"],
    metadata: { id: "metadata-id", source_ids: ["metadata-source"] },
  };
  const hit = { id: "hit", seq: 1, content_hash: "hash", excerpt: "source excerpt" };
  const source = { id: "source", seq: 2, content_hash: "hash", body: { id: "payload-id" } };
  const range = {
    id: "range",
    content_hash: "hash",
    representation: "utf8-source-text-v1",
    text: '{"id":"text-id"}',
  };
  expect(
    returnedEvidenceIds([
      { trace: [{ input: { id: "requested-id" }, evidence: [record, hit] }] },
      { results: [record, hit] },
      { edges: [{ record, path: ["unread-path"] }] },
      source,
      range,
      { error: "not found", id: "error-id", source_ids: ["error-source"] },
    ]),
  ).toEqual(new Set(["record", "provenance", "hit", "source", "range"]));
});

it("regrades only citation availability while preserving saved responses and other decisions", () => {
  const trace = [
    {
      result: {
        results: [
          { id: "record", space_id: "space", version: 1, content: "fact", source_ids: ["source"] },
        ],
      },
    },
  ];
  const row = {
    answer: "saved answer",
    citations: ["record", "source"],
    trace,
    correct: true,
    cited: true,
    grounded: false,
    functional: null,
    supported_success: false,
  };
  const updated = regradeUtilityGrounding(row);
  expect(updated.supported_success).toBe(true);
  expect(updated.previous_citation_grade.supported_success).toBe(false);
  expect(updated.trace).toBe(trace);
  expect(updated.answer).toBe(row.answer);
  expect(row.supported_success).toBe(false);
  expect(regradeUtilityGrounding({ ...row, citations: ["fabricated"] }).supported_success).toBe(
    false,
  );
  expect(regradeUtilityGrounding({ ...row, correct: false }).supported_success).toBe(false);
  expect(regradeUtilityGrounding({ ...row, cited: false }).supported_success).toBe(false);
  expect(regradeUtilityGrounding({ ...row, functional: false }).supported_success).toBe(false);
});

it("scores abstention independently and refuses answers containing expected substrings", () => {
  const absent = utilityCases[2];
  expect(gradeUtility(absent, "UNKNOWN", [], new Set(), []).supported_success).toBe(true);
  expect(gradeUtility(absent, "UNKNOWN", ["invented"], new Set(), []).supported_success).toBe(
    false,
  );
  const correction = utilityCases[9];
  expect(
    gradeUtility(correction, "Berlin or Kyoto", ["source"], new Set(["source"]), ["source"])
      .correct,
  ).toBe(false);
  expect(
    gradeUtility(correction, '{"city":"Berlin"}', ["source"], new Set(["source"]), ["source"])
      .correct,
  ).toBe(false);
  expect(
    gradeUtility(correction, '{"city":"Kyoto"}', ["source"], new Set(["source"]), ["source"])
      .supported_success,
  ).toBe(true);
});
