// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The interactive screen for `marina connect`: a Claude Code-style input area
 * (a rule, the `❯` prompt, a rule, a hint footer) that stays at the bottom
 * while output scrolls above it. Asynchronous output never lands in the middle
 * of what you are typing; a submitted line shrinks to `❯ command`; a running
 * command shows a pulse with elapsed time; long results collapse to
 * `… +N lines (ctrl+o to expand)`. Readline still owns editing and history.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearScreenDown,
  createInterface,
  cursorTo,
  type Interface,
  moveCursor,
} from "node:readline";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { glyphsFor } from "./term-render";
import type { Theme } from "./term-theme";

export interface ReplScreenOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  theme: Theme;
  /** Prompt, rule label and the two footer halves, already rendered. */
  chrome: () => ReplChrome;
  queued: () => number;
  completer?: (line: string) => Promise<string[]>;
  onLine: (line: string) => void;
  onClose: () => void;
  historyFile?: string;
}

export interface ReplChrome {
  prompt: string;
  rule: string;
  left: string;
  right: string;
}

const HISTORY_LIMIT = 1000;
// Lines that look like they carry a secret never reach the history file.
const SECRET_LINE = /\b(key|token|password|passwd|secret|login)\b|sk-[a-z0-9]{8,}/i;

export function defaultHistoryFile(env = process.env): string | undefined {
  if (env.MARINA_HISTORY === "off" || env.MARINA_HISTORY === "0") return undefined;
  return env.MARINA_HISTORY || join(homedir(), ".marina", "history", "connect");
}

function loadHistory(file: string | undefined): string[] {
  if (!file || !existsSync(file)) return [];
  try {
    // readline wants newest first.
    return readFileSync(file, "utf8").split("\n").filter(Boolean).reverse().slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export class ReplScreen {
  private rl: Interface;
  private theme: Theme;
  private g;
  private chrome: ReplChrome;
  private busy?: { label: string; started: number; frame: number };
  private spinner?: ReturnType<typeof setInterval>;
  /** Rows drawn above the prompt (status + rule). */
  private above = 0;
  private visible = false;
  private closed = false;
  private interruptAt = 0;
  private notice?: { text: string; until: number };
  private history: string[];
  private collapsed?: string[];

  constructor(private options: ReplScreenOptions) {
    this.theme = options.theme;
    this.g = glyphsFor(this.theme);
    this.chrome = this.readChrome();
    this.history = loadHistory(options.historyFile);
    this.rl = createInterface({
      input: options.input,
      output: options.output,
      terminal: true,
      history: [...this.history],
      historySize: HISTORY_LIMIT,
      removeHistoryDuplicates: true,
      prompt: this.promptText(),
      completer: options.completer
        ? (line: string, done: (err: Error | null, result: [string[], string]) => void) => {
            void options.completer!(line).then(
              (matches) => done(null, [matches, line.trimStart()]),
              () => done(null, [[], line]),
            );
          }
        : undefined,
    });
    this.rl.on("line", (line) => this.submit(line));
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.stopSpinner();
      this.erase();
      options.onClose();
    });
    options.input.on("keypress", this.keypress);
    options.output.on("resize", this.resize);
  }

  private readonly keypress = (_s: string, key?: { name?: string; ctrl?: boolean }) => {
    if (this.closed) return;
    if (key?.ctrl && key.name === "o") {
      this.expand();
      return;
    }
    // Readline repaints the prompt row with clear-to-end-of-screen; put the footer back.
    setImmediate(() => this.drawBelow());
  };

  private readonly resize = () => {
    if (this.closed || !this.visible) return;
    this.redraw();
  };

  private get columns(): number {
    return Math.max(20, this.options.output.columns || 80);
  }

  private readChrome(): ReplChrome {
    const c = this.options.chrome();
    return {
      ...c,
      prompt: c.prompt || `${this.theme.fg("accent")(this.theme.bold(this.g.prompt))} `,
    };
  }

  private promptText(): string {
    return this.chrome.prompt;
  }

  /** Re-read the chrome; repaint the whole area only when the prompt or rule changed. */
  refresh(force = false): void {
    if (this.closed) return;
    const next = this.readChrome();
    const moved = force || next.prompt !== this.chrome.prompt || next.rule !== this.chrome.rule;
    this.chrome = next;
    if (!this.visible) return;
    if (moved) this.redraw();
    else this.drawBelow();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.g = glyphsFor(theme);
    this.refresh(true);
  }

  /** Draw status (when busy), the top rule, the prompt with the current draft, and the footer. */
  show(): void {
    if (this.closed) return;
    const out = this.options.output;
    const lines: string[] = [];
    if (this.busy) lines.push(this.busyLine());
    this.chrome = this.readChrome();
    lines.push(this.rule(this.chrome.rule));
    this.above = lines.length;
    out.write(`${lines.join("\n")}\n`);
    // Reserve the two rows below the prompt so drawing them never scrolls.
    out.write("\n\n\x1b[2A\r");
    this.visible = true;
    this.rl.setPrompt(this.promptText());
    this.rl.prompt(true);
    this.drawBelow();
  }

  /** Remove the input area; the cursor ends where the area began. */
  private erase(): void {
    if (!this.visible) return;
    const out = this.options.output;
    const rows = this.rl.getCursorPos().rows;
    cursorTo(out, 0);
    moveCursor(out, 0, -(rows + this.above));
    clearScreenDown(out);
    this.visible = false;
  }

  private redraw(): void {
    this.erase();
    this.show();
  }

  /** Print finished lines above the input area. */
  print(lines: string[]): void {
    if (this.closed || lines.length === 0) {
      return;
    }
    const wasVisible = this.visible;
    this.erase();
    this.options.output.write(`${lines.join("\n")}\n`);
    if (wasVisible) this.show();
  }

  /**
   * Print one command's result, collapsed past the screen's height. The full
   * text stays available to ctrl+o until the next collapse.
   */
  printResult(lines: string[]): void {
    const rows = this.options.output.rows || 24;
    const max = Math.max(12, rows - 10);
    if (lines.length <= max + 2) {
      this.print(lines);
      return;
    }
    this.collapsed = lines;
    const hidden = lines.length - max;
    const hint = this.theme.fg("faint")(
      `     ${this.g.ellipsis} +${hidden} lines ${this.theme.fg("muted")("(ctrl+o to expand)")}`,
    );
    this.print([...lines.slice(0, max), hint]);
  }

  expand(): void {
    if (!this.collapsed) {
      this.flash("nothing collapsed");
      return;
    }
    const lines = this.collapsed;
    this.collapsed = undefined;
    this.print([
      this.theme.fg("faint")(`  ${this.g.result}  expanded ${lines.length} lines`),
      ...lines,
    ]);
  }

  private submit(line: string): void {
    // Readline has already moved below the typed text; the area starts above it.
    const typed = this.promptWidth() + visibleWidth(line);
    const rows = Math.floor(Math.max(0, typed - 1) / this.columns) + 1;
    const out = this.options.output;
    cursorTo(out, 0);
    moveCursor(out, 0, -(rows + this.above));
    clearScreenDown(out);
    this.visible = false;
    const trimmed = line.trim();
    if (trimmed) {
      // The transient prompt: what you ran, compact, then a breath of space.
      out.write(`${this.theme.fg("muted")(`${this.g.prompt} `)}${trimmed}\n`);
      this.remember(trimmed);
    }
    this.show();
    if (trimmed) this.options.onLine(trimmed);
  }

  private remember(line: string): void {
    const file = this.options.historyFile;
    if (!file || SECRET_LINE.test(line)) return;
    this.history = [line, ...this.history.filter((h) => h !== line)].slice(0, HISTORY_LIMIT);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${[...this.history].reverse().join("\n")}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // allow-empty-catch: history is a convenience; an unwritable home never blocks the REPL.
    }
  }

  private interrupt(): void {
    if (this.rl.line) {
      // First Ctrl-C clears the draft, as in Claude Code and Codex.
      this.rl.write(null, { ctrl: true, name: "u" });
      this.rl.write(null, { ctrl: true, name: "k" });
      this.interruptAt = 0;
      return;
    }
    const now = Date.now();
    if (now - this.interruptAt < 2000) {
      this.rl.close();
      return;
    }
    this.interruptAt = now;
    this.flash("press ctrl+c again to exit", 2000);
  }

  /** A short-lived message in the footer. */
  flash(text: string, ms = 2500): void {
    this.notice = { text, until: Date.now() + ms };
    this.drawBelow();
    setTimeout(() => this.drawBelow(), ms + 20);
  }

  setBusy(label: string | undefined): void {
    if (label) {
      this.busy = { label, started: Date.now(), frame: 0 };
      this.progress(true);
      this.redraw();
      if (!this.spinner) this.spinner = setInterval(() => this.tick(), 120);
    } else if (this.busy) {
      this.busy = undefined;
      this.stopSpinner();
      this.progress(false);
      this.redraw();
    }
  }

  private stopSpinner(): void {
    if (this.spinner) clearInterval(this.spinner);
    this.spinner = undefined;
  }

  /** Ghostty / Windows Terminal native progress (OSC 9;4), indeterminate while busy. */
  private progress(on: boolean): void {
    const env = process.env;
    if (env.TERM_PROGRAM !== "ghostty" && !env.WT_SESSION) return;
    this.options.output.write(on ? "\x1b]9;4;3\x07" : "\x1b]9;4;0\x07");
  }

  private tick(): void {
    if (!this.busy || !this.visible || this.closed) return;
    this.busy.frame++;
    const out = this.options.output;
    const rows = this.rl.getCursorPos().rows;
    out.write(`\x1b7`);
    cursorTo(out, 0);
    moveCursor(out, 0, -(rows + this.above));
    out.write(`\x1b[2K${this.busyLine()}\x1b8`);
  }

  private busyLine(): string {
    if (!this.busy) return "";
    const frames = this.g.spinner;
    const glyph = frames[this.busy.frame % frames.length]!;
    const seconds = Math.floor((Date.now() - this.busy.started) / 1000);
    const queued = this.options.queued();
    const meta = [`${seconds}s`, ...(queued ? [`${queued} queued`] : [])].join(` ${this.g.dot} `);
    return `${this.theme.fg("accent2")(glyph)} ${this.theme.fg("accent2")(this.busy.label)}${this.theme.fg("faint")(` (${meta})`)}`;
  }

  private rule(label?: string): string {
    const width = this.columns;
    const h = this.g.box.h;
    if (!label || !visibleWidth(label)) return this.theme.fg("border")(h.repeat(width));
    const tag = ` ${label} `;
    const right = 3;
    const left = Math.max(1, width - visibleWidth(tag) - right);
    return `${this.theme.fg("border")(h.repeat(left))}${tag}${this.theme.fg("border")(h.repeat(right))}`;
  }

  private footer(): string {
    const t = this.theme;
    const width = this.columns;
    const notice = this.notice && this.notice.until > Date.now() ? this.notice.text : undefined;
    const left = notice
      ? t.fg("warning")(`  ${notice}`)
      : `  ${this.chrome.left || t.fg("faint")(`/help ${this.g.dot} tab completes ${this.g.dot} ctrl+o expands`)}`;
    const right = `${this.chrome.right} `;
    const gap = width - visibleWidth(left) - visibleWidth(right);
    if (gap < 1) return truncateToWidth(left, width - 1);
    return `${left}${" ".repeat(gap)}${right}`;
  }

  private drawBelow(): void {
    if (!this.visible || this.closed) return;
    const out = this.options.output;
    out.write("\x1b7");
    out.write(`\x1b[1B\r\x1b[2K${this.theme.fg("border")(this.g.box.h.repeat(this.columns))}`);
    out.write(`\x1b[1B\r\x1b[2K${this.footer()}`);
    out.write("\x1b8");
  }

  private promptWidth(): number {
    return visibleWidth(this.promptText());
  }

  setTitle(title: string): void {
    // Our own text only; never server bytes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control bytes from the title
    this.options.output.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`);
  }

  clear(): void {
    this.options.output.write("\x1b[2J\x1b[3J\x1b[H");
    this.visible = false;
    this.show();
  }

  close(): void {
    this.rl.close();
  }
}
