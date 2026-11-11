// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The install snippets on the front-door pages are what a new reader copies and pastes into a
// shell as a whole block, so they are held paste-safe here: no `# comments` (zsh passes a
// trailing one as arguments) and nothing after a command that reads the terminal or keeps
// running (`marina init` takes the rest of the paste as its answers). The rules and the fix are
// in `scripts/check-paste-safe.ts`. Every other guide is checked by `bun run check:paste-safe`,
// which is advisory and never fails CI.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageProblems, pasteProblems } from "../scripts/check-paste-safe";

const ROOT = join(import.meta.dir, "..");

const FRONT_DOOR_PAGES = [
  "README.md",
  "docs/guides/getting-started.md",
  "site/src/content/docs/docs/overview.mdx",
];

describe("front-door shell snippets paste safely", () => {
  for (const page of FRONT_DOOR_PAGES) {
    it(page, () => {
      expect(pageProblems(ROOT, page)).toEqual([]);
    });
  }

  it("site home page install box", () => {
    const page = "site/src/pages/index.astro";
    const text = readFileSync(join(ROOT, page), "utf8");
    const install = /<pre id="install-cmd">([\s\S]*?)<\/pre>/.exec(text)?.[1];
    expect(install).toBeDefined();
    expect(pasteProblems(page, [{ start: 0, lines: (install ?? "").split("\n") }])).toEqual([]);
    for (const code of text.matchAll(/^\s*code: "(.*)",$/gm)) {
      const lines = (code[1] ?? "").split("\\n");
      if (lines[0]?.startsWith("/")) continue; // typed into Claude Code, not a shell
      expect(pasteProblems(page, [{ start: 0, lines }])).toEqual([]);
    }
  });

  it("the checker finds both kinds of break", () => {
    const found = pasteProblems("x", [
      { start: 1, lines: ["bun run setup:cli   # links marina", "marina init", "marina start"] },
    ]);
    expect(found).toEqual([
      "x:1 comment: bun run setup:cli   # links marina",
      "x:2 takes the rest of the paste as input: marina init",
    ]);
  });
});
