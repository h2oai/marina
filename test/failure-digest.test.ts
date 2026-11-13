// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOutput, formatFailureDigest } from "../src/coding/failure-digest";
import { runWorkspaceCommand } from "../src/coding/local-workspace";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marina-digest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const passing = (from: number) =>
  Array.from({ length: 300 }, (_, i) => `(pass) suite > case ${from + i} [0.01ms]`).join("\n");

it("names a failing test buried in 600 lines of output, from the whole output", async () => {
  // A bun-style run: 300 passes, one failure with its location and assertion, 300 passes.
  const output = [
    "bun test v1.4.4",
    passing(0),
    "src/paging.test.ts:",
    "1 | test('keeps the last page', () => {",
    "error: expect(received).toEqual(expected)",
    "Expected: [3]",
    "Received: []",
    "      at <anonymous> (/tmp/snap/src/paging.test.ts:14:29)",
    "(fail) paging > keeps the last page [0.20ms]",
    passing(300),
    " 600 pass",
    " 1 fail",
  ].join("\n");
  writeFileSync(join(dir, "out.txt"), output);
  // The stored excerpt is bounded to its head; the digest still sees everything.
  const result = await runWorkspaceCommand(
    ["sh", "-c", "cat out.txt >&2; exit 1"],
    dir,
    10_000,
    2048,
  );
  expect(result.truncated).toBe(true);
  expect(result.output).not.toContain("keeps the last page");
  expect(result.digest?.failures).toEqual([
    { name: "paging > keeps the last page", location: "/tmp/snap/src/paging.test.ts:14" },
  ]);
  expect(result.digest?.firstError).toBe(
    "error: expect(received).toEqual(expected)\nExpected: [3]\nReceived: []",
  );
  expect(result.digest?.tail.split("\n").length).toBeLessThanOrEqual(40);
  expect(result.digest?.tail).toContain(" 1 fail");
  const text = formatFailureDigest(result.digest!, {
    identities: [{ file: "src/other.test.ts", name: "something else", signature: "" }],
    commit: "a".repeat(40),
  });
  expect(text).toContain("- paging > keeps the last page (/tmp/snap/src/paging.test.ts:14) — NEW");
});

it("reads pytest and go failure lines, and bounds the tail to 4 KB", () => {
  const digest = digestOutput(
    [
      "FAILED tests/test_api.py::test_login - AssertionError: 401 != 200",
      "--- FAIL: TestParse (0.00s)",
      "x".repeat(300),
      ...Array.from({ length: 60 }, () => "y".repeat(200)),
    ].join("\n"),
  );
  expect(digest.failures.map((f) => f.name)).toEqual([
    "tests/test_api.py::test_login - AssertionError: 401 != 200",
    "TestParse",
  ]);
  expect(digest.failures[0]!.location).toBeUndefined();
  expect(Buffer.byteLength(digest.tail)).toBeLessThanOrEqual(4096);
});

it("attaches no digest to a passing run", async () => {
  const result = await runWorkspaceCommand(["sh", "-c", "echo ok"], dir, 10_000, 1024);
  expect(result.digest).toBeUndefined();
});

it("lists a failure once when the runner repeats it in its closing summary", () => {
  const digest = digestOutput(
    "at x (/s/a.test.ts:7:1)\n(fail) a > b [1ms]\n\n1 tests failed:\n(fail) a > b [1ms]\n",
  );
  expect(digest.failures).toEqual([{ name: "a > b", location: "/s/a.test.ts:7" }]);
});
