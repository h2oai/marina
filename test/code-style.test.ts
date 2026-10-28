// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { colorizeDiff } from "../scripts/code-diff";
import {
  labelStyle,
  styleCodeEntry,
  styleLocation,
  styleStartupLine,
  themeFor,
} from "../scripts/code-style";
import { CodeTerminal } from "../scripts/code-terminal";
import type { TermCaps } from "../scripts/term-caps";
import { plainText } from "../scripts/term-sanitize";
import { createTheme } from "../scripts/term-theme";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";
import { VtScreen } from "./vt-screen";

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
  test("the input area's label keeps its words; colour only on a terminal", () => {
    const parts = { destination: "proj · ready", folder: "proj", status: "ready" };
    expect(styleLocation(parts, plain)).toBe("proj · ready");
    const styled = styleLocation({ ...parts, badge: "World 1" }, theme);
    expect(plainText(styled)).toBe("proj · ready · World 1");
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

describe("Code Mode input area", () => {
  // `❯`, or `>` where the locale has no Unicode.
  const PROMPT_LINE = /^[❯>]\s*$/;

  async function render(
    env: Record<string, string | undefined>,
    ready: (page: string[]) => boolean,
    keys?: { text: string[]; until: (page: string[]) => boolean },
  ) {
    using _env = scopeProcessState({
      env: { TERM: "xterm-256color", COLORTERM: undefined, FORCE_COLOR: undefined, ...env },
    });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
    const screen = new VtScreen(100, 24);
    output.on("data", (data) => screen.write(data.toString()));
    const terminal = new CodeTerminal({
      input,
      output,
      views: true,
      location: "Local workspace · /work/proj",
      statusLine: () => "● live · ✦ 2 agents",
      line: () => {},
      interrupt: () => {},
      close: () => {},
    });
    try {
      terminal.write("hello", "coding");
      await until(() => screen.text().includes("hello"));
      terminal.refreshStatus();
      await until(() => ready(screen.screen()));
      if (keys) {
        // One key per chunk: readline takes a multi-key chunk as a paste and keeps its tabs.
        for (const key of keys.text) {
          input.write(key);
          await new Promise((resolve) => setImmediate(resolve));
        }
        await until(() => keys.until(screen.screen()));
      }
      return screen.screen();
    } finally {
      terminal.close();
      input.destroy();
      output.destroy();
    }
  }

  test("a rule naming the folder, the prompt, a rule, and the live status in the footer", async () => {
    const page = await render({ NO_COLOR: undefined }, (p) =>
      p.some((l) => l.includes("2 agents")),
    );
    const prompt = page.findIndex((l) => PROMPT_LINE.test(l));
    expect(prompt).toBeGreaterThan(0);
    expect(page[prompt - 1]).toMatch(/proj · ready/);
    expect(page[prompt + 1]).toMatch(/^[─-]+$/);
    expect(page[prompt + 2]).toContain("● live · ✦ 2 agents");
    // Output scrolls above the area, never into it.
    expect(page.slice(0, prompt - 1).join("\n")).toContain("hello");
  });

  test("the live status never appears with colour off; the footer keeps its hint", async () => {
    const page = await render({ NO_COLOR: "1" }, (p) => p.some((l) => l.includes("/help")));
    expect(page.join("\n")).not.toContain("2 agents");
    expect(page.some((l) => PROMPT_LINE.test(l))).toBe(true);
  });

  test("Tab completes in place; several matches show in the footer, not over the area", async () => {
    const page = await render(
      { NO_COLOR: undefined },
      (p) => p.some((l) => l.includes("2 agents")),
      { text: ["/st", "\t", "\t"], until: (p) => p.some((l) => l.includes("/status  /stop")) },
    );
    const prompt = page.findIndex((l) => /^[❯>] \/st$/.test(l));
    expect(prompt).toBeGreaterThan(0);
    expect(page[prompt + 1]).toMatch(/^[─-]+$/);
    expect(page[prompt + 2]).toMatch(/^ {2}\/status {2}\/stop$/);
    // Readline's own listing would have printed below the prompt and torn the area.
    expect(page.filter((l) => l.includes("/status"))).toHaveLength(1);
    const unique = await render(
      { NO_COLOR: undefined },
      (p) => p.some((l) => l.includes("2 agents")),
      { text: ["/sta", "\t"], until: (p) => p.some((l) => /^[❯>] \/status$/.test(l)) },
    );
    expect(unique.some((l) => l.includes("2 agents"))).toBe(true);
  });
});
