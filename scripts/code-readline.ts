// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  clearScreenDown,
  createInterface,
  cursorTo,
  type Interface,
  moveCursor,
} from "node:readline";
import { TERMINAL_COMMANDS } from "./code-controls";
import type { CodeEditor, CodeEditorOptions, CodeEditorState } from "./code-editor";
import { terminalText } from "./code-presentation";
import type { TerminalView } from "./code-views";
import { WORKFLOW_COMPLETIONS } from "./code-workflow";

interface Draft {
  text: string;
  cursor: number;
  history: string[];
}
const empty = (): Draft => ({ text: "", cursor: 0, history: [] });

/** Readline remains the input owner for scrollback, pipes and one-shot approval prompts. */
export class ReadlineCodeEditor implements CodeEditor {
  private rl: Interface;
  private closed = false;
  private replacing = false;
  private view: TerminalView = "coding";
  private drafts: Record<TerminalView, Draft> = {
    coding: empty(),
    world: empty(),
    approvals: empty(),
  };
  private history: string[] = [];
  private state?: CodeEditorState;
  private readonly tty: boolean;
  private readonly resize = () => this.redraw();
  private readonly key = (_text: string, key: { name?: string }) => {
    if (key.name === "f6") this.options.navigate(this.view === "world" ? "coding" : "world");
    if (key.name === "f7") this.options.navigate("approvals");
  };

  constructor(private options: CodeEditorOptions) {
    this.tty = !!options.input.isTTY && !!options.output.isTTY;
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
      completer: (line: string) => [
        (line.includes(" ") ? WORKFLOW_COMPLETIONS : TERMINAL_COMMANDS).filter((command) =>
          command.startsWith(line),
        ),
        line,
      ],
    });
    editor.on("line", this.options.line);
    editor.on("history", (entries: string[]) => {
      this.history = [...entries];
    });
    editor.on("SIGINT", this.options.interrupt);
    editor.on("close", () => {
      if (this.replacing) return;
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

  private replace(draft: Draft) {
    if (this.tty) this.clearPrompt();
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

  private redraw() {
    if (this.closed || !this.tty || !this.state) return;
    const { target, status, focus, answer, multiline, badge } = this.state;
    const columns = (this.options.output as { columns?: number }).columns ?? 80;
    const limit = Math.max(2, Math.floor((columns - 8) / 2));
    const compact = (text: string, length: number) => {
      const chars = [...text];
      return chars.length > length ? `${chars.slice(0, Math.max(0, length - 1)).join("")}…` : text;
    };
    const label = compact(target, Math.min(18, Math.max(1, Math.floor(limit / 2) - 1)));
    const destination = answer
      ? "answer"
      : focus === "world"
        ? "world command"
        : `${label}·${compact(status, Math.max(1, limit - [...label].length - 1))}`;
    const prompt = `${destination}${multiline && !answer ? " …" : ""} › `;
    this.rl.setPrompt(badge ? `${badge}\n${prompt}` : prompt);
    this.rl.prompt(true);
  }

  private clearPrompt(): number {
    const rows = this.rl.getCursorPos().rows;
    cursorTo(this.options.output, 0);
    if (rows) moveCursor(this.options.output, 0, -rows);
    clearScreenDown(this.options.output);
    return rows;
  }

  print(text: string) {
    const rows = this.tty && !this.closed ? this.clearPrompt() : 0;
    this.options.output.write(`${terminalText(text)}\n`);
    if (rows) this.options.output.write("\n".repeat(rows));
    this.redraw();
  }

  close() {
    this.rl.close();
  }
}
