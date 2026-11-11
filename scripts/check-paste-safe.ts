// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run check:paste-safe` — report shell examples in the docs that break when a reader copies
 * the whole block and pastes it into a shell. Advisory: it prints findings and exits 0
 * (`--strict` exits 1 on any). Only the front-door pages are held by a test
 * (`test/docs-paste-safe.test.ts`); the other guides are reported here, never gated, so a pull
 * request that adds a commented example to a guide is not blocked by it.
 *
 * Two things break a pasted block:
 *   - a `# comment`: zsh (the macOS default) leaves `interactivecomments` off, so a trailing
 *     comment's words become arguments to the command before it, and a comment line errors;
 *   - a command that reads the terminal or keeps running (`marina init`, `marina`, `marina start`,
 *     `bun run start`, an interactive `connect.ts`) with more lines after it: it takes the rest of
 *     the paste as its input.
 * Fix: move comments into the prose, end a block on such a command, split alternatives into
 * their own blocks, and tag a block that is not commands to paste by what it is (`dotenv` for
 * settings, `plaintext` for printed output).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ShellBlock {
  start: number;
  lines: string[];
}

const SHELL_FENCE = /^\s*```(bash|sh|shell|zsh)\s*$/;

/** A command that reads the terminal or keeps running, so nothing may follow it in a paste. */
const HOLDS_THE_TERMINAL = [
  /\bmarina init\b/,
  /(^|&&\s*)marina\s*$/,
  /\bmarina start\b/,
  /\bbun run start\b/,
  /\bconnect\.ts \S+\s*$/,
];

export function shellBlocks(text: string): ShellBlock[] {
  const blocks: ShellBlock[] = [];
  let current: ShellBlock | null = null;
  text.split("\n").forEach((line, i) => {
    if (!current && SHELL_FENCE.test(line)) current = { start: i + 2, lines: [] };
    else if (current && line.trim().startsWith("```")) {
      blocks.push(current);
      current = null;
    } else current?.lines.push(line);
  });
  return blocks;
}

export function pasteProblems(name: string, blocks: ShellBlock[]): string[] {
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

export function pageProblems(root: string, page: string): string[] {
  return pasteProblems(page, shellBlocks(readFileSync(join(root, page), "utf8")));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const pages = [
    "README.md",
    ...readdirSync(join(root, "docs/guides"))
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => `docs/guides/${file}`),
  ];
  const found = pages.flatMap((page) => pageProblems(root, page));
  for (const line of found) process.stdout.write(`${line}\n`);
  process.stdout.write(
    found.length === 0
      ? "Every shell example pastes as a whole block.\n"
      : `${found.length} shell example line(s) break a whole-block paste (advisory).\n`,
  );
  if (process.argv.includes("--strict") && found.length > 0) process.exit(1);
}
