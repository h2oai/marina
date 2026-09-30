// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  clearScreenDown,
  createInterface,
  cursorTo,
  type Interface,
  moveCursor,
} from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { formatPerception } from "../src/net/formatter";
import type { Perception } from "../src/sdk/client";

/** Native tool output is data, never terminal instructions (OSC links/clipboard, cursor escapes). */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal control bytes.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

/** Labels reflect the server's declared readiness, never command exit prose. */
export function verificationReadinessLabel(value: unknown): string | undefined {
  switch (value) {
    case "required":
      return "verification required";
    case "running":
      return "checks running";
    case "ready":
      return "ready for review";
    case "needs-attention":
      return "checks need attention";
    default:
      return undefined;
  }
}

/** Transcript categories add orientation without interpreting prose as authorization or success. */
export function formatCodePerception(p: Perception): string {
  const text = formatPerception(p, "plaintext");
  if (!text) return "";
  const code = p.data?.code as
    | {
        event?: string;
        phase?: string;
        status?: string;
        verificationReadiness?: string;
        metadata?: { verificationReadiness?: string; reason?: string };
      }
    | undefined;
  const readiness = verificationReadinessLabel(
    code?.metadata?.verificationReadiness ?? code?.verificationReadiness,
  );
  let label: string | undefined;
  if (p.kind === "error" || p.kind === "auth_error") label = "error";
  else if (p.data?.execApproval) label = "approval requested";
  else if (code?.event === "verification_required") label = readiness ?? "verification required";
  else if (code?.event === "verification_started") label = readiness ?? "checks · running";
  else if (code?.event === "verification_finished")
    label = `checks · receipt${readiness ? ` · ${readiness}` : ""}`;
  else if (code?.event === "verification_ran")
    label = `checks · result${readiness ? ` · ${readiness}` : ""}`;
  else if (code?.event === "session_status" && readiness) label = readiness;
  else if (code?.event === "task_run_review") label = "review";
  else if (code?.event === "code_lifecycle") {
    label =
      code.status === "submitted"
        ? "task · submitted for review"
        : code.metadata?.reason === "blocked"
          ? "task · blocked"
          : "task";
  } else if (
    !code &&
    !p.command_request_id &&
    (p.kind === "movement" ||
      ["tell", "say", "shout", "broadcast", "connect", "disconnect"].includes(p.tag ?? ""))
  )
    label = "world";
  return terminalText(label ? `[${label}] ${text}` : text);
}

/** Explicit world input is independent of a coding task or pending approval answer. */
export function isWorldInput(text: string): boolean {
  return /^\/world(?:\s|$)/.test(text.trimStart());
}

export const TERMINAL_COMMANDS = [
  "/help",
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
Tab completes terminal commands. Ctrl+C interrupts active work; again exits.
Use /world during a launch or approval prompt to keep participating; the approval stays pending.
Native agents retain their own tools and permission rules. Additional worktrees start at committed HEAD.`;

/** One input owner for tasks and queued approvals; output redraws unfinished input. */
export class CodeTerminal {
  private rl: Interface;
  private readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  private readonly output: NodeJS.WritableStream & { isTTY?: boolean };
  private closed = false;
  private target = "marina";
  private status = "ready";
  private readonly tty: boolean;
  private pending: { text: string; resolve: (answer: string) => void }[] = [];
  private question?: { text: string; resolve: (answer: string) => void };
  private draft?: { text: string; cursor: number };
  private multiline: string[] = [];
  private readonly resize = () => this.redraw();
  constructor(options: {
    line: (text: string) => void;
    interrupt: () => void;
    close: () => void;
    input?: NodeJS.ReadableStream & { isTTY?: boolean };
    output?: NodeJS.WritableStream & { isTTY?: boolean };
  }) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.tty = !!this.input.isTTY && !!this.output.isTTY;
    this.rl = createInterface({
      input: this.input,
      output: this.output,
      completer: (line: string) => [
        TERMINAL_COMMANDS.filter((command) => command.startsWith(line)),
        line,
      ],
      historySize: 200,
      terminal: this.tty,
    });
    this.rl.on("line", (line: string) => {
      if (isWorldInput(line)) {
        options.line(line.trim());
        this.redraw();
        return;
      }
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
      this.output.off("resize", this.resize);
      this.question?.resolve("");
      for (const question of this.pending) question.resolve("");
      this.question = undefined;
      this.pending = [];
      options.close();
    });
    this.output.on("resize", this.resize);
    this.redraw();
  }
  private redraw() {
    if (this.closed || !this.tty) return;
    // Keep long session IDs out of the editing area. A conservative width leaves
    // room for wide glyphs on narrow terminals; full identity stays in /status.
    const columns = (this.output as { columns?: number }).columns ?? 80;
    const limit = Math.max(2, Math.floor((columns - 8) / 2));
    const compact = (text: string, length: number) => {
      const chars = [...text];
      return chars.length > length ? `${chars.slice(0, Math.max(0, length - 1)).join("")}…` : text;
    };
    const targetLimit = Math.min(18, Math.max(1, Math.floor(limit / 2) - 1));
    const target = compact(this.target, targetLimit);
    const label = `${target}·${compact(this.status, Math.max(1, limit - [...target].length - 1))}`;
    this.rl.setPrompt(this.question ? "answer › " : this.multiline.length ? "… " : `${label} › `);
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
    this.redraw();
  }
  private takeInput() {
    const input = { text: this.rl.line, cursor: this.rl.cursor };
    // Let readline clear every wrapped row using its own cursor accounting.
    // Clearing only the physical current line duplicates a long unfinished draft.
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    return input;
  }
  private restoreInput(input: { text: string; cursor: number }) {
    // Restore suffix first, then insert the prefix at the front: public readline
    // editing operations preserve the exact cursor without changing readonly state.
    this.rl.write(input.text.slice(input.cursor));
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(input.text.slice(0, input.cursor));
    this.redraw();
  }
  write(text: string) {
    const rows = this.tty && !this.closed ? this.rl.getCursorPos().rows : undefined;
    if (rows !== undefined) {
      cursorTo(this.output, 0);
      if (rows) moveCursor(this.output, 0, -rows);
      clearScreenDown(this.output);
    }
    this.output.write(`${terminalText(text)}\n`);
    // readline retains its cursor-row count. Allocate those rows before it
    // redraws, even at the bottom of the screen. Leave the draft and editing
    // history untouched: ambient output must not become a user's undo/yank.
    if (rows) this.output.write("\n".repeat(rows));
    this.redraw();
  }
  ask(text: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !this.input.isTTY || !this.output.isTTY || signal?.aborted)
      return Promise.resolve("");
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
          this.takeInput();
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
      this.draft ??= this.takeInput();
      this.write(
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
