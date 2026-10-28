// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The layout both interactive terminals share (`marina` and `marina connect`),
 * after Claude Code and Codex: a welcome card sized to the terminal so the
 * first page holds the card, what matters now and the input; and an input
 * area at the bottom — a rule (with a label), the prompt, a rule, a footer —
 * that output scrolls above. Pure layout plus one small cursor helper;
 * readline still owns editing.
 */

import { cursorTo, moveCursor } from "node:readline";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { glyphsFor } from "./term-render";
import { fgParams, gradientAt, type Theme } from "./term-theme";

const WORDMARK = [
  "▗▖  ▗▖ ▗▄▖ ▗▄▄▖ ▗▄▄▄▖▗▖  ▗▖ ▗▄▖ ",
  "▐▛▚▞▜▌▐▌ ▐▌▐▌ ▐▌  █  ▐▛▚▖▐▌▐▌ ▐▌",
  "▐▌  ▐▌▐▛▀▜▌▐▛▀▚▖  █  ▐▌ ▝▜▌▐▛▀▜▌",
  "▐▌  ▐▌▐▌ ▐▌▐▌ ▐▌▗▄█▄▖▐▌  ▐▌▐▌ ▐▌",
];
const WORDMARK_WIDTH = WORDMARK[0]!.length;

/** Rows the input area takes: rule, prompt, rule, footer. */
export const INPUT_AREA_ROWS = 4;
/** The card never grows past this many columns, however wide the terminal. */
const CARD_MAX_WIDTH = 120;
/** Below this the card is one column. */
const TWO_COLUMN_MIN = 72;
/** The wordmark shows only when the page has room for it and the input. */
const WORDMARK_MIN_ROWS = 30;

export interface WelcomeSection {
  title: string;
  /** Already styled; truncated to the column. */
  lines: string[];
}

export interface Welcome {
  /** Set in the top border, e.g. `Marina 0.9.0`. */
  title: string;
  /** `Welcome back, ada!` */
  greeting: string;
  /** Short facts under the mark (model · folder, world · profile); already styled. */
  details: string[];
  /** The right column (or below, when narrow): tips, what is happening now. */
  sections: WelcomeSection[];
}

/** The wordmark in the palette gradient, a diagonal sweep. */
export function wordmark(theme: Theme): string[] {
  const span = WORDMARK_WIDTH + WORDMARK.length * 2;
  return WORDMARK.map((text, row) =>
    [...text]
      .map((ch, col) => {
        if (ch === " " || theme.level === 0) return ch;
        if (theme.level < 2) return theme.fg("accent")(ch);
        const hex = gradientAt(theme.palette.gradient, (col + row * 2) / span);
        return `\x1b[${fgParams(hex, theme.level)}m${ch}\x1b[0m`;
      })
      .join(""),
  );
}

/** Truncate to a width; plain text stays plain (the truncator adds SGR resets). */
const fit = (text: string, width: number, ellipsis: string) => {
  if (visibleWidth(text) <= width) return text;
  const cut = truncateToWidth(text, width, ellipsis);
  return text.includes("\x1b") ? cut : cut.replaceAll("\x1b[0m", "");
};
const pad = (text: string, width: number) =>
  `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
const center = (text: string, width: number, ellipsis: string) => {
  const t = fit(text, width, ellipsis);
  const left = Math.floor((width - visibleWidth(t)) / 2);
  return pad(`${" ".repeat(Math.max(0, left))}${t}`, width);
};

/**
 * The welcome card: title in the top border; greeting, mark and details on
 * the left; sections on the right. One column when the terminal is narrow,
 * and the wordmark only when the page is tall enough to keep the input in view.
 */
export function welcomeCard(
  welcome: Welcome,
  theme: Theme,
  size: { columns: number; rows: number },
): string[] {
  const g = glyphsFor(theme);
  const box = g.box;
  const border = theme.fg("accent");
  const width = Math.max(24, Math.min(size.columns, CARD_MAX_WIDTH));
  const lead = 3;
  const clip = (text: string, w: number) => fit(text, w, g.ellipsis);
  const title = clip(` ${theme.bold(theme.gradient(welcome.title))} `, width - lead - 4);
  const rest = Math.max(1, width - 2 - lead - visibleWidth(title));
  const top = `${border(`${box.tl}${box.h.repeat(lead)}`)}${title}${border(`${box.h.repeat(rest)}${box.tr}`)}`;
  const bottom = border(`${box.bl}${box.h.repeat(width - 2)}${box.br}`);
  const greeting = theme.bold(welcome.greeting);

  if (width < TWO_COLUMN_MIN) {
    const inner = width - 4;
    const body = [
      greeting,
      ...welcome.details,
      ...welcome.sections.flatMap((s) => [
        "",
        theme.bold(theme.fg("accent2")(s.title)),
        ...s.lines,
      ]),
    ];
    return [
      top,
      ...body.map((l) => `${border(box.v)} ${pad(clip(l, inner), inner)} ${border(box.v)}`),
      bottom,
    ];
  }

  const left = Math.min(46, Math.max(30, Math.round(width * 0.4)));
  const right = width - left - 5;
  const mark = theme.unicode && left >= WORDMARK_WIDTH + 2 && size.rows >= WORDMARK_MIN_ROWS;
  const leftLines = [
    "",
    greeting,
    "",
    ...(mark ? [...wordmark(theme), ""] : []),
    ...welcome.details,
  ].map((l) => ` ${center(l, left - 2, g.ellipsis)} `);
  const rule = theme.fg("border")(box.h.repeat(right));
  const rightLines = welcome.sections.flatMap((s, i) => [
    ...(i ? [rule] : []),
    theme.bold(theme.fg("accent2")(s.title)),
    ...s.lines.map((l) => pad(clip(l, right), right)),
  ]);
  const height = Math.max(leftLines.length + 1, rightLines.length);
  const rows: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = leftLines[i] ?? " ".repeat(left);
    const r = pad(rightLines[i] ?? "", right);
    rows.push(`${border(box.v)}${l}${border(box.v)} ${r} ${border(box.v)}`);
  }
  return [top, ...rows, bottom];
}

/** A full-width rule, with an optional label near its right end. */
export function ruleLine(theme: Theme, width: number, label?: string): string {
  const g = glyphsFor(theme);
  const h = g.box.h;
  if (!label || !visibleWidth(label)) return theme.fg("border")(h.repeat(width));
  const tag = ` ${fit(label, Math.max(1, width - 8), g.ellipsis)} `;
  const right = 3;
  const left = Math.max(1, width - visibleWidth(tag) - right);
  return `${theme.fg("border")(h.repeat(left))}${tag}${theme.fg("border")(h.repeat(right))}`;
}

/** The footer: left and right halves; the left is truncated when they meet. */
export function footerLine(theme: Theme, width: number, left: string, right: string): string {
  const l = left ? `  ${left}` : "";
  const r = right ? `${right} ` : "";
  const gap = width - visibleWidth(l) - visibleWidth(r);
  if (gap < 1) return fit(l || r, width - 1, glyphsFor(theme).ellipsis);
  return `${l}${" ".repeat(gap)}${r}`;
}

/**
 * Rows the first page has left for startup output once the card and the
 * input area are drawn (never negative).
 */
export function pageBudget(rows: number, cardRows: number): number {
  // One row of slack keeps the card's top border on the page.
  return Math.max(0, rows - cardRows - INPUT_AREA_ROWS - 1);
}

/** Tip rows: the command in the code colour, its effect in muted, aligned as a column. */
export function tipLines(theme: Theme, tips: [string, string][]): string[] {
  const width = Math.max(...tips.map(([cmd]) => visibleWidth(cmd))) + 2;
  return tips.map(
    ([cmd, what]) =>
      `${theme.fg("code")(cmd)}${" ".repeat(width - visibleWidth(cmd))}${theme.fg("muted")(what)}`,
  );
}

/** `1 agent`, `2 agents`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Whether the terminal rewraps lines when the window narrows (most current
 * ones do; xterm, rxvt and the Linux console truncate). Only terminals that
 * say who they are count, because erasing a rewrapped row on a terminal that
 * truncates would take a line of real output with it.
 */
export function terminalReflows(env: NodeJS.ProcessEnv = process.env): boolean {
  const program = env.TERM_PROGRAM ?? "";
  return (
    ["ghostty", "WezTerm", "iTerm.app", "Apple_Terminal", "vscode", "tmux"].includes(program) ||
    ["xterm-kitty", "xterm-ghostty", "foot", "wezterm", "alacritty"].includes(env.TERM ?? "") ||
    [
      "KITTY_WINDOW_ID",
      "VTE_VERSION",
      "WT_SESSION",
      "KONSOLE_VERSION",
      "ALACRITTY_WINDOW_ID",
      "TMUX",
    ].some((name) => !!env[name])
  );
}

/**
 * Readline prints an ambiguous completion's candidates at the cursor, which
 * tears the input area. Hand it only a unique match or a longer common
 * prefix (`fill`); the caller shows `choices` in the footer instead.
 */
export function frameCompletion(
  matches: string[],
  word: string,
): { fill: string[]; choices: string[] } {
  if (matches.length <= 1) return { fill: matches, choices: [] };
  let prefix = matches[0]!;
  for (const match of matches) while (!match.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return { fill: prefix.length > word.length ? [prefix] : [], choices: matches };
}

/**
 * Draws an input area around a readline prompt: rows above the prompt
 * (status, rule), rows below it (rule, footer) drawn without moving the
 * cursor, and erasing the whole area so output can be printed above it.
 */
export class InputFrame {
  /** Visible widths of the rows above the prompt, and the window width they were drawn at. */
  private above: number[] = [];
  private drawnColumns = 0;
  private below = 0;
  visible = false;

  constructor(
    private readonly output: NodeJS.WritableStream,
    /** Rows from the prompt's first row to the cursor (readline's `getCursorPos().rows`). */
    private readonly cursorRow: () => number,
    private readonly reflows = terminalReflows(),
  ) {}

  /** Write the rows above the prompt and reserve the rows below; then prompt readline. */
  open(above: string[], belowRows: number): void {
    this.above = above.map((line) => visibleWidth(line));
    this.drawnColumns = this.columns();
    this.below = belowRows;
    if (above.length) this.output.write(`${above.join("\n")}\n`);
    // Reserve the rows below the prompt so drawing them never scrolls.
    if (belowRows) this.output.write(`${"\n".repeat(belowRows)}\x1b[${belowRows}A\r`);
    this.visible = true;
  }

  /** Repaint the rows below the prompt; the cursor stays where readline left it. */
  drawBelow(lines: string[]): void {
    if (!this.visible) return;
    let out = "\x1b7";
    for (const line of lines.slice(0, this.below)) out += `\x1b[1B\r\x1b[2K${line}`;
    this.output.write(`${out}\x1b8`);
  }

  /** Repaint the first row above the prompt (a busy line) in place. */
  drawAbove(line: string): void {
    if (!this.visible || !this.above.length) return;
    this.output.write("\x1b7");
    cursorTo(this.output, 0);
    moveCursor(this.output, 0, -(this.cursorRow() + this.rowsAbove()));
    this.output.write(`\x1b[2K${line}\x1b8`);
    this.above[0] = Math.min(visibleWidth(line), this.columns());
  }

  /** Remove the area; the cursor ends where it began. */
  erase(): void {
    if (!this.visible) return;
    this.clearFrom(this.cursorRow());
  }

  /**
   * Remove the area after readline accepted a line: it has already moved
   * below the typed text, which took `typedRows` rows.
   */
  eraseSubmitted(typedRows: number): void {
    if (!this.visible) return;
    this.clearFrom(typedRows);
  }

  private columns(): number {
    return (this.output as { columns?: number }).columns || 80;
  }

  /**
   * Rows the lines above the prompt take now. After the window narrows, a
   * reflowing terminal has rewrapped a line drawn wider than it onto more
   * rows; counting one row each would leave the top of the old rule behind.
   */
  private rowsAbove(): number {
    const now = this.columns();
    if (!this.reflows || now >= this.drawnColumns) return this.above.length;
    return this.above.reduce((rows, width) => rows + Math.max(1, Math.ceil(width / now)), 0);
  }

  private clearFrom(rows: number): void {
    cursorTo(this.output, 0);
    moveCursor(this.output, 0, -(rows + this.rowsAbove()));
    this.output.write("\x1b[0J");
    this.visible = false;
  }
}
