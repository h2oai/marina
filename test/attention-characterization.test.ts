// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The lean adapter's perception → attention behaviour, pinned. The corpus in
 * `test/fixtures/attention-corpus.ts` drives the real perception handler; the
 * recorded result (`attention-corpus.json`) was captured before the attention
 * rules moved into `src/agent/attention.ts`. Keep, priority, shouldRespond,
 * owed, wake and steer must stay identical. The sole approved prompt change
 * below makes the endpoint response envelope explicit after live residents
 * returned answer fields outside content. Preserve the historical JSON.
 */

import { describe, expect, it } from "bun:test";
import { runCorpus } from "./fixtures/attention-corpus";
import recorded from "./fixtures/attention-corpus.json";

describe("attention characterization corpus", () => {
  it("preserves recorded attention behavior with the explicit endpoint envelope correction", async () => {
    const prior =
      "with the exact request `id`, or delegate with `marina_tell` and then send that response.";
    const corrected =
      "with the exact request `id` and a string `content` containing your answer. If the requested answer is JSON, encode that entire JSON object as the `content` string; do not put answer fields at the envelope top level. You may also delegate with `marina_tell` and then send that response.";
    const actual = await runCorpus();
    expect(actual.map((s) => s.name)).toEqual(recorded.map((s) => s.name));
    for (let i = 0; i < actual.length; i++) {
      const got = actual[i]!;
      const want = recorded[i]!;
      expect(JSON.parse(JSON.stringify(got.steps))).toEqual(want.steps);
      expect(got.prompt).toBe(want.prompt.replace(prior, corrected));
    }
  });
});
