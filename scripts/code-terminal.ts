// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  clearScreenDown,
  createInterface,
  cursorTo,
  type Interface,
  moveCursor,
} from "node:readline";
import { terminalText } from "./code-presentation";
import {
  type ConversationView,
  type TerminalView,
  TerminalViews,
  type TranscriptView,
} from "./code-views";

export {
  formatCodePerception,
  terminalText,
  verificationReadinessLabel,
} from "./code-presentation";

/** Explicit world input is independent of a coding task or pending approval answer. */
export function isWorldInput(text: string): boolean {
  return /^\/world(?:\s|$)/.test(text.trimStart());
}

export const TERMINAL_COMMANDS = [
  "/help",
  "/view",
  "/task",
  "/agents",
  "/status",
  "/diff",
  "/verify",
  "/review",
  "/spawn",
  "/use",
  "/stop",
  "/dashboard",
  "/world",
  "/harness",
  "/quit",
];
export const TERMINAL_HELP = `Type a task to work with the selected agent. End a line with \\ for multiple lines.
/view coding|world|approvals     Focus a conversation or pending input request
/view older|newer               Read retained local transcript pages
/task <request>                 Work toward candidate verification before review
/status                         Show the current Marina session and task
/diff                           Inspect the current Marina workspace diff
/verify [candidate|live]         Start snapshot checks (default) or live checks
/review                         Inspect the latest task and its verification
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
F6 switches coding/world; F7 opens pending requests. Switching preserves each draft.
Tab completes terminal commands. Ctrl+C interrupts active work; again exits.
Use /world during a launch or approval prompt to keep participating; the approval stays pending.
Native agents retain their own tools and permission rules. Additional worktrees start at committed HEAD.`;

export interface CodeTerminalOptions {
  line: (text: string) => void;
  interrupt: () => void;
  close: () => void;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Focus views are interactive presentation only; redirected output stays continuous. */
  views?: boolean;
}

interface EditorDraft {
  text: string;
  cursor: number;
  multiline: string[];
  history: string[];
}

function emptyDraft(): EditorDraft {
  return { text: "", cursor: 0, multiline: [], history: [] };
}

/** One input owner; switching a local view never dispatches a world action. */
export class CodeTerminal {
  private rl: Interface;
  private readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  private readonly output: NodeJS.WritableStream & { isTTY?: boolean };
  private closed = false;
  private replacingEditor = false;
  private target = "marina";
  private status = "ready";
  private readonly tty: boolean;
  private readonly views?: TerminalViews;
  private readonly drafts: Record<TerminalView, EditorDraft> = {
    coding: emptyDraft(),
    world: emptyDraft(),
    approvals: emptyDraft(),
  };
  private returnView: ConversationView = "coding";
  private pending: { text: string; resolve: (answer: string) => void }[] = [];
  private question?: { text: string; resolve: (answer: string) => void };
  private draft?: { text: string; cursor: number };
  private multiline: string[] = [];
  private editorHistory: string[] = [];
  private redrawTimer?: ReturnType<typeof setTimeout>;
  private readonly resize = () => this.redraw();
  private readonly viewKey = (_text: string, key: { name?: string }) => {
    if (!this.views || this.closed) return;
    if (key.name === "f6") this.selectView(this.views.focus === "world" ? "coding" : "world");
    if (key.name === "f7") this.selectView("approvals");
  };

  constructor(private options: CodeTerminalOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.tty = !!this.input.isTTY && !!this.output.isTTY;
    if (options.views && this.tty) this.views = new TerminalViews();
    this.rl = this.createEditor();
    this.output.on("resize", this.resize);
    this.input.on("keypress", this.viewKey);
    this.redraw();
  }

  private createEditor(history: string[] = []): Interface {
    this.editorHistory = [...history];
    const editor = createInterface({
      input: this.input,
      output: this.output,
      completer: (line: string) => [
        TERMINAL_COMMANDS.filter((command) => command.startsWith(line)),
        line,
      ],
      history,
      historySize: this.views?.focus === "approvals" ? 0 : 200,
      terminal: this.tty,
    });
    editor.on("line", (line: string) => this.line(line));
    editor.on("history", (entries: string[]) => {
      this.editorHistory = [...entries];
    });
    editor.on("SIGINT", this.options.interrupt);
    editor.on("close", () => {
      if (this.replacingEditor) return;
      this.closed = true;
      clearTimeout(this.redrawTimer);
      this.output.off("resize", this.resize);
      this.input.off("keypress", this.viewKey);
      this.question?.resolve("");
      for (const question of this.pending) question.resolve("");
      this.question = undefined;
      this.pending = [];
      this.options.close();
    });
    return editor;
  }

  private line(line: string) {
    if (/^\/view(?:\s|$)/.test(line.trimStart())) {
      this.selectView(line.trim().slice(5).trim());
      return;
    }
    if (isWorldInput(line)) {
      this.views?.append("world", `› ${line.trim()}`);
      this.options.line(line.trim());
      this.redraw();
      return;
    }
    if (this.question && (!this.views || this.views.focus === "approvals")) {
      // Help and explicit UI controls never accidentally become approval answers.
      const verb = line.trim().split(/\s/, 1)[0];
      if (this.views && TERMINAL_COMMANDS.includes(verb ?? "")) {
        this.options.line(line.trim());
        this.redraw();
        return;
      }
      const current = this.question;
      this.question = undefined;
      this.drafts.approvals = emptyDraft();
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
    if (text) {
      const view = this.views?.focus === "world" ? "world" : "coding";
      const verb = text.split(/\s/, 1)[0]!;
      this.views?.append(view, `› ${text}`);
      this.options.line(
        view === "world" && !TERMINAL_COMMANDS.includes(verb)
          ? `/world ${text.replace(/^\//, "")}`
          : text,
      );
    }
    this.redraw();
  }

  selectView(name: string): boolean {
    if (!this.views) {
      this.print(
        "Focused views require an interactive terminal. Output remains continuous; /world is available.",
      );
      return false;
    }
    if (name === "older" || name === "newer") {
      this.print(this.views.page(name));
      return true;
    }
    if (name !== "coding" && name !== "world" && name !== "approvals") {
      this.print(
        "Views: /view coding | /view world | /view approvals | /view older | /view newer. F6 switches conversations; F7 opens requests.",
      );
      return false;
    }
    if (name === "approvals" && !this.question) {
      this.print("No pending input requests. Your conversation and draft remain selected.");
      return false;
    }
    if (this.views.focus !== name) {
      this.saveEditor(this.views.focus);
      this.views.select(name);
      if (name !== "approvals") this.returnView = name;
      this.replaceEditor(this.drafts[name]);
    } else this.views.select(name);
    this.print(name === "approvals" ? this.questionDetails() : this.views.snapshot(name));
    return true;
  }

  private saveEditor(view: TerminalView) {
    const draft = this.takeInput();
    let bytes = 0;
    const history = this.editorHistory
      .filter((text) => {
        const size = Buffer.byteLength(text);
        if (size > 16 * 1024 || bytes + size > 64 * 1024) return false;
        bytes += size;
        return true;
      })
      .slice(0, 200);
    this.drafts[view] = { ...draft, history, multiline: [...this.multiline] };
  }

  private replaceEditor(draft: EditorDraft) {
    // The new editor has no knowledge of the old prompt's wrapped rows.
    const rows = this.rl.getCursorPos().rows;
    cursorTo(this.output, 0);
    if (rows) moveCursor(this.output, 0, -rows);
    clearScreenDown(this.output);
    this.replacingEditor = true;
    this.rl.close();
    this.replacingEditor = false;
    this.multiline = [...draft.multiline];
    this.rl = this.createEditor([...draft.history]);
    this.restoreInput(draft);
  }

  private scheduleRedraw() {
    if (this.redrawTimer || this.closed) return;
    this.redrawTimer = setTimeout(() => this.redraw(), 32);
    this.redrawTimer.unref();
  }

  private redraw() {
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    if (this.closed || !this.tty) return;
    const columns = (this.output as { columns?: number }).columns ?? 80;
    const limit = Math.max(2, Math.floor((columns - 8) / 2));
    const compact = (text: string, length: number) => {
      const chars = [...text];
      return chars.length > length ? `${chars.slice(0, Math.max(0, length - 1)).join("")}…` : text;
    };
    const targetLimit = Math.min(18, Math.max(1, Math.floor(limit / 2) - 1));
    const target = compact(this.target, targetLimit);
    const label = `${target}·${compact(this.status, Math.max(1, limit - [...target].length - 1))}`;
    const answer = !!this.question && (!this.views || this.views.focus === "approvals");
    const destination = answer ? "answer" : this.views?.focus === "world" ? "world command" : label;
    const prompt = `${destination}${this.multiline.length && !answer ? " …" : ""} › `;
    this.rl.setPrompt(
      this.views
        ? `${this.views.badge(this.pending.length + (this.question ? 1 : 0))}\n${prompt}`
        : prompt,
    );
    this.rl.prompt(true);
  }

  setTarget(label: string) {
    this.target = terminalText(label).replace(/\s+/g, " ");
    this.redraw();
  }
  setStatus(status: string) {
    const next = terminalText(status).replace(/\s+/g, " ");
    if (next === this.status) return;
    this.status = next;
    if (this.views) this.scheduleRedraw();
    else this.redraw();
  }

  private takeInput() {
    const input = { text: this.rl.line, cursor: this.rl.cursor };
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    return input;
  }
  private restoreInput(input: { text: string; cursor: number }) {
    this.rl.write(input.text.slice(input.cursor));
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(input.text.slice(0, input.cursor));
    this.redraw();
  }

  write(text: string, view: TranscriptView = "all", urgent = false) {
    if (this.views) {
      const delivery = this.views.append(view, text);
      if (!delivery.visible && !urgent) {
        if (delivery.firstUnread)
          this.print(
            `[${view === "world" ? "World" : "Coding"}] New activity is waiting. F6 switches views; your draft stays here.`,
          );
        else this.scheduleRedraw();
        return;
      }
    }
    this.print(text);
  }

  private print(text: string) {
    const rows = this.tty && !this.closed ? this.rl.getCursorPos().rows : undefined;
    if (rows !== undefined) {
      cursorTo(this.output, 0);
      if (rows) moveCursor(this.output, 0, -rows);
      clearScreenDown(this.output);
    }
    this.output.write(`${terminalText(text)}\n`);
    // Preserve the editor's row accounting and undo/yank buffer during output.
    if (rows) this.output.write("\n".repeat(rows));
    this.redraw();
  }

  ask(text: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !this.tty || signal?.aborted) return Promise.resolve("");
    if (this.pending.length + (this.question ? 1 : 0) >= 32) {
      this.print("Input request declined: this terminal already has 32 pending requests.");
      return Promise.resolve("");
    }
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
          if (!this.views || this.views.focus === "approvals") this.takeInput();
          this.drafts.approvals = emptyDraft();
          this.question = undefined;
          this.nextQuestion();
        } else {
          this.pending = this.pending.filter((entry) => entry !== question);
          this.redraw();
        }
        question.resolve("");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(question);
      if (this.question && this.views) this.scheduleRedraw();
      this.nextQuestion();
    });
  }

  private questionDetails(): string {
    return `[Input request · ${this.pending.length + 1} pending]\n${this.question?.text ?? ""}\nYour answer applies only to this request. F6 or /view world returns to conversation without answering.`;
  }

  private nextQuestion() {
    if (this.question || this.closed) return;
    this.question = this.pending.shift();
    if (this.views) {
      if (this.question) {
        if (this.views.focus === "approvals") {
          this.replaceEditor(emptyDraft());
          this.print(this.questionDetails());
        } else {
          this.print(
            "[Input request waiting] F7 or /view approvals opens its details. Your current composer is unchanged.",
          );
        }
      } else if (this.views.focus === "approvals") {
        // Discard the resolved answer; returning restores the conversation draft.
        this.selectView(this.returnView);
      }
      this.redraw();
      return;
    }
    if (this.question) {
      this.draft ??= this.takeInput();
      this.print(
        `[input] ${this.question.text}\n/world <command> remains available while this answer is pending.`,
      );
    } else if (this.draft) {
      const saved = this.draft;
      this.draft = undefined;
      this.restoreInput(saved);
    }
    this.redraw();
  }

  close() {
    this.rl.close();
  }
}
