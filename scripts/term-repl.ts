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
import { createInterface, type Interface } from "node:readline";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerLine, frameCompletion, InputFrame, ruleLine } from "./term-frame";
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
  /** Esc while a command runs; true when it stopped a wait. */
  onEscape?: () => boolean;
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
  private frame: InputFrame;
  private closed = false;
  private interruptAt = 0;
  private notice?: { text: string; until: number };
  private history: string[];
  private collapsed?: string[];
  /** Candidates of an ambiguous Tab, shown in the footer until the next key. */
  private choices: string[] = [];

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
            const word = line.trimStart();
            void options.completer!(line).then(
              (matches) => {
                const { fill, choices } = frameCompletion(matches, word);
                this.choices = choices;
                done(null, [fill, word]);
                this.drawBelow();
              },
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
    this.frame = new InputFrame(options.output, () => this.rl.getCursorPos().rows);
    options.input.on("keypress", this.keypress);
    options.output.on("resize", this.resize);
  }

  private readonly keypress = (_s: string, key?: { name?: string; ctrl?: boolean }) => {
    if (this.closed) return;
    if (key?.name !== "tab") this.choices = [];
    if (key?.ctrl && key.name === "o") {
      this.expand();
      return;
    }
    if (key?.name === "escape" && this.busy && this.options.onEscape?.()) return;
    // Readline repaints the prompt row with clear-to-end-of-screen; put the footer back.
    setImmediate(() => this.drawBelow());
  };

  private readonly resize = () => {
    if (this.closed || !this.frame.visible) return;
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
    if (!this.frame.visible) return;
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
    const lines: string[] = [];
    if (this.busy) lines.push(this.busyLine());
    this.chrome = this.readChrome();
    lines.push(ruleLine(this.theme, this.columns, this.chrome.rule));
    this.frame.open(lines, 2);
    this.rl.setPrompt(this.promptText());
    this.rl.prompt(true);
    this.drawBelow();
  }

  /** Remove the input area; the cursor ends where the area began. */
  private erase(): void {
    this.frame.erase();
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
    const wasVisible = this.frame.visible;
    this.erase();
    this.options.output.write(`${lines.join("\n")}\n`);
    if (wasVisible) this.show();
  }

  /**
   * Print one command's result in at most `rows` rows (by default, what fits
   * on the screen), collapsing the rest. The full text stays available to
   * ctrl+o until the next collapse.
   */
  printResult(
    lines: string[],
    rows = Math.max(12, (this.options.output.rows || 24) - 10) + 2,
  ): void {
    if (lines.length <= rows) {
      this.print(lines);
      return;
    }
    this.collapsed = lines;
    const shown = Math.max(0, rows - 1);
    const hint = this.theme.fg("faint")(
      `     ${this.g.ellipsis} +${lines.length - shown} lines ${this.theme.fg("muted")("(ctrl+o to expand)")}`,
    );
    this.print([...lines.slice(0, shown), hint]);
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
    this.frame.eraseSubmitted(rows);
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
    if (!this.busy || !this.frame.visible || this.closed) return;
    this.busy.frame++;
    this.frame.drawAbove(this.busyLine());
  }

  private busyLine(): string {
    if (!this.busy) return "";
    const frames = this.g.spinner;
    const glyph = frames[this.busy.frame % frames.length]!;
    const seconds = Math.floor((Date.now() - this.busy.started) / 1000);
    const queued = this.options.queued();
    const meta = [
      `${seconds}s`,
      ...(queued ? [`${queued} queued`] : []),
      ...(this.options.onEscape ? ["esc to stop waiting"] : []),
    ].join(` ${this.g.dot} `);
    return `${this.theme.fg("accent2")(glyph)} ${this.theme.fg("accent2")(this.busy.label)}${this.theme.fg("faint")(` (${meta})`)}`;
  }

  private footer(): string {
    const t = this.theme;
    const notice = this.notice && this.notice.until > Date.now() ? this.notice.text : undefined;
    const left = notice
      ? t.fg("warning")(notice)
      : this.choices.length
        ? t.fg("muted")(this.choices.join("  "))
        : this.chrome.left ||
          t.fg("faint")(`/help ${this.g.dot} tab completes ${this.g.dot} ctrl+o expands`);
    return footerLine(t, this.columns, left, this.chrome.right);
  }

  private drawBelow(): void {
    if (this.closed) return;
    this.frame.drawBelow([ruleLine(this.theme, this.columns), this.footer()]);
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
    this.frame.visible = false;
    this.show();
  }

  close(): void {
    this.rl.close();
  }
}
