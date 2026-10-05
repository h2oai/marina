// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { PanelInput, TerminalPanelState } from "./code-panel-form";
import type { TerminalView } from "./code-views";
import type { WorkspaceLayout } from "./code-workspace-panes";

/** Presentation boundary shared by scrollback and fullscreen; actions stay in CodeTerminal. */
export interface CodeEditorState {
  focus: TerminalView;
  target: string;
  location?: string;
  status: string;
  badge?: string;
  navigation?: string;
  transcript?: string;
  conversations?: { coding: string; world: string };
  layout?: WorkspaceLayout;
  answer: boolean;
  multiline: boolean;
  panel?: TerminalPanelState;
}

export interface CodeEditorOptions {
  connected?: boolean;
  completions?: () => readonly AutocompleteItem[];
  line(text: string): void;
  interrupt(): void;
  close(): void;
  navigate(view: string): void;
  panelInput?(input: PanelInput): void;
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface CodeEditor {
  update(state: CodeEditorState): void;
  focus(view: TerminalView): void;
  reset(view: TerminalView): void;
  follow?(): void;
  print(text: string): void;
  close(): void;
}
