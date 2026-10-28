// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";

import { createInterface, type Interface } from "node:readline";
import { visibleWidth } from "@earendil-works/pi-tui";
import { terminalCompletionItems } from "./code-completion";
import { colorizeDiff, diffColorEnabled } from "./code-diff";
import type { CodeEditor, CodeEditorOptions, CodeEditorState } from "./code-editor";
import { terminalText } from "./code-presentation";
import { styleCodeEntry, styleLocation, themeFor } from "./code-style";
import type { EntryFormat, TerminalView } from "./code-views";
import { footerLine, frameCompletion, InputFrame, ruleLine } from "./term-frame";
import { glyphsFor } from "./term-render";
import { sanitizeServerText } from "./term-sanitize";

interface Draft {
  text: string;
  cursor: number;
  history: string[];
}
const empty = (): Draft => ({ text: "", cursor: 0, history: [] });

/**
 * Readline remains the input owner for scrollback, pipes and one-shot approval
 * prompts. On a terminal it sits in the shared input area (`term-frame.ts`):
 * a rule naming where input goes, the `❯` prompt, a rule, and a footer with
 * the live status — the same layout as `marina connect`.
 */
export class ReadlineCodeEditor implements CodeEditor {
  private rl: Interface;
  private closed = false;
  private replacing = false;
  private view: TerminalView = "coding";
  private drafts: Record<TerminalView, Draft> = {
    coding: empty(),
    world: empty(),
    approvals: empty(),
    panel: empty(),
  };
  private history: string[] = [];
  private state?: CodeEditorState;
  private readonly tty: boolean;
  private readonly frame: InputFrame;
  /** The rule label and prompt last drawn; the area is redrawn only when they change. */
  private drawn?: string;
  /** Candidates of an ambiguous Tab, shown in the footer until the next key. */
  private choices: string[] = [];
  private readonly resize = () => this.redraw(true);
  private readonly key = (_text: string, key: { name?: string }) => {
    if (key.name !== "tab") this.choices = [];
    if (key.name === "f6") this.options.navigate(this.view === "world" ? "coding" : "world");
    if (key.name === "f7") this.options.navigate("approvals");
    if (key.name === "f8") this.options.navigate("panel");
    // Readline repaints the prompt row with clear-to-end-of-screen; put the footer back.
    if (this.tty) setImmediate(() => this.drawBelow());
  };

  constructor(private options: CodeEditorOptions) {
    this.tty = !!options.input.isTTY && !!options.output.isTTY;
    this.frame = new InputFrame(options.output, () => this.rl.getCursorPos().rows);
    this.rl = this.create();
    options.output.on("resize", this.resize);
    options.input.on("keypress", this.key);
  }

  private create(history: string[] = []): Interface {
    this.history = [...history];
    const editor = createInterface({
      input: this.options.input,
      output: this.options.output,
      terminal: this.tty,
      history,
      historySize: this.view === "approvals" ? 0 : 200,
      completer: (line: string) => {
        const matches =
          this.view === "approvals" || this.state?.answer
            ? []
            : terminalCompletionItems(
                line,
                this.options.connected,
                this.options.completions?.(),
                this.view === "world",
              ).map((entry) => entry.value);
        if (!this.tty) return [matches, line];
        const { fill, choices } = frameCompletion(matches, line);
        this.choices = choices;
        return [fill, line];
      },
    });
    editor.on("line", (text: string) => this.accept(text));
    editor.on("history", (entries: string[]) => {
      this.history = [...entries];
    });
    editor.on("SIGINT", this.options.interrupt);
    editor.on("close", () => {
      if (this.replacing) return;
      this.frame.erase();
      this.closed = true;
      this.options.output.off("resize", this.resize);
      this.options.input.off("keypress", this.key);
      this.options.close();
    });
    return editor;
  }

  focus(view: TerminalView) {
    if (view === this.view || this.closed) return;
    let bytes = 0;
    this.drafts[this.view] = {
      text: this.rl.line,
      cursor: this.rl.cursor,
      history: this.history
        .filter((text) => {
          const size = Buffer.byteLength(text);
          if (size > 16 * 1024 || bytes + size > 64 * 1024) return false;
          bytes += size;
          return true;
        })
        .slice(0, 200),
    };
    this.view = view;
    this.replace(this.drafts[view]);
  }

  reset(view: TerminalView) {
    this.drafts[view] = empty();
    if (view === this.view && !this.closed) this.replace(empty());
  }

  /** A submitted line: the area shrinks to `❯ text` in scrollback, then comes back below it. */
  private accept(text: string) {
    if (this.tty && this.frame.visible) {
      const columns = this.columns();
      const typed = visibleWidth(this.rl.getPrompt()) + visibleWidth(text);
      this.frame.eraseSubmitted(Math.floor(Math.max(0, typed - 1) / columns) + 1);
      this.drawn = undefined;
      const theme = this.theme();
      if (text.trim())
        this.options.output.write(
          `${theme.fg("muted")(`${glyphsFor(theme).prompt} `)}${terminalText(text.trim())}\n`,
        );
    }
    this.options.line(text);
    if (!this.frame.visible) this.redraw();
  }

  private columns(): number {
    return Math.max(20, (this.options.output as { columns?: number }).columns ?? 80);
  }

  private theme() {
    return themeFor(this.tty ? this.options.output : undefined);
  }

  private replace(draft: Draft) {
    if (this.tty) {
      this.frame.erase();
      this.drawn = undefined;
    }
    this.replacing = true;
    this.rl.close();
    this.replacing = false;
    this.rl = this.create([...draft.history]);
    this.rl.write(draft.text.slice(draft.cursor));
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(draft.text.slice(0, draft.cursor));
    this.redraw();
  }

  update(state: CodeEditorState) {
    this.state = state;
    this.redraw();
  }

  private redraw(force = false) {
    if (this.closed || !this.tty || !this.state) return;
    const { target, status, focus, answer, multiline, badge, location } = this.state;
    const columns = this.columns();
    const limit = Math.max(2, Math.floor((columns - 8) / 2));
    const compact = (text: string, length: number) => {
      const chars = [...text];
      return chars.length > length ? `${chars.slice(0, Math.max(0, length - 1)).join("")}…` : text;
    };
    // The folder names where you are; the selected agent only when it is not Marina's own.
    const folder = basename(location?.split(" · ").at(-1)?.trim() || "") || "marina";
    const agent = target && !target.startsWith("marina") ? ` · ${compact(target, 18)}` : "";
    const busy = status ? ` · ${compact(status, Math.max(8, limit - 24))}` : "";
    const coding = !answer && focus !== "world" && focus !== "panel";
    const destination = answer
      ? "answer"
      : focus === "world"
        ? "world command"
        : focus === "panel"
          ? "panel control"
          : `${compact(folder, 24)}${agent}${busy}`;
    const theme = this.theme();
    const label = styleLocation(
      {
        destination,
        ...(coding
          ? {
              folder: compact(folder, 24),
              agent: agent ? agent.slice(3) : undefined,
              status: busy ? busy.slice(3) : undefined,
            }
          : {}),
        badge: badge || undefined,
        more: !!multiline && !answer,
      },
      theme,
    );
    const g = glyphsFor(theme);
    const prompt = multiline
      ? `${theme.fg("muted")(g.ellipsis)} `
      : `${theme.bold(theme.fg("accent")(g.prompt))} `;
    const drawn = `${columns}\u0000${label}\u0000${prompt}`;
    if (!force && this.frame.visible && drawn === this.drawn) {
      this.drawBelow();
      return;
    }
    this.frame.erase();
    this.drawn = drawn;
    this.frame.open([ruleLine(theme, columns, label)], 2);
    this.rl.setPrompt(prompt);
    this.rl.prompt(true);
    this.drawBelow();
  }

  /** The rule under the prompt and the footer: live status left, waiting views right. */
  private drawBelow() {
    if (this.closed || !this.tty || !this.state) return;
    const theme = this.theme();
    const g = glyphsFor(theme);
    const columns = this.columns();
    // The live segments are colour-coded; with colour off the footer keeps its hint.
    const left = this.choices.length
      ? theme.fg("muted")(this.choices.join("  "))
      : (theme.level > 0 && this.state.statusLine) ||
        theme.fg("faint")(`/help ${g.dot} F6 world ${g.dot} ctrl+c interrupts`);
    const right = this.state.badge ? theme.fg("warning")(this.state.badge) : "";
    this.frame.drawBelow([ruleLine(theme, columns), footerLine(theme, columns, left, right)]);
  }

  print(text: string, format?: EntryFormat) {
    if (this.tty && !this.closed) this.frame.erase();
    const theme = this.theme();
    if (format === "styled") {
      // Rendered here (a live panel): vetted SGR survives, nothing else does.
      this.options.output.write(`${sanitizeServerText(text, theme)}\n`);
      this.redraw(true);
      return;
    }
    const safe = terminalText(text);
    // Colour is added after sanitising, only from structure: the diff hint
    // and the entry's label, never from bytes in the text.
    this.options.output.write(
      `${format === "diff" ? colorizeDiff(safe, diffColorEnabled(this.options.output), theme) : styleCodeEntry(safe, theme)}\n`,
    );
    this.redraw(true);
  }

  close() {
    this.rl.close();
  }
}
