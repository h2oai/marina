// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TermCaps } from "../scripts/term-caps";
import {
  footerLine,
  frameCompletion,
  INPUT_AREA_ROWS,
  InputFrame,
  pageBudget,
  ruleLine,
  terminalReflows,
  tipLines,
  type Welcome,
  welcomeCard,
} from "../scripts/term-frame";
import { ReplScreen } from "../scripts/term-repl";
import { plainText } from "../scripts/term-sanitize";
import { createTheme } from "../scripts/term-theme";
import { until } from "./helpers";
import { VtScreen } from "./vt-screen";

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
const ascii = createTheme(caps({ color: 0, unicode: false }));

const welcome = (t = theme): Welcome => ({
  title: "Marina 9.9.9",
  greeting: "Welcome back, ada!",
  details: ["anthropic/claude-opus-5-5", "~/work/proj"],
  sections: [
    {
      title: "Tips for getting started",
      lines: tipLines(t, [
        ["<task>", "say what you want done"],
        ["/help", "everything else"],
      ]),
    },
    { title: "Session", lines: ["New session."] },
  ],
});

describe("welcome card", () => {
  test("every row is exactly the card's width, at any terminal width", () => {
    for (const columns of [40, 60, 71, 72, 80, 100, 160]) {
      const card = welcomeCard(welcome(), theme, { columns, rows: 40 });
      const width = Math.min(columns, 120);
      for (const row of card) expect(visibleWidth(row)).toBe(width);
    }
  });

  test("the title sits in the top border; two columns when wide, one when narrow", () => {
    const wide = welcomeCard(welcome(plain), plain, { columns: 100, rows: 40 }).map(plainText);
    expect(wide[0]).toMatch(/^╭─── Marina 9\.9\.9 ─+╮$/);
    expect(wide.some((l) => /Welcome back, ada!.*│ <task> +say what you want done/.test(l))).toBe(
      true,
    );
    const narrow = welcomeCard(welcome(plain), plain, { columns: 60, rows: 40 }).map(plainText);
    expect(narrow[1]).toMatch(/^│ Welcome back, ada! +│$/);
    expect(narrow.some((l) => l.includes("Tips for getting started"))).toBe(true);
  });

  test("the wordmark shows only when the page is tall enough to keep the input in view", () => {
    const tall = welcomeCard(welcome(), theme, { columns: 100, rows: 40 });
    const short = welcomeCard(welcome(), theme, { columns: 100, rows: 24 });
    expect(plainText(tall.join("\n"))).toContain("▐▛▚▞▜▌");
    expect(plainText(short.join("\n"))).not.toContain("▐▛▚▞▜▌");
    expect(short.length + INPUT_AREA_ROWS + 1).toBeLessThanOrEqual(24);
  });

  test("ASCII terminals get an ASCII box and ellipsis, colour-off gets no escapes", () => {
    const card = welcomeCard({ ...welcome(ascii), details: ["x".repeat(200)] }, ascii, {
      columns: 80,
      rows: 40,
    });
    for (const row of card) expect(row).toMatch(/^[\x20-\x7e]*$/);
    expect(card.join("\n")).toContain("...");
  });
});

describe("input area pieces", () => {
  test("a rule carries its label near the right end and keeps the width", () => {
    const rule = plainText(ruleLine(theme, 60, "proj · ready"));
    expect(rule).toMatch(/^─+ proj · ready ───$/);
    expect(visibleWidth(rule)).toBe(60);
  });

  test("the footer spreads its halves and truncates rather than wrapping", () => {
    expect(footerLine(plain, 40, "left", "right")).toBe(`  left${" ".repeat(28)}right `);
    expect(visibleWidth(footerLine(plain, 20, "a".repeat(40), "right"))).toBeLessThan(20);
  });

  test("the page budget leaves room for the card and the input area", () => {
    expect(pageBudget(40, 14)).toBe(40 - 14 - INPUT_AREA_ROWS - 1);
    expect(pageBudget(10, 14)).toBe(0);
  });
});

describe("tab completion inside the area", () => {
  test("a unique match or a longer shared prefix fills; several matches go to the footer", () => {
    expect(frameCompletion([], "/x")).toEqual({ fill: [], choices: [] });
    expect(frameCompletion(["/status"], "/sta")).toEqual({ fill: ["/status"], choices: [] });
    expect(frameCompletion(["/status", "/stop"], "/st")).toEqual({
      fill: [],
      choices: ["/status", "/stop"],
    });
    expect(frameCompletion(["look", "look log"], "lo")).toEqual({
      fill: ["look"],
      choices: ["look", "look log"],
    });
  });
});

describe("narrowing the window", () => {
  const draw = (reflows: boolean) => {
    const vt = new VtScreen(60, 12);
    // Synchronous, so the screen is drawn before the window narrows.
    const output = { columns: 60, write: (d: string) => (vt.write(String(d)), true) };
    const frame = new InputFrame(output as unknown as NodeJS.WritableStream, () => 0, reflows);
    output.write("earlier output\n");
    frame.open([ruleLine(plain, 60, "proj · ready")], 2);
    output.write("❯ ");
    frame.drawBelow([ruleLine(plain, 60), "  footer"]);
    return { vt, output, frame };
  };

  test("a terminal that rewraps the old rule leaves none of it behind", () => {
    const { vt, output, frame } = draw(true);
    output.columns = 25;
    vt.narrow(25);
    frame.erase();
    frame.open([ruleLine(plain, 25, "proj")], 2);
    const page = vt.screen().filter(Boolean);
    expect(page.filter((l) => /^─+/.test(l))).toEqual([ruleLine(plain, 25, "proj")]);
    expect(page[0]).toBe("earlier output");
  });

  test("a terminal that truncates keeps the output above the area", () => {
    const { vt, output, frame } = draw(false);
    output.columns = 25;
    frame.erase();
    expect(vt.screen().filter(Boolean)).toEqual(["earlier output"]);
  });

  test("only terminals that say they reflow are trusted to", () => {
    expect(terminalReflows({ TERM: "xterm-256color" })).toBe(false);
    expect(terminalReflows({ TERM: "xterm-256color", TMUX: "/tmp/tmux-1/default,1,0" })).toBe(true);
    expect(terminalReflows({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(terminalReflows({ VTE_VERSION: "7800" })).toBe(true);
  });
});

describe("marina connect's input area", () => {
  test("output prints above the area; a long burst folds to the page budget", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const vt = new VtScreen(80, 24);
    output.on("data", (d) => vt.write(d.toString()));
    const screen = new ReplScreen({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      theme: plain,
      chrome: () => ({ prompt: "", rule: "Workbench · 1 here", left: "● live", right: "ada" }),
      queued: () => 0,
      onLine: () => {},
      onClose: () => {},
    });
    try {
      screen.printResult(
        Array.from({ length: 30 }, (_, i) => `line ${i}`),
        8,
      );
      screen.show();
      await until(() => vt.screen().some((l) => l.includes("● live")));
      const page = vt.screen();
      const prompt = page.findIndex((l) => /^❯\s*$/.test(l));
      expect(page[prompt - 1]).toMatch(/Workbench · 1 here ───$/);
      expect(page[prompt + 2]).toMatch(/^ {2}● live +ada$/);
      // Seven lines and the fold hint: eight rows, the rest one ctrl+o away.
      expect(page.filter((l) => /^line \d+$/.test(l))).toHaveLength(7);
      expect(page.some((l) => l.includes("+23 lines (ctrl+o to expand)"))).toBe(true);
      screen.print(["late news"]);
      const after = vt.screen();
      const at = after.findIndex((l) => /^❯\s*$/.test(l));
      expect(after[at - 2]).toBe("late news");
    } finally {
      screen.close();
      input.destroy();
      output.destroy();
    }
  });
});
