// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { getErrorMessage } from "../src/engine/errors";
import { codingDesk } from "../src/sdk/coding-desk";
import type { MarinaPanelClient } from "../src/sdk/panel-client";
import type { PanelInput, TerminalPanelState } from "./code-panel-form";
import { CodePanelView } from "./code-panel-view";

type View = {
  id: string;
  label: string;
  controller: CodePanelView;
  text: string;
  state?: TerminalPanelState;
};

/** Local view collection. Each view owns its draft/review; only the selected one polls.
 * Closing or switching cannot join, select, stop or retarget a producer.
 */
export class CodePanels {
  private views = new Map<string, View>();
  private selected?: string;
  private active = true;
  private closed = false;
  constructor(
    private client: MarinaPanelClient,
    private show: (text: string, focus: boolean) => void,
    private memory: (id: string, spaceId: string, signal?: AbortSignal) => Promise<unknown>,
    private options: {
      present?: (state?: TerminalPanelState) => void;
      watch?: boolean;
      ask?: (sessionId: string, request: string) => Promise<string>;
    } = {},
  ) {}
  async command(argument: string): Promise<void> {
    if (this.closed) return;
    try {
      const [verb, ...args] = argument.trim().split(/\s+/);
      if (verb === "publish") {
        if (args.length !== 2) throw new Error("Usage: /panel publish <canvas> <coding-session>");
        const node = await this.client.publish(args[0]!, codingDesk({ sessionId: args[1]! }));
        if (!this.closed) await this.command(`open ${node.canvas_id} ${node.id}`);
        return;
      }
      if (verb === "open" || verb === "desk") {
        if (args.length !== (verb === "open" ? 2 : 1))
          throw new Error(
            verb === "open"
              ? "Usage: /panel open <canvas> <node>"
              : "Usage: /panel desk <coding-session>",
          );
        const id = JSON.stringify([verb, ...args]);
        if (this.views.has(id)) {
          this.select(id);
          return;
        }
        if (this.views.size >= 4)
          throw new Error("Four panel views are open. Close one before opening another.");
        const view: View = {
          id,
          label: `${verb === "desk" ? "Coding desk" : "Panel"} ${args.at(-1)}`,
          text: "Loading panel…",
          controller: undefined!,
        };
        view.controller = new CodePanelView(
          this.client,
          (text, focus) => {
            view.text = text;
            if (!this.closed && this.active && this.selected === id && this.views.get(id) === view)
              this.show(text, focus);
          },
          this.memory,
          {
            ...this.options,
            present: (state) => {
              view.state = state;
              if (this.selected === id && this.views.get(id) === view) this.present();
            },
          },
        );
        this.views.set(id, view);
        this.select(id);
        await view.controller.command(argument);
        return;
      }
      if (verb === "views") {
        this.show(
          [...this.views.values()]
            .map((v, i) => `${i + 1}${v.id === this.selected ? " *" : ""} · ${v.label}`)
            .join("\n") || "No open panel views. /panel desk opens your coding session.",
          true,
        );
        return;
      }
      if (verb === "use") {
        const view = [...this.views.values()][Number(args[0]) - 1];
        if (!view) throw new Error("Use /panel views to choose an open view number.");
        this.select(view.id);
        return;
      }
      if (verb === "close") {
        if (this.selected) {
          this.views.get(this.selected)?.controller.dispose();
          this.views.delete(this.selected);
        }
        this.selected = undefined;
        const next = this.views.keys().next().value;
        if (next) this.select(next);
        else {
          this.present();
          this.show("Panel view closed. Producers and world activity continue.", true);
        }
        return;
      }
      if (verb === "resources") {
        const catalog = await this.client.resources();
        if (!this.closed)
          this.show(
            JSON.stringify(
              catalog.resources.filter((r) => r.id.includes(args[0] ?? "")),
              null,
              2,
            ),
            true,
          );
        return;
      }
      if (verb === "list") {
        const values = args[0]
          ? (await this.client.list(args[0])).map(
              (n) => `${n.id} · ${n.data.title ?? "Published panel"}`,
            )
          : (await this.client.canvases()).map((c) => `${c.id} · ${c.name}`);
        if (!this.closed) this.show(values.join("\n") || "No visible publications.", true);
        return;
      }
      const view = this.selected && this.views.get(this.selected);
      if (view) await view.controller.command(argument);
      else
        this.show(
          "/panel desk [session] · publish <canvas> [session] · open <canvas> <node> · list [canvas] · resources [filter] · views · use <number> · close",
          true,
        );
    } catch (error) {
      if (!this.closed) this.show(getErrorMessage(error), true);
    }
  }
  private select(id: string) {
    if (this.selected !== id) this.views.get(this.selected ?? "")?.controller.setActive(false);
    this.selected = id;
    const view = this.views.get(id)!;
    view.controller.setActive(this.active);
    this.show(view.text, true);
    this.present();
  }
  private present() {
    if (this.closed) return;
    const state = this.views.get(this.selected ?? "")?.state;
    this.options.present?.(
      state
        ? {
            ...state,
            views: [...this.views.values()].map((v) => ({ id: v.id, label: v.label })),
            view: this.selected,
          }
        : undefined,
    );
  }
  input(input: PanelInput) {
    if (this.closed) return;
    if (input.type === "view") {
      if (this.views.has(input.id)) this.select(input.id);
    } else this.views.get(this.selected ?? "")?.controller.input(input);
  }
  setActive(active: boolean) {
    this.active = active;
    this.views.get(this.selected ?? "")?.controller.setActive(active);
  }
  dispose() {
    this.closed = true;
    for (const view of this.views.values()) view.controller.dispose();
    this.views.clear();
    this.options.present?.(undefined);
  }
}
