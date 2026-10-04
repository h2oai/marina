// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Terminal } from "@earendil-works/pi-tui";
import { isWorldInput, TERMINAL_COMMANDS } from "./code-controls";
import type { CodeEditor, CodeEditorOptions } from "./code-editor";
import type { PanelInput, TerminalPanelState } from "./code-panel-form";
import { terminalText } from "./code-presentation";
import { ReadlineCodeEditor } from "./code-readline";
import { type TerminalView, TerminalViews, type TranscriptView } from "./code-views";
import { WorkspaceCodeEditor } from "./code-workspace";
import type { WorkspaceLayout } from "./code-workspace-panes";

export { isWorldInput, TERMINAL_COMMANDS, TERMINAL_HELP, terminalHelp } from "./code-controls";
export {
  formatCodePerception,
  terminalText,
  verificationReadinessLabel,
} from "./code-presentation";

export interface CodeTerminalOptions {
  line: (text: string) => void;
  interrupt: () => void;
  close: () => void;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Focus views are interactive presentation only; redirected output stays continuous. */
  views?: boolean;
  /** Opt-in full workspace. Never used for redirected or one-shot output. */
  tui?: boolean;
  location?: string;
  connected?: boolean;
  /** Terminal device injection for renderer tests; no world/session authority. */
  screen?: Terminal;
  panelInput?: (input: PanelInput) => void;
  viewChanged?: (view: TerminalView) => void;
}

/** One routing/approval controller for both renderers. A view never owns a world action. */
export class CodeTerminal {
  private readonly editor: CodeEditor;
  private closed = false;
  private target = "marina";
  private status = "ready";
  private readonly tty: boolean;
  private readonly workspace: boolean;
  private readonly views?: TerminalViews;
  private returnView: Exclude<TerminalView, "approvals"> = "coding";
  private pending: { text: string; resolve: (answer: string) => void }[] = [];
  private question?: { text: string; resolve: (answer: string) => void };
  private multiline: Record<TerminalView, string[]> = {
    coding: [],
    world: [],
    approvals: [],
    panel: [],
  };
  private redrawTimer?: ReturnType<typeof setTimeout>;
  private layout: WorkspaceLayout = "auto";

  constructor(private options: CodeTerminalOptions) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    this.tty = !!input.isTTY && !!output.isTTY;
    if (options.views && this.tty) this.views = new TerminalViews();
    this.workspace =
      !!options.tui &&
      !!this.views &&
      (!!options.screen ||
        (input === process.stdin && output === process.stderr && !!process.stdout.isTTY));
    const editorOptions: CodeEditorOptions = {
      input,
      output,
      connected: options.connected,
      panelInput: options.panelInput,
      line: (text) => this.line(text),
      interrupt: options.interrupt,
      navigate: (view) => {
        this.selectView(view);
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.redrawTimer);
        this.question?.resolve("");
        for (const question of this.pending) question.resolve("");
        this.question = undefined;
        this.pending = [];
        options.close();
      },
    };
    this.editor = this.workspace
      ? new WorkspaceCodeEditor(editorOptions, options.screen)
      : new ReadlineCodeEditor(editorOptions);
    this.redraw();
  }

  private panelContent =
    "Use /panel desk to open your coding session, or /panel list to find a published panel.";
  private panelState?: TerminalPanelState;
  setPanelState(state?: TerminalPanelState) {
    this.panelState = state;
    this.redraw();
  }
  setPanelContent(text: string, focus = false) {
    this.panelContent = terminalText(text);
    if (focus) this.selectView("panel");
    if (this.workspace) this.redraw();
    else if (focus || this.views?.focus === "panel") this.print(this.panelContent);
  }

  private line(line: string) {
    if (/^\/layout(?:\s|$)/.test(line.trimStart())) {
      const name = line.trim().slice(7).trim();
      if (!this.workspace)
        this.print("Layout controls require marina --tui. Your session is unchanged.");
      else if (name === "auto" || name === "focus" || name === "split" || name === "") {
        this.layout =
          name === ""
            ? ({ auto: "focus", focus: "split", split: "auto" } as const)[this.layout]
            : name;
        this.print(
          `Layout: ${this.layout}. Split requires 80 columns; auto splits at 110. F2 changes layout.`,
        );
      } else this.print("Use /layout auto | focus | split. F2 cycles layouts.");
      return;
    }
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
      const verb = line.trim().split(/\s/, 1)[0];
      if (this.views && TERMINAL_COMMANDS.includes(verb ?? "")) {
        this.options.line(line.trim());
        this.redraw();
        return;
      }
      const current = this.question;
      this.question = undefined;
      this.editor.reset("approvals");
      current.resolve(line);
      this.nextQuestion();
      return;
    }
    if (this.views?.focus === "panel") {
      this.options.line(line.trim().startsWith("/") ? line.trim() : `/panel ${line.trim()}`);
      return;
    }
    const view = this.views?.focus === "world" ? "world" : "coding";
    if (line.endsWith("\\")) {
      this.multiline[view].push(line.slice(0, -1));
      this.redraw();
      return;
    }
    const text = [...this.multiline[view], line].join("\n").trim();
    this.multiline[view] = [];
    if (text) {
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
    if (name === "older" || name === "newer" || name === "latest") {
      const page = name === "latest" ? this.views.latest() : this.views.page(name);
      if (this.workspace) {
        this.redraw();
        if (name === "latest" && (this.views.focus === "coding" || this.views.focus === "world"))
          this.editor.follow?.();
      } else this.print(page);
      return true;
    }
    if (name !== "coding" && name !== "world" && name !== "approvals" && name !== "panel") {
      this.print(
        "Views: /view coding | /view world | /view approvals | /view panel | /view older | /view newer | /view latest. F6 switches conversations; F7 opens requests; F8 opens the panel.",
      );
      return false;
    }
    if (name === "approvals" && !this.question) {
      this.print("No pending input requests. Your conversation and draft remain selected.");
      return false;
    }
    this.views.select(name);
    if (name !== "approvals") this.returnView = name;
    this.editor.focus(name);
    this.options.viewChanged?.(name);
    if (this.workspace) this.redraw();
    else
      this.print(
        name === "approvals"
          ? this.questionDetails()
          : name === "panel"
            ? this.panelContent
            : this.views.snapshot(name),
      );
    return true;
  }

  private scheduleRedraw() {
    if (this.redrawTimer || this.closed) return;
    this.redrawTimer = setTimeout(() => this.redraw(), 32);
    this.redrawTimer.unref();
  }

  private redraw() {
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    if (this.closed) return;
    const focus = this.views?.focus ?? (this.question ? "approvals" : "coding");
    const questions = this.pending.length + (this.question ? 1 : 0);
    this.editor.update({
      focus,
      target: this.target,
      location: this.options.location
        ? terminalText(this.options.location).replace(/\s+/g, " ")
        : undefined,
      status: this.status,
      badge: this.views?.badge(questions),
      navigation: this.views?.navigation(questions),
      layout: this.layout,
      conversations: this.workspace
        ? {
            coding: this.views!.snapshot("coding", true),
            world: this.views!.snapshot("world", true),
          }
        : undefined,
      transcript: this.workspace
        ? focus === "approvals"
          ? this.questionDetails()
          : focus === "panel"
            ? this.panelContent
            : this.views!.snapshot(focus, true)
        : undefined,
      answer: !!this.question && focus === "approvals",
      multiline: this.multiline[focus].length > 0,
      panel: this.panelState,
    });
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

  write(text: string, view: TranscriptView = "all", urgent = false) {
    if (this.views) {
      const delivery = this.views.append(view, text);
      if (this.workspace) {
        if ((urgent && !delivery.visible) || (this.views.focus === "approvals" && view === "all"))
          this.editor.print(text);
        this.scheduleRedraw();
        return;
      }
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
    this.editor.print(terminalText(text));
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
          this.editor.reset("approvals");
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
          this.editor.reset("approvals");
          if (!this.workspace) this.print(this.questionDetails());
        } else
          this.print(
            "[Input request waiting] F7 or /view approvals opens its details. Your current composer is unchanged.",
          );
      } else if (this.views.focus === "approvals") this.selectView(this.returnView);
    } else if (this.question) {
      this.editor.focus("approvals");
      this.print(
        `[input] ${this.question.text}\n/world <command> remains available while this answer is pending.`,
      );
    } else this.editor.focus("coding");
    this.redraw();
  }

  close() {
    this.editor.close();
  }
}
