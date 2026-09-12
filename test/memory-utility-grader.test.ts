// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
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
