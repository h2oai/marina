// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Component, type Editor, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalText } from "./code-presentation";

export type PanelInput =
  | { type: "view"; id: string }
  | { type: "field"; id: string; value: string | boolean }
  | { type: "action"; id: string }
  | { type: "sender"; id: string }
  | { type: "confirm" }
  | { type: "cancel" };
export interface TerminalPanelState {
  key: string;
  views?: Array<{ id: string; label: string }>;
  view?: string;
  fields: Array<{
    id: string;
    label: string;
    kind: "text" | "checkbox";
    value: string | boolean;
    disabled: boolean;
  }>;
  actions: Array<{ id: string; label: string; disabled: boolean }>;
  senders: Array<{ id: string; label: string }>;
  sender: string;
  review?: { label: string; canConfirm: boolean };
}
type Control = {
  id: string;
  label: string;
  kind: "field" | "action" | "sender" | "confirm" | "cancel";
};

/** Presentation only. Tab navigates the same published fields/actions; Enter on an action
 * opens a review. The review initially focuses Cancel, never the submit button. */
export class CodePanelForm implements Component {
  focused = false;
  private state?: TerminalPanelState;
  private controls: Control[] = [];
  private selected = 0;
  private editors = new Map<string, Editor>();
  constructor(
    private makeEditor: () => Editor,
    private input: (input: PanelInput) => void,
  ) {}
  update(state: TerminalPanelState) {
    const changed = this.state?.key !== state.key;
    const reviewOpened = !this.state?.review && !!state.review;
    const selectedId = this.controls[this.selected]?.id;
    if (changed) {
      this.editors.clear();
      this.selected = 0;
    }
    this.state = state;
    this.controls = state.review
      ? [
          { id: "cancel", kind: "cancel", label: "Cancel review" },
          ...(state.review.canConfirm
            ? [{ id: "confirm", kind: "confirm" as const, label: "Confirm action" }]
            : []),
          ...(state.senders.length
            ? [{ id: "sender", kind: "sender" as const, label: "Sending participant" }]
            : []),
        ]
      : [
          ...state.fields
            .filter((f) => !f.disabled)
            .map((f) => ({ id: f.id, kind: "field" as const, label: f.label })),
          ...state.actions
            .filter((a) => !a.disabled)
            .map((a) => ({ id: a.id, kind: "action" as const, label: a.label })),
        ];
    if (reviewOpened || changed) this.selected = 0;
    else
      this.selected = Math.max(
        0,
        this.controls.findIndex((c) => c.id === selectedId),
      );
    for (const field of state.fields)
      if (field.kind === "text") {
        let editor = this.editors.get(field.id);
        if (!editor) {
          editor = this.makeEditor();
          editor.onChange = (value) => this.input({ type: "field", id: field.id, value });
          editor.onSubmit = () => this.move(1);
          this.editors.set(field.id, editor);
        }
        const text = terminalText(String(field.value));
        if (editor.getText() !== text) editor.setText(text);
      }
    for (const id of this.editors.keys())
      if (!state.fields.some((f) => f.id === id && f.kind === "text")) this.editors.delete(id);
  }
  private move(delta: number) {
    this.selected =
      (this.selected + delta + this.controls.length) % Math.max(1, this.controls.length);
  }
  handleInput(data: string) {
    if (!this.state) return;
    const pasted = data.startsWith("\x1b[200~");
    if (!pasted && (matchesKey(data, "alt+left") || matchesKey(data, "alt+right"))) {
      const views = this.state.views ?? [];
      const index = views.findIndex((v) => v.id === this.state!.view);
      const delta = matchesKey(data, "alt+left") ? -1 : 1;
      const next = views[(index + delta + views.length) % views.length];
      if (next) this.input({ type: "view", id: next.id });
      return;
    }
    if (!pasted && matchesKey(data, "tab")) {
      this.move(1);
      return;
    }
    if (!pasted && matchesKey(data, "shift+tab")) {
      this.move(-1);
      return;
    }
    if (!pasted && matchesKey(data, "escape") && this.state.review) {
      this.input({ type: "cancel" });
      return;
    }
    const control = this.controls[this.selected];
    if (!control) return;
    if (control.kind === "field") {
      const field = this.state.fields.find((f) => f.id === control.id)!;
      if (field.kind === "text") {
        if (!pasted && matchesKey(data, "enter")) this.move(1);
        else this.editors.get(control.id)?.handleInput(data);
      } else if (!pasted && (data === " " || matchesKey(data, "enter")))
        this.input({ type: "field", id: control.id, value: !field.value });
    } else if (
      control.kind === "sender" &&
      !pasted &&
      (["up", "down", "left", "right", "enter"] as const).some((k) => matchesKey(data, k))
    ) {
      const delta = matchesKey(data, "up") || matchesKey(data, "left") ? -1 : 1;
      const current = this.state.senders.findIndex((s) => s.id === this.state!.sender);
      const next =
        this.state.senders[
          (current + delta + this.state.senders.length) % this.state.senders.length
        ];
      if (next) this.input({ type: "sender", id: next.id });
    } else if (!pasted && matchesKey(data, "enter")) {
      if (control.kind === "action") this.input({ type: "action", id: control.id });
      else if (control.kind === "confirm" || control.kind === "cancel")
        this.input({ type: control.kind });
    }
  }
  invalidate() {
    for (const editor of this.editors.values()) editor.invalidate();
  }
  render(width: number): string[] {
    const selected = this.controls[this.selected];
    const start = Math.max(0, Math.min(this.selected - 1, this.controls.length - 3));
    const lines = this.controls.slice(start, start + 3).map((control) => {
      const field = this.state?.fields.find((f) => f.id === control.id);
      const value =
        control.kind === "sender"
          ? (this.state?.senders.find((s) => s.id === this.state?.sender)?.label ??
            "Choose with ←/→")
          : field
            ? field.kind === "checkbox"
              ? field.value
                ? "[x]"
                : "[ ]"
              : String(field.value).replaceAll("\n", " ↵ ")
            : "";
      return truncateToWidth(
        terminalText(
          `${control.id === selected?.id ? "›" : " "} ${control.label}${value ? `: ${value}` : ""}`,
        ),
        Math.max(1, width),
        "…",
      );
    });
    const editor = selected?.kind === "field" ? this.editors.get(selected.id) : undefined;
    for (const e of this.editors.values()) e.focused = this.focused && e === editor;
    if (editor) lines.push(...editor.render(width));
    if ((this.state?.views?.length ?? 0) > 1)
      lines.unshift(
        truncateToWidth(
          terminalText(
            `Alt+←/→ · ${this.state!.views!.map((v) => `${v.id === this.state!.view ? "● " : ""}${v.label}`).join(" | ")}`,
          ),
          Math.max(1, width),
          "…",
        ),
      );
    if (!lines.length) lines.push("No available controls. F6 returns to conversations.");
    return lines;
  }
}
