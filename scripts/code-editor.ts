// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TerminalView } from "./code-views";

/** Presentation boundary shared by scrollback and fullscreen; actions stay in CodeTerminal. */
export interface CodeEditorState {
  focus: TerminalView;
  target: string;
  location?: string;
  status: string;
  badge?: string;
  navigation?: string;
  transcript?: string;
  answer: boolean;
  multiline: boolean;
}

export interface CodeEditorOptions {
  connected?: boolean;
  line(text: string): void;
  interrupt(): void;
  close(): void;
  navigate(view: string): void;
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface CodeEditor {
  update(state: CodeEditorState): void;
  focus(view: TerminalView): void;
  reset(view: TerminalView): void;
  print(text: string): void;
  close(): void;
}
