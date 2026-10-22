// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { hasRuntimeCode, parseLcov, withUnloadedSources } from "../scripts/check-coverage";

describe("check-coverage lcov parsing", () => {
  it("counts DA lines per file and ignores LF/LH", () => {
    const lcov = [
      "TN:",
      "SF:src/a.ts",
      "FNF:1",
      "DA:1,3",
      "DA:2,0",
      "DA:3,1",
      "LF:99",
      "LH:99",
      "end_of_record",
      "SF:src/b.ts",
      "DA:1,0",
      "end_of_record",
      "",
    ].join("\n");
    expect(parseLcov(lcov)).toEqual([
      { file: "src/a.ts", linesFound: 3, linesHit: 2 },
      { file: "src/b.ts", linesFound: 1, linesHit: 0 },
    ]);
  });

  it("drops a record that has no end_of_record and tolerates CRLF", () => {
    expect(parseLcov("SF:src/a.ts\r\nDA:1,1\r\nend_of_record\r\nSF:src/b.ts\nDA:1,1\n")).toEqual([
      { file: "src/a.ts", linesFound: 1, linesHit: 1 },
    ]);
  });
});

describe("check-coverage unloaded sources", () => {
  const texts: Record<string, string> = {
    "src/loaded.ts": "export const a = 1;\n",
    "src/never.ts": "// header\n\nexport function f() {\n  return 1;\n}\n/** doc */\n",
    "src/types-only.ts": "export interface T {\n  a: string;\n}\n",
    "src/decl.d.ts": "declare const x: number;\n",
  };

  it("counts a never-loaded module at 0% and skips loaded, types-only and .d.ts files", () => {
    const loaded = [{ file: "src/loaded.ts", linesFound: 1, linesHit: 1 }];
    const out = withUnloadedSources(loaded, Object.keys(texts), (p) => texts[p]!);
    expect(out).toEqual([
      { file: "src/loaded.ts", linesFound: 1, linesHit: 1 },
      { file: "src/never.ts", linesFound: 3, linesHit: 0 },
    ]);
  });

  it("recognises runtime code", () => {
    expect(hasRuntimeCode("export async function x() {}")).toBe(true);
    expect(hasRuntimeCode("  const y = 2;")).toBe(true);
    expect(hasRuntimeCode("export type A = string;\nexport interface B {}")).toBe(false);
  });
});
