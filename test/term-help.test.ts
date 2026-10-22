// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { formatStatus, USAGE } from "../scripts/marina";
import type { TermCaps } from "../scripts/term-caps";
import { initStyles, styleStatusReport, styleUsage } from "../scripts/term-help";
import { plainText } from "../scripts/term-sanitize";
import { createTheme } from "../scripts/term-theme";

const caps = (over: Partial<TermCaps> = {}): TermCaps => ({
  color: 3,
  unicode: true,
  links: false,
  background: "dark",
  columns: 100,
  ...over,
});
const theme = createTheme(caps());
const plain = createTheme(caps({ color: 0 }));

const report = formatStatus(
  "ws://localhost:3300",
  { status: "ok", uptime: 125_000, connections: 2, rooms: 4, entities: 3, agents: 1 },
  {
    instanceName: "Marina",
    world: "Workbench",
    trustProfile: { profile: "local", autonomy: "guarded" },
    checks: [
      { id: "llm", label: "LLM provider", status: "off", detail: "no key", remediation: "set one" },
      { id: "spend", label: "Daily spend", status: "ok", detail: "$0.00 today" },
      { id: "tab", label: "TabH2O", status: "off", detail: "unset", optional: true },
    ],
  },
);

describe("marina --help and status styling", () => {
  test("help keeps every word; colour off returns it unchanged", () => {
    // In colour, `code` spans are shown in the code colour instead of backticks.
    expect(plainText(styleUsage(USAGE, theme))).toBe(USAGE.replace(/`([^`\n]+)`/g, "$1"));
    expect(styleUsage(USAGE, plain)).toBe(USAGE);
    const styled = styleUsage(USAGE, theme);
    expect(styled).toContain(`${theme.params("code")}mmarina connect <name> [...]`);
    expect(styled).toContain(theme.params("accent"));
  });

  test("status gains a glyph per capability, keeps the words and the column", () => {
    expect(styleStatusReport(report, plain)).toBe(report);
    const lines = plainText(styleStatusReport(report, theme)).split("\n");
    const original = report.split("\n");
    expect(lines.length).toBe(original.length);
    const row = (all: string[], label: string) => all.find((l) => l.includes(label))!;
    expect(row(lines, "LLM provider")).toContain("✗ off");
    expect(row(lines, "Daily spend")).toContain("✓ ok");
    expect(row(lines, "TabH2O")).toContain("○ optional");
    for (const label of ["LLM provider", "Daily spend", "TabH2O"])
      expect(row(lines, label).indexOf(label)).toBe(row(original, label).indexOf(label));
  });

  test("init prompts keep their text", () => {
    const ui = initStyles(theme);
    expect(plainText(ui.ask("\nWorld [1]: "))).toBe("\nWorld [1]: ");
    expect(plainText(ui.choice(" 1.", "default  ", "— the workbench"))).toBe(
      "   1. default  — the workbench",
    );
    expect(initStyles(plain).ask("Retry? (Y/n): ")).toBe("Retry? (Y/n): ");
  });
});
