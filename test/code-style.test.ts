// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { colorizeDiff } from "../scripts/code-diff";
import {
  labelStyle,
  styleCodeEntry,
  stylePrompt,
  styleStartupLine,
  themeFor,
} from "../scripts/code-style";
import type { TermCaps } from "../scripts/term-caps";
import { plainText } from "../scripts/term-sanitize";
import { createTheme } from "../scripts/term-theme";

const caps = (over: Partial<TermCaps> = {}): TermCaps => ({
  color: 3,
  unicode: true,
  links: false,
  background: "dark",
  columns: 80,
  ...over,
});
const theme = createTheme(caps());
const plain = createTheme(caps({ color: 0 }));

describe("Code Mode entry styling", () => {
  test("a labelled entry becomes glyph + label, its body indented under it", () => {
    const out = styleCodeEntry("[error] Not connected.\nTry /status", theme);
    expect(plainText(out)).toBe("✗ error  Not connected.\n  Try /status");
    expect(out).toContain(theme.params("error"));
  });

  test("each label family has a glyph as well as a colour", () => {
    expect(labelStyle("approval requested", theme)).toEqual({ glyph: "⚑", tone: "warning" });
    expect(labelStyle("checks · result · ready for review", theme).tone).toBe("success");
    expect(labelStyle("checks · need attention", theme).tone).toBe("warning");
    expect(labelStyle("worker · paused · spend cap", theme).tone).toBe("warning");
    expect(labelStyle("diff · working changes", theme).glyph).toBe("±");
    expect(labelStyle("task · blocked", theme).glyph).toBe("▲");
  });

  test("text is unchanged with colour off (pipes, NO_COLOR)", () => {
    const text = "[project · inspection only] Workspace: /tmp\n  /world code start <title>";
    expect(styleCodeEntry(text, plain)).toBe(text);
  });

  test("help rows, keys and runnable suggestions are styled; the words never change", () => {
    const text =
      "  /diff          see what changed\nWorkspace: /tmp/x\n  /world code run git diff --check";
    const out = styleCodeEntry(text, theme);
    expect(plainText(out)).toBe(text);
    expect(out).toContain(`${theme.params("code")}m/diff`);
    expect(out).toContain(`${theme.params("muted")}mWorkspace:`);
    expect(out).toContain(`${theme.params("code")}m/world code run git diff --check`);
    // A path is not a command.
    expect(out).not.toContain(`${theme.params("code")}m/tmp`);
  });

  test("lines soft-wrap by default; wrap hangs them under the gutter", () => {
    const long = `[review] ${"word ".repeat(40)}`;
    // Too long to ride next to the label: it sits under it, unbroken.
    const soft = styleCodeEntry(long, theme).split("\n");
    expect(soft).toHaveLength(2);
    expect(plainText(soft[1]!)).toBe(`  ${"word ".repeat(40)}`);
    const wrapped = styleCodeEntry(long, theme, { wrap: true }).split("\n");
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped.slice(1)) expect(plainText(line).startsWith("  ")).toBe(true);
  });
});

describe("Code Mode prompt and startup", () => {
  test("the prompt keeps its words and chevron; colour only on a terminal", () => {
    const parts = { destination: "proj · ready", folder: "proj", status: "ready" };
    expect(stylePrompt(parts, plain)).toBe("proj · ready › ");
    const styled = stylePrompt({ ...parts, badge: "World 1" }, theme);
    expect(plainText(styled)).toBe("proj · ready · World 1 › ");
    expect(styled).toContain(theme.params("warning"));
  });

  test("the startup summary keeps its shape (the first-screen journey reads it)", () => {
    const line = "Marina 0.9.0 · project · default model";
    expect(plainText(styleStartupLine(line, theme))).toBe(line);
    expect(styleStartupLine(line, plain)).toBe(line);
  });

  test("diffs take the palette when given a theme, the 16 colours otherwise", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-removed\n+added";
    expect(colorizeDiff(diff, true)).toContain("\x1b[32m+added");
    expect(colorizeDiff(diff, true, theme)).toContain(`\x1b[${theme.params("success")}m+added`);
    expect(colorizeDiff(diff, false, theme)).toBe(diff);
  });

  test("a stream that is not a terminal gets no colour", () => {
    expect(themeFor({ isTTY: false }).level).toBe(0);
    expect(themeFor(undefined).level).toBe(0);
  });
});
