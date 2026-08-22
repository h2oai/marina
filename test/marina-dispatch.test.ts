// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { pushTailLines } from "../scripts/code";
import { parseDispatch, USAGE } from "../scripts/marina";

describe("marina dispatcher routing", () => {
  it("routes bare invocation to the coding flow with no dir", () => {
    expect(parseDispatch([])).toEqual({ kind: "code", dir: undefined });
  });

  it("routes a path argument to the coding flow", () => {
    expect(parseDispatch(["/some/project"])).toEqual({ kind: "code", dir: "/some/project" });
    expect(parseDispatch(["."])).toEqual({ kind: "code", dir: "." });
  });

  it("routes connect with its remaining arguments", () => {
    expect(parseDispatch(["connect", "Ada", "-c", "look"])).toEqual({
      kind: "connect",
      rest: ["Ada", "-c", "look"],
    });
  });

  it("routes start to the full server", () => {
    expect(parseDispatch(["start"])).toEqual({ kind: "start" });
  });

  it("recognizes help in all spellings", () => {
    expect(parseDispatch(["--help"])).toEqual({ kind: "help" });
    expect(parseDispatch(["-h"])).toEqual({ kind: "help" });
    expect(parseDispatch(["help"])).toEqual({ kind: "help" });
  });

  it("flags unknown options instead of treating them as directories", () => {
    expect(parseDispatch(["--bogus"])).toEqual({ kind: "usage-error", arg: "--bogus" });
  });

  it("usage covers every flow", () => {
    for (const word of ["connect", "start", "--help", "[dir]"]) {
      expect(USAGE).toContain(word);
    }
  });
});

describe("code launcher stderr tail", () => {
  it("keeps only the last max lines", () => {
    const tail: string[] = [];
    pushTailLines(tail, ["a", "b"], 3);
    pushTailLines(tail, ["c", "d"], 3);
    expect(tail).toEqual(["b", "c", "d"]);
  });

  it("skips blank lines", () => {
    const tail: string[] = [];
    pushTailLines(tail, ["", "  ", "boom: EADDRINUSE"], 5);
    expect(tail).toEqual(["boom: EADDRINUSE"]);
  });
});
