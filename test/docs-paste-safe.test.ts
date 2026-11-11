// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Shell snippets in the docs are copied and pasted into a shell as a whole block. Two
// things break that paste:
//   - a trailing `# comment`: zsh (the macOS default) leaves `interactivecomments` off, so the
//     comment's words become arguments to the command before it;
//   - a command that reads the terminal or never returns (`marina init`, `marina`,
//     `bun run start`, an interactive `connect.ts`) followed by more lines: it takes the rest
//     of the paste as its input.
// So every shell block has no comments, and such a command only ends a block. A block that is
// not commands to paste (a file's contents, printed output) takes that language instead:
// `ini`/`dotenv` for settings, `text` for output.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const MARKDOWN_PAGES = [
  "README.md",
  "site/src/content/docs/docs/overview.mdx",
  ...readdirSync(join(ROOT, "docs/guides"))
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => `docs/guides/${file}`),
];

const SHELL_FENCE = /^\s*```(bash|sh|shell|zsh)\s*$/;

/** A command that reads the terminal or keeps running, so nothing may follow it in a paste. */
const HOLDS_THE_TERMINAL = [
  /\bmarina init\b/,
  /(^|&&\s*)marina\s*$/,
  /\bmarina start\b/,
  /\bbun run start\b/,
  /\bconnect\.ts \S+\s*$/,
];

function shellBlocks(text: string): { start: number; lines: string[] }[] {
  const blocks: { start: number; lines: string[] }[] = [];
  let current: { start: number; lines: string[] } | null = null;
  text.split("\n").forEach((line, i) => {
    if (!current && SHELL_FENCE.test(line)) current = { start: i + 2, lines: [] };
    else if (current && line.trim().startsWith("```")) {
      blocks.push(current);
      current = null;
    } else current?.lines.push(line);
  });
  return blocks;
}

function problems(name: string, blocks: { start: number; lines: string[] }[]): string[] {
  const found: string[] = [];
  for (const block of blocks) {
    const commands = block.lines
      .map((line, i) => ({ line, at: block.start + i }))
      .filter(({ line }) => line.trim() !== "");
    commands.forEach(({ line, at }, i) => {
      if (/^\s*#/.test(line) || /\s#\s/.test(line)) found.push(`${name}:${at} comment: ${line}`);
      const continued = /\\\s*$/.test(line);
      if (!continued && i < commands.length - 1 && HOLDS_THE_TERMINAL.some((re) => re.test(line))) {
        found.push(`${name}:${at} takes the rest of the paste as input: ${line}`);
      }
    });
  }
  return found;
}

describe("shell snippets paste safely", () => {
  for (const page of MARKDOWN_PAGES) {
    it(page, () => {
      const text = readFileSync(join(ROOT, page), "utf8");
      expect(problems(page, shellBlocks(text))).toEqual([]);
    });
  }

  it("site home page install box", () => {
    const page = "site/src/pages/index.astro";
    const text = readFileSync(join(ROOT, page), "utf8");
    const install = /<pre id="install-cmd">([\s\S]*?)<\/pre>/.exec(text)?.[1];
    expect(install).toBeDefined();
    expect(problems(page, [{ start: 0, lines: (install ?? "").split("\n") }])).toEqual([]);
    for (const code of text.matchAll(/^\s*code: "(.*)",$/gm)) {
      const lines = (code[1] ?? "").split("\\n");
      if (lines[0]?.startsWith("/")) continue; // typed into Claude Code, not a shell
      expect(problems(page, [{ start: 0, lines }])).toEqual([]);
    }
  });
});
