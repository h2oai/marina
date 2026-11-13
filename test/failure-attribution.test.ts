// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A failure is labelled pre-existing only on positive evidence: the same file and test, the
// same first error, failing on the base twice. Everything short of that is inconclusive.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeFailure,
  digestOutput,
  FailureDigester,
  MAX_PARTIAL_LINE,
} from "../src/coding/failure-digest";
import { observeWorkspaceState, statDirty } from "../src/coding/workspace-state";
import { confirmationCommand } from "../src/engine/commands/code/verification";
import { git as gitIn } from "./git-helpers";

/** bun-style output: a header per file, then its failures. */
const bun = (files: Record<string, Array<[string, string]>>) =>
  Object.entries(files)
    .map(
      ([file, tests]) =>
        `${file}:\n${tests.map(([name, error]) => `error: ${error}\n      at <anonymous> (/repo/${file}:3:9)\n(fail) ${name} [0.10ms]`).join("\n")}`,
    )
    .join("\n\n");
const failed = (out: string) => ({ passed: false, digest: digestOutput(out, "/repo", 1) });

describe("attribution of a failed gate", () => {
  it("[R1] tells two files' same-named tests apart", () => {
    const change = digestOutput(bun({ "b.test.ts": [["same", "boom"]] }), "/repo", 1);
    const base = failed(bun({ "a.test.ts": [["same", "boom"]] }));
    const again = failed(bun({ "a.test.ts": [["same", "boom"]] }));
    expect(change.identities).toEqual([
      { file: "b.test.ts", name: "same", signature: "error: boom" },
    ]);
    expect(attributeFailure({ change, base, again })).toMatchObject({
      kind: "change",
      newFailures: ["b.test.ts::same"],
    });
  });

  it("[R2] compares every failure, not the 40 shown", () => {
    const forty = Array.from({ length: 40 }, (_, i) => [`t${i}`, "boom"] as [string, string]);
    const base = failed(bun({ "a.test.ts": forty }));
    const change = digestOutput(bun({ "a.test.ts": [...forty, ["t40", "boom"]] }), "/repo", 1);
    expect(change.failures).toHaveLength(40);
    expect(change.moreFailures).toBe(1);
    expect(attributeFailure({ change, base, again: base })).toMatchObject({
      kind: "change",
      newFailures: ["a.test.ts::t40"],
    });
    // Past the identity bound the enumeration is incomplete: inconclusive.
    const many = Array.from({ length: 5001 }, (_, i) => [`m${i}`, "boom"] as [string, string]);
    const huge = digestOutput(bun({ "a.test.ts": many }), "/repo", 1);
    expect(huge.incomplete).toContain("more than 5000");
    expect(attributeFailure({ change: huge, base: failed(bun({ "a.test.ts": many })) }).kind).toBe(
      "inconclusive",
    );
  });

  it("[R3] never matches unnamed failures; a base that could not run is inconclusive", () => {
    const change = digestOutput("SyntaxError: Unexpected token in src.ts\n", "/repo", 1);
    const base = failed("SyntaxError: Unexpected token in a.test.ts\n");
    expect(change.incomplete).toBe("the command failed without naming a failing test");
    expect(attributeFailure({ change, base, again: base }).kind).toBe("inconclusive");
    expect(
      attributeFailure({
        change: digestOutput(bun({ "a.test.ts": [["x", "boom"]] }), "/repo", 1),
        baseUnavailable: "the base could not be prepared: no network",
      }),
    ).toMatchObject({ kind: "inconclusive", reason: expect.stringContaining("no network") });
  });

  it("[R4] needs the same failure twice on the base: a flaky or different base never excuses", () => {
    const change = digestOutput(bun({ "a.test.ts": [["x", "expected 1"]] }), "/repo", 1);
    const same = failed(bun({ "a.test.ts": [["x", "expected 1"]] }));
    expect(attributeFailure({ change, base: same }).kind).toBe("inconclusive");
    expect(attributeFailure({ change, base: same, again: { passed: true } }).kind).toBe(
      "inconclusive",
    );
    const other = failed(bun({ "a.test.ts": [["x", "timeout"]] }));
    expect(attributeFailure({ change, base: same, again: other }).kind).toBe("inconclusive");
    expect(attributeFailure({ change, base: other, again: other }).kind).toBe("inconclusive");
    expect(attributeFailure({ change, base: same, again: same }).kind).toBe("preexisting");
    // The confirmation runs only the failing tests where the runner can, else a cheap rerun.
    expect(confirmationCommand(["bun", "test", "a.test.ts", "b.test.ts"], change, 600_000)).toEqual(
      ["bun", "test", "./a.test.ts"],
    );
    expect(confirmationCommand(["bun", "run", "test"], change, 60_000)).toEqual([
      "bun",
      "run",
      "test",
    ]);
    expect(confirmationCommand(["bun", "run", "test"], change, 600_000)).toBeUndefined();
  });

  it("[R8] bounds a line with no newline and marks the digest incomplete", () => {
    const digester = new FailureDigester("/repo");
    const mib = "x".repeat(1024 * 1024);
    for (let i = 0; i < 8; i++) digester.feed(mib, "1");
    expect(
      (digester as unknown as { carry: Map<string, string> }).carry.get("1")!.length,
    ).toBeLessThanOrEqual(MAX_PARTIAL_LINE);
    digester.feed("\n(fail) after [1ms]\n", "1");
    const digest = digester.digest(1);
    expect(digest.incomplete).toContain("longer than");
    expect(attributeFailure({ change: digest, base: failed("") }).kind).toBe("inconclusive");
  });
});

describe("changes already present", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-statdirty-"));
    gitIn(root, "init", "--quiet", "--template=");
    writeFileSync(join(root, "a.sh"), "echo a\n");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "--quiet", "-m", "base");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("[R9] compares the index's mode and ctime nanoseconds, not just seconds", () => {
    const path = join(root, "a.sh");
    chmodSync(path, 0o755);
    const st = lstatSync(path, { bigint: true });
    const sec = (ns: bigint) => ns / 1_000_000_000n;
    const nsec = (ns: bigint) => ns % 1_000_000_000n;
    const debug = (ctimeNs: bigint) =>
      `a.sh\0  ctime: ${sec(ctimeNs)}:${nsec(ctimeNs)}\n  mtime: ${sec(st.mtimeNs)}:${nsec(st.mtimeNs)}\n  dev: ${st.dev}\tino: ${st.ino}\n  uid: 0\tgid: 0\n  size: ${st.size}\tflags: 0\n`;
    const stage = (mode: string) => `${mode} ${"0".repeat(40)} 0\ta.sh\0`;
    expect(statDirty(root, debug(st.ctimeNs), stage("100755"))).toEqual([]);
    // Recorded as not executable: the mode changed, whatever the times say.
    expect(statDirty(root, debug(st.ctimeNs), stage("100644"))).toEqual(["a.sh"]);
    // The same second, another nanosecond: changed.
    expect(statDirty(root, debug(st.ctimeNs + 1n), stage("100755"))).toEqual(["a.sh"]);
  });

  it("[R9] reports a mode change and a same-second rewrite", async () => {
    chmodSync(join(root, "a.sh"), 0o755);
    expect((await observeWorkspaceState(root)).preexisting?.sample).toEqual(["a.sh"]);
    gitIn(root, "add", "a.sh");
    gitIn(root, "commit", "--quiet", "-m", "exec");
    expect((await observeWorkspaceState(root)).preexisting).toBeUndefined();
    // Same bytes length, rewritten at once: only nanosecond times or ctime can tell.
    writeFileSync(join(root, "a.sh"), "echo b\n");
    expect((await observeWorkspaceState(root)).preexisting?.sample).toEqual(["a.sh"]);
  });
});
