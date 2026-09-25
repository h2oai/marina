// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

/** Native tool output is data, never terminal instructions (OSC links/clipboard, cursor escapes). */
export function terminalText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal control bytes.
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export const TERMINAL_COMMANDS = [
  "/help",
  "/agents",
  "/spawn",
  "/use",
  "/stop",
  "/dashboard",
  "/world",
  "/harness",
  "/quit",
];
export const TERMINAL_HELP = `Type a task to work with the selected agent. End a line with \\ for multiple lines.
/agents                         Show agents, status and workspace
/spawn claude|codex|pi [name]     Add an agent in an isolated Git worktree
/use marina|claude|codex|pi|name  Switch agents (first native agent works in this folder)
/stop                           Interrupt the selected agent
/world <command>                Run any Marina command
/dashboard                      Open the rich dashboard
/harness                        Show the selected runtime/model/dialect
/harness save <name>            Remember this harness for future launches here
/harness use <name-or-path>      Load a saved or explicitly supplied JSON harness
/harness list                   List saved harnesses
/harness export                 Print portable harness JSON (no credentials)
/quit                           Stop owned agents and exit
Tab completes terminal commands. Ctrl+C interrupts active work; again exits.
Native agents retain their own tools and permission rules. Additional worktrees start at committed HEAD.`;

/** One input owner for tasks and queued approvals; output redraws unfinished input. */
export class CodeTerminal {
  private rl: Interface;
  private closed = false;
  private prompt = "marina › ";
  private pending: { text: string; resolve: (answer: string) => void }[] = [];
  private question?: { text: string; resolve: (answer: string) => void };
  private draft = "";
  private multiline: string[] = [];
  constructor(options: { line: (text: string) => void; interrupt: () => void; close: () => void }) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      completer: (line: string) => [
        TERMINAL_COMMANDS.filter((command) => command.startsWith(line)),
        line,
      ],
      historySize: 200,
    });
    this.rl.on("line", (line: string) => {
      if (this.question) {
        const current = this.question;
        this.question = undefined;
        current.resolve(line);
        this.nextQuestion();
        return;
      }
      if (line.endsWith("\\")) {
        this.multiline.push(line.slice(0, -1));
        this.redraw();
        return;
      }
      const text = [...this.multiline, line].join("\n").trim();
      this.multiline = [];
      if (text) options.line(text);
      this.redraw();
    });
    this.rl.on("SIGINT", options.interrupt);
    this.rl.on("close", () => {
      this.closed = true;
      this.question?.resolve("");
      for (const question of this.pending) question.resolve("");
      this.question = undefined;
      this.pending = [];
      options.close();
    });
    this.redraw();
  }
  private redraw() {
    if (this.closed) return;
    this.rl.setPrompt(this.question?.text ?? (this.multiline.length ? "… " : this.prompt));
    this.rl.prompt(true);
  }
  setTarget(label: string) {
    this.prompt = `${terminalText(label)} › `;
    this.redraw();
  }
  write(text: string) {
    if (process.stderr.isTTY && !this.closed) {
      clearLine(process.stderr, 0);
      cursorTo(process.stderr, 0);
    }
    process.stderr.write(`${terminalText(text)}\n`);
    this.redraw();
  }
  ask(text: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !process.stdin.isTTY || signal?.aborted) return Promise.resolve("");
    return new Promise((resolve) => {
      const question = {
        text: terminalText(text),
        resolve: (answer: string) => {
          signal?.removeEventListener("abort", cancel);
          resolve(answer);
        },
      };
      const cancel = () => {
        if (this.question === question) {
          this.rl.write(null, { ctrl: true, name: "u" });
          this.question = undefined;
          this.nextQuestion();
        } else this.pending = this.pending.filter((entry) => entry !== question);
        question.resolve("");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(question);
      this.nextQuestion();
    });
  }
  private nextQuestion() {
    if (this.question || this.closed) return;
    this.question = this.pending.shift();
    if (this.question) {
      if (!this.draft) this.draft = this.rl.line;
      this.rl.write(null, { ctrl: true, name: "u" });
    } else if (this.draft) {
      this.rl.write(this.draft);
      this.draft = "";
    }
    this.redraw();
  }
  close() {
    this.rl.close();
  }
}
