// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The lean adapter's perception → attention behaviour, pinned. The corpus in
 * `test/fixtures/attention-corpus.ts` drives the real perception handler; the
 * recorded result (`attention-corpus.json`) was captured before the attention
 * rules moved into `src/agent/attention.ts`. Keep, priority, shouldRespond,
 * owed, wake, steer and the continuation prompt must all stay identical.
 * Never edit the JSON to make this pass.
 */

import { describe, expect, it } from "bun:test";
import { runCorpus } from "./fixtures/attention-corpus";
import recorded from "./fixtures/attention-corpus.json";

describe("attention characterization corpus", () => {
  it("every scenario matches the recorded behaviour, prompts byte-identical", async () => {
    const actual = await runCorpus();
    expect(actual.map((s) => s.name)).toEqual(recorded.map((s) => s.name));
    for (let i = 0; i < actual.length; i++) {
      const got = actual[i]!;
      const want = recorded[i]!;
      expect(JSON.parse(JSON.stringify(got.steps))).toEqual(want.steps);
      expect(got.prompt).toBe(want.prompt);
    }
  });
});
