// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { splitDiff } from "../lib/split-diff";

describe("artifact split diff", () => {
  it("pairs unequal replacements and preserves source line numbers across hunks", () => {
    const rows = splitDiff(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +10,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-last\n+end\n\\ No newline at end of file",
    );
    expect(rows[4]).toMatchObject({
      left: { number: 10, text: "same", changed: false },
      right: { number: 10, text: "same" },
    });
    expect(rows[5]).toMatchObject({
      left: { number: 11, text: "old", changed: true },
      right: { number: 11, text: "new", changed: true },
    });
    expect(rows[6]).toMatchObject({ left: undefined, right: { number: 12, text: "extra" } });
    expect(rows[8]).toMatchObject({
      left: { number: 20, text: "last" },
      right: { number: 21, text: "end" },
    });
  });
  it("preserves file metadata and binary diffs", () => {
    expect(splitDiff("Binary files a/image.png and b/image.png differ")).toEqual([
      { header: "Binary files a/image.png and b/image.png differ" },
    ]);
  });
});
