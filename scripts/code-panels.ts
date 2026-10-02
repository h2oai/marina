// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../src/engine/errors";
import type { CommandCatalogEntry } from "../src/sdk/capabilities";
import { codingDesk } from "../src/sdk/coding-desk";
import { panelOperationLabel, parsePanelOperation } from "../src/sdk/panel-actions";
import type {
  MarinaPanelClient,
  PanelInteractionInput,
  PublishedPanelNode,
} from "../src/sdk/panel-client";
import { validatePanelDocument } from "../src/sdk/panel-document";
import { type PanelChangeEvent, panelSourceAffected } from "../src/sdk/panel-events";
import {
  parsePanelSource,
  resolvePanelBindings,
  resolvePanelSource,
} from "../src/sdk/panel-resources";
import { panelResourceText, panelText } from "../src/sdk/panel-text";
import type { RoutingOverview } from "../src/sdk/routing-types";
import type { PanelInput, TerminalPanelState } from "./code-panel-form";

const HELP =
  "/panel desk <canvas> <session> | list [canvas] | open <canvas> <node> | refresh | field <id> <value> | act <button> [sending-participant] | confirm | close";
/** One local view; no worker/session is joined or stopped by its lifecycle. */
export class CodePanels {
  private target?: { canvasId: string; nodeId: string };
  private node?: PublishedPanelNode;
  private sourceValues: Record<string, unknown> = {};
  private fields: Record<string, string | boolean> = {};
  private pending?: {
    canvasId: string;
    nodeId: string;
    input: PanelInteractionInput;
    retryable: boolean;
    label: string;
    needsSender: boolean;
    attempted?: boolean;
  };
  private active = true;
  private dirty = false;
  private stopWatching?: () => void;
  private senders: Array<{ id: string; label: string }> = [];
  private sending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private reader?: AbortController;
  private requests = Promise.resolve();
  private loading = false;
  private closed = false;
  private latest = `No panel selected. ${HELP}`;
  constructor(
    private client: MarinaPanelClient,
    private show: (text: string, focus: boolean) => void,
    private memory: (id: string, spaceId: string, signal?: AbortSignal) => Promise<unknown>,
    private options: { present?: (state?: TerminalPanelState) => void; watch?: boolean } = {},
  ) {}
  command(argument: string): Promise<void> {
    this.requests = this.requests
      .then(() => this.execute(argument))
      .catch((error) => {
        this.show(getErrorMessage(error), true);
        this.present();
      });
    return this.requests;
  }
  private async execute(argument: string) {
    if (this.closed) return;
    const [verb = "help", ...args] = argument.split(/\s+/);
    if (verb === "desk") {
      if (args.length !== 2) throw new Error("Usage: /panel desk <canvas> <coding-session>");
      const node = await this.client.publish(args[0]!, codingDesk({ sessionId: args[1]! }));
      await this.execute(`open ${node.canvas_id} ${node.id}`);
      return;
    }
    if (verb === "list") {
      const values = args[0]
        ? (await this.client.list(args[0])).map(
            (n) => `${n.id} · ${n.data.title ?? "Published panel"} · ${n.creator_name}`,
          )
        : (await this.client.canvases()).map((c) => `${c.id} · ${c.name}`);
      this.show(values.join("\n") || "No visible publications.", true);
      return;
    }
    if (verb === "close") {
      this.generation++;
      this.reader?.abort();
      clearTimeout(this.timer);
      this.stopWatching?.();
      this.stopWatching = undefined;
      this.target = undefined;
      this.node = undefined;
      this.pending = undefined;
      this.fields = {};
      this.options.present?.(undefined);
      this.show("Panel view closed. Producers and world activity continue.", true);
      return;
    }
    if (verb === "open") {
      if (args.length !== 2) throw new Error("Usage: /panel open <canvas> <node>");
      this.generation++;
      this.reader?.abort();
      this.fields = {};
      this.pending = undefined;
      this.node = undefined;
      this.target = { canvasId: args[0]!, nodeId: args[1]! };
      this.active = true;
      this.watch();
      this.options.present?.(undefined);
      this.show("Loading panel…", true);
      await this.refresh(true);
      return;
    }
    if (verb === "refresh") {
      await this.refresh(true);
      return;
    }
    if (verb === "field") {
      const fieldId = args.shift();
      const parsed = validatePanelDocument(this.node?.data);
      const field = parsed.ok
        ? parsed.document.components.find((c) => c.id === fieldId)
        : undefined;
      if (!field || !["TextField", "DateTimeInput", "CheckBox"].includes(field.component))
        throw new Error("Choose an input field from the current panel.");
      const value = args.join(" ");
      if (field.component === "CheckBox" && value !== "true" && value !== "false")
        throw new Error("Checkbox values are true or false.");
      this.fields[field.id] = field.component === "CheckBox" ? value === "true" : value;
      this.show(`${this.latest}\nLocal draft: ${JSON.stringify(this.fields)}`, true);
      this.present();
      return;
    }
    if (verb === "act") {
      await this.prepareAction(args[0] ?? "", args[1]);
      return;
    }
    if (verb === "confirm") {
      const pending = this.pending;
      if (!pending) throw new Error("Use /panel act to review an action first.");
      if (!this.node || pending.input.revision !== this.node.data.panelRevision)
        throw new Error("Panel changed. Cancel and review the current action.");
      if (pending.needsSender && !pending.input.sourceId)
        throw new Error("Choose a sending participant before confirming.");
      pending.attempted = true;
      this.sending = true;
      this.present();
      if (!pending.retryable) this.pending = undefined;
      let result: Awaited<ReturnType<MarinaPanelClient["interact"]>>;
      try {
        result = await this.client.interact(pending.canvasId, pending.nodeId, pending.input);
      } finally {
        this.sending = false;
        this.present();
      }
      this.pending = undefined;
      this.present();
      this.show(
        `${result.status}${result.receipt ? ` · receipt ${result.receipt.id}` : ""}. ${result.message ?? "Notification saved."}`,
        true,
      );
      return;
    }
    this.show(HELP, true);
  }
  private async prepareAction(componentId: string, sourceId?: string) {
    if (!this.target || !this.node?.data.panelRevision)
      throw new Error("Open a current panel first.");
    const parsed = validatePanelDocument(this.node.data);
    if (!parsed.ok) throw new Error(parsed.error);
    const button = parsed.document.components.find(
      (c) => c.id === componentId && c.component === "Button",
    );
    if (!button || button.disabled) throw new Error("Choose an available button.");
    const operation = parsePanelOperation(button.operation);
    const defaults = Object.fromEntries(
      resolvePanelBindings(parsed.document, this.sourceValues)
        .components.filter((c) => ["TextField", "DateTimeInput", "CheckBox"].includes(c.component))
        .map((c) => [c.id, c.component === "CheckBox" ? (c.checked ?? false) : (c.value ?? "")]),
    );
    const input: PanelInteractionInput = {
      revision: this.node.data.panelRevision,
      componentId: button.id,
      fields: { ...defaults, ...this.fields } as Record<string, string | boolean>,
      requestId: crypto.randomUUID(),
      sourceId,
    };
    if (operation?.kind === "message") {
      const overview = await this.client.request<RoutingOverview>(
        "/api/routing/overview?limit=100",
      );
      this.senders = overview.items
        .filter((item) => item.owned && item.session.state === "active")
        .map((item) => ({ id: item.session.id, label: item.session.label }));
    } else this.senders = [];
    if (operation?.kind === "command") {
      const catalog = await this.client.request<CommandCatalogEntry[]>("/api/command-catalog");
      input.capabilityRevision = catalog.find((c) => c.name === operation.command)?.revision;
    }
    this.pending = {
      ...this.target,
      input,
      retryable: operation?.kind === "message" || operation?.kind === "control",
      needsSender: operation?.kind === "message",
      label: operation ? panelOperationLabel(operation) : "Save notification",
    };
    this.show(
      `${this.pending.label}\nRuns as your connected resident.\n${JSON.stringify({ operation: operation ?? button.action, fields: input.fields, sourceId: input.sourceId }, null, 2)}\n/panel confirm submits this captured action; opening or refreshing does not submit.`,
      true,
    );

    this.present();
  }
  private async refresh(focus = false) {
    if (!this.target || this.closed || !this.active) {
      if (focus) this.show(HELP, true);
      return;
    }
    // Coalesce polling with manual refresh; never overlap expensive source reads.
    if (this.loading) {
      this.dirty = true;
      return;
    }
    this.loading = true;
    clearTimeout(this.timer);
    const generation = this.generation;
    const target = this.target;
    const controller = new AbortController();
    this.reader = controller;
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const node = await this.client.get(target.canvasId, target.nodeId, controller.signal);
      const parsed = validatePanelDocument(node.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const sources: Record<string, unknown> = {};
      const reads = new Map<string, Promise<unknown>>();
      const read = (path: string) => {
        if (!reads.has(path))
          reads.set(path, this.client.request(path, "GET", undefined, controller.signal));
        return reads.get(path)!;
      };
      const memories = new Map<string, Promise<unknown>>();
      const memory = (id: string, space: string) => {
        const key = JSON.stringify([id, space]);
        if (!memories.has(key)) memories.set(key, this.memory(id, space, controller.signal));
        return memories.get(key)!;
      };
      const entries = Object.entries(parsed.document.sources ?? {});
      for (const c of parsed.document.components)
        if (c.component === "Resource") {
          const source = parsePanelSource(c.reference);
          if (source) entries.push([`resource:${c.id}`, source]);
        }
      await Promise.all(
        entries.map(async ([key, source]) => {
          try {
            sources[key] = await resolvePanelSource(source, read, memory);
          } catch {
            sources[key] = "[unavailable or access denied]";
          }
        }),
      );
      if (generation !== this.generation || this.closed) return;
      this.node = node;
      this.sourceValues = sources;
      this.present();
      const resources = Object.entries(sources)
        .filter(([key]) => key.startsWith("resource:"))
        .map(([key, value]) => {
          const source = entries.find(([name]) => name === key)?.[1];
          return `${key}\n${source ? panelResourceText(source, value) : "Unavailable"}`;
        });
      const next = `${node.creator_name} · revision ${node.data.panelRevision ?? "unknown"}\n${panelText(node.data, sources)}\n${resources.join("\n")}\n${HELP}\n${this.pending ? `${this.pending.label}\nCaptured values: ${JSON.stringify(this.pending.input.fields)}\n/panel confirm submits this captured action; refresh does not change its destination or values.` : ""}`;
      if (focus || next !== this.latest) {
        this.latest = next;
        this.show(next, focus);
      }
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.node = undefined;
        this.options.present?.(undefined);
        this.latest = `Panel unavailable: ${getErrorMessage(error)}`;
        this.show(this.latest, focus);
      }
    } finally {
      clearTimeout(deadline);
      this.loading = false;
      if (this.target && !this.closed && this.active) {
        this.timer = setTimeout(
          () => void this.refresh(),
          this.dirty || generation !== this.generation ? 0 : 5000,
        );
        this.dirty = false;
        this.timer.unref();
      }
    }
  }
  input(input: PanelInput): void {
    if (this.closed || this.sending) return;
    if (input.type === "action") {
      this.requests = this.requests
        .then(() => this.prepareAction(input.id))
        .catch((error) => {
          this.show(getErrorMessage(error), true);
          this.present();
        });
    } else if (input.type === "confirm") void this.command("confirm");
    else if (input.type === "cancel") {
      this.pending = undefined;
      this.present();
    } else if (input.type === "sender") {
      if (
        this.pending?.needsSender &&
        !this.pending.attempted &&
        this.senders.some((sender) => sender.id === input.id)
      )
        this.pending.input.sourceId = input.id;
      this.present();
    } else {
      const parsed = validatePanelDocument(this.node?.data);
      const field = parsed.ok
        ? parsed.document.components.find((c) => c.id === input.id)
        : undefined;
      if (
        field &&
        !field.disabled &&
        ["TextField", "DateTimeInput", "CheckBox"].includes(field.component) &&
        (field.component === "CheckBox"
          ? typeof input.value === "boolean"
          : typeof input.value === "string" && input.value.length <= 16384)
      ) {
        this.fields[input.id] = input.value;
        this.present();
      }
    }
  }
  private present() {
    const parsed = validatePanelDocument(this.node?.data);
    if (!parsed.ok || !this.target) {
      this.options.present?.(undefined);
      return;
    }
    const components = resolvePanelBindings(parsed.document, this.sourceValues).components;
    this.options.present?.({
      key: `${this.target.canvasId}/${this.target.nodeId}`,
      fields: components
        .filter((c) => ["TextField", "DateTimeInput", "CheckBox"].includes(c.component))
        .map((c) => ({
          id: c.id,
          label: String(c.label ?? c.id),
          kind: c.component === "CheckBox" ? "checkbox" : "text",
          value:
            this.fields[c.id] ??
            (c.component === "CheckBox" ? c.checked === true : String(c.value ?? "")),
          disabled: c.disabled === true,
        })),
      actions: components
        .filter((c) => c.component === "Button")
        .map((c) => ({ id: c.id, label: String(c.label ?? c.id), disabled: c.disabled === true })),
      senders: this.pending?.attempted ? [] : this.senders,
      sender: this.pending?.input.sourceId ?? "",
      ...(this.pending
        ? {
            review: {
              label: this.pending.label,
              canConfirm:
                !this.sending &&
                this.pending.input.revision === this.node?.data.panelRevision &&
                (!this.pending.needsSender || !!this.pending.input.sourceId),
            },
          }
        : {}),
    });
  }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.generation++;
    this.dirty = false;
    if (!active) {
      clearTimeout(this.timer);
      this.reader?.abort();
      this.stopWatching?.();
      this.stopWatching = undefined;
    } else if (this.target) {
      this.watch();
      this.invalidate();
    }
  }
  private invalidate(event?: PanelChangeEvent) {
    if (!this.target || !this.active || this.closed) return;
    const parsed = validatePanelDocument(this.node?.data);
    if (event && parsed.ok) {
      const sources = [
        ...Object.values(parsed.document.sources ?? {}),
        ...parsed.document.components.flatMap((c) =>
          c.component === "Resource"
            ? [parsePanelSource(c.reference)].filter((s) => s !== null)
            : [],
        ),
      ];
      if (
        event.canvasId !== this.target.canvasId &&
        !sources.some((s) => panelSourceAffected(s, event))
      )
        return;
    }
    if (this.loading) {
      this.dirty = true;
      return;
    }
    if (this.dirty) return;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.dirty = false;
      void this.refresh();
    }, 100);
    this.timer.unref();
  }
  private watch() {
    this.stopWatching?.();
    this.stopWatching =
      this.options.watch === false
        ? undefined
        : this.client.watchChanges(
            (event) => this.invalidate(event),
            () => this.invalidate(),
          );
  }
  dispose() {
    this.closed = true;
    this.stopWatching?.();
    this.options.present?.(undefined);
    this.reader?.abort();
    this.generation++;
    clearTimeout(this.timer);
    this.pending = undefined;
  }
}
