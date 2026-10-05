// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type Component,
  Editor,
  type EditorTheme,
  matchesKey,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { inputGuidance, terminalCompletionFor } from "./code-completion";
import type { CodeEditor, CodeEditorOptions, CodeEditorState } from "./code-editor";
import { CodePanelForm } from "./code-panel-form";
import { terminalText } from "./code-presentation";
import type { TerminalView } from "./code-views";
import { WorkspacePanes } from "./code-workspace-panes";

const plain = (text: string) => text;
const color = (code: number) => (text: string) =>
  process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
const accent = color(36);
const dim = color(2);
const theme: EditorTheme = {
  borderColor: accent,
  selectList: {
    selectedPrefix: accent,
    selectedText: color(1),
    description: dim,
    scrollInfo: dim,
    noMatch: plain,
  },
};

/** Enter in discovery inserts a command, never executes the highlighted command. */
class DraftEditor extends Editor {
  override handleInput(data: string) {
    super.handleInput(this.isShowingAutocomplete() && matchesKey(data, "enter") ? "\t" : data);
  }
}

/** Width handling, paste, cursor, history and viewport layout belong to the renderer library. */
export class WorkspaceCodeEditor implements CodeEditor {
  private readonly tui: TuiAltScreen;
  private readonly editors: Record<TerminalView, DraftEditor>;
  private readonly panelForm: CodePanelForm;
  private readonly panes = new WorkspacePanes();
  private focusView: TerminalView = "coding";
  private state?: CodeEditorState;
  private notice = "";
  private closed = false;
  private readonly end = () => this.close();
  private readonly exit = () => this.stop();

  constructor(
    private options: CodeEditorOptions,
    screen?: Terminal,
  ) {
    this.tui = new TuiAltScreen(screen ?? new ProcessTerminal(), true, undefined, {
      mouse: false,
      copyOnSelect: false,
    });
    this.editors = {
      coding: this.makeEditor("coding"),
      world: this.makeEditor("world"),
      approvals: this.makeEditor("approvals"),
      panel: this.makeEditor("panel"),
    };
    this.panelForm = new CodePanelForm(
      () => new Editor(this.tui, theme),
      (input) => {
        options.panelInput?.(input);
        this.tui.requestRender();
      },
    );
    const line = (value: (width: number) => string): Component => ({
      invalidate() {},
      render: (width) => [truncateToWidth(value(width), Math.max(1, width), "…")],
    });
    const input: Component = {
      invalidate: () => this.inputComponent().invalidate(),
      render: (width) => this.inputComponent().render(width),
    };
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: line(() =>
            accent(`MARINA  ·  ${this.state?.location ?? this.state?.target ?? "marina"}`),
          ),
          basis: 1,
          visible: ({ height }) => (height ?? 0) >= 12,
        },
        {
          component: line(
            (width) =>
              (width < 44 ? this.state?.badge : this.state?.navigation) ??
              "Coding · World · Requests",
          ),
          basis: 1,
        },
        { component: this.panes.component, basis: 0, grow: 1, minSize: 1 },
        {
          component: line(() => this.notice),
          basis: 1,
          visible: ({ height }) => !!this.notice && (height ?? 0) >= 8,
        },
        {
          component: line(() =>
            this.focusView === "approvals"
              ? "Answering only the displayed request"
              : this.focusView === "world"
                ? "World command · messages and events stay live"
                : this.focusView === "panel"
                  ? "Published panel · actions require explicit confirmation"
                  : `Coding · ${this.state?.status ?? "ready"} · ${this.state?.target ?? "marina"}`,
          ),
          basis: 1,
        },
        {
          component: line(() =>
            this.focusView === "approvals"
              ? "Enter sends this answer · F6 leaves it pending"
              : this.focusView === "panel" && this.state?.panel
                ? "Tab / Shift+Tab select · Enter edit/review · Esc cancels review"
                : inputGuidance(
                    this.editors[this.focusView].getText(),
                    this.focusView === "world",
                    this.options.connected,
                  ),
          ),
          basis: 1,
          visible: ({ height }) => (height ?? 0) >= 14,
        },
        { component: input, basis: "auto", minSize: 3, maxSize: 10, shrink: 1 },
        {
          component: line(
            () => "F1 help · F2 layout · F6 Coding/World · F7 requests · F8 panel · Ctrl+D exit",
          ),
          basis: 1,
          visible: ({ height }) => (height ?? 0) >= 10,
        },
      ]),
    );
    this.tui.setFocus(this.editors.coding);
    this.tui.addInputListener((data) => {
      // A bracketed paste is one event: never interpret its contents as shortcuts.
      if (data.startsWith("\x1b[200~")) return;
      if (matchesKey(data, "ctrl+c")) {
        options.interrupt();
        return { consume: true };
      }
      if (
        matchesKey(data, "ctrl+d") &&
        !(this.focusView === "panel" && this.state?.panel) &&
        !this.editors[this.focusView].getText()
      ) {
        this.close();
        return { consume: true };
      }
      if (matchesKey(data, "f1")) {
        options.line("/help");
        return { consume: true };
      }
      if (matchesKey(data, "f2")) {
        options.line("/layout");
        return { consume: true };
      }
      const view = matchesKey(data, "f6")
        ? this.focusView === "world"
          ? "coding"
          : "world"
        : matchesKey(data, "f7")
          ? "approvals"
          : matchesKey(data, "f8")
            ? "panel"
            : matchesKey(data, "alt+up")
              ? "older"
              : matchesKey(data, "alt+down")
                ? "newer"
                : undefined;
      if (view) {
        options.navigate(view);
        return { consume: true };
      }
      return undefined;
    });
    options.input.on("end", this.end);
    process.on("exit", this.exit);
    this.tui.start();
  }

  private makeEditor(view: TerminalView) {
    const editor = new DraftEditor(this.tui, theme, { autocompleteMaxVisible: 5 });
    if (view !== "approvals")
      editor.setAutocompleteProvider(
        terminalCompletionFor(this.options.connected, this.options.completions, view === "world"),
      );
    editor.onChange = () => {
      this.notice = "";
      this.tui.requestRender();
    };
    editor.onSubmit = (text) => {
      if (view !== "approvals" && Buffer.byteLength(text) <= 640) editor.addToHistory(text);
      this.notice = "";
      this.options.line(text);
    };
    return editor;
  }

  update(state: CodeEditorState) {
    if (this.closed) return;
    this.state = state;
    if (state.panel) this.panelForm.update(state.panel);
    this.tui.setFocus(this.inputComponent());
    this.panes.update(state);
    this.tui.requestRender();
  }

  focus(view: TerminalView) {
    if (view === this.focusView || this.closed) return;
    this.focusView = view;
    this.notice = "";
    this.tui.setFocus(this.inputComponent());
    this.tui.requestRender();
  }

  reset(view: TerminalView) {
    // Replacing the editor also discards cancelled approval undo/paste/history state.
    this.editors[view] = this.makeEditor(view);
    if (view === this.focusView) this.tui.setFocus(this.editors[view]);
    this.tui.requestRender();
  }

  follow() {
    this.panes.follow();
    this.tui.requestRender();
  }
  private inputComponent() {
    return this.focusView === "panel" && this.state?.panel
      ? this.panelForm
      : this.editors[this.focusView];
  }

  print(text: string) {
    if (this.closed) return;
    this.notice = terminalText(text).replace(/\s+/g, " ").slice(0, 512);
    this.tui.requestRender();
  }

  private stop() {
    if (this.closed) return;
    this.closed = true;
    this.options.input.off("end", this.end);
    process.off("exit", this.exit);
    // Restore the shell without copying an unsent draft or approval answer into scrollback.
    this.tui.stop({ preserveScreen: true });
  }

  close() {
    if (!this.closed) {
      this.stop();
      this.options.close();
    }
  }
}
