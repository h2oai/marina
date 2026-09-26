// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoutingEvent } from "../../../src/sdk/routing-types";

export interface ParticipantActivity {
  title: string;
  text?: string;
  tone: "default" | "warning" | "danger";
  events: RoutingEvent[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function describe(event: RoutingEvent): Omit<ParticipantActivity, "events"> {
  const payload = record(event.payload);
  const ordinary = { tone: "default" as const };
  switch (event.kind) {
    case "output":
      return {
        ...ordinary,
        title: payload.method === "item/commandExecution/outputDelta" ? "Tool output" : "Output",
        text: text(payload.text) ?? text(event.payload),
      };
    case "runtime.state": {
      const status = text(payload.status);
      const known = ["starting", "idle", "running", "waiting", "stopped", "failed", "disconnected"];
      if (!status || !known.includes(status)) break;
      return {
        title: `Runtime · ${status}`,
        tone: status === "failed" ? "danger" : status === "waiting" ? "warning" : "default",
        text: [text(payload.cwd), text(payload.error)].filter(Boolean).join("\n"),
      };
    }
    case "workspace.prepared":
      return {
        ...ordinary,
        title: "Workspace prepared",
        text: [text(payload.cwd), text(payload.text)].filter(Boolean).join("\n"),
      };
    case "approval.requested":
      return {
        title: payload.kind === "question" ? "Question received" : "Permission requested",
        tone: "warning",
        text: text(payload.title),
      };
    case "approval.resolved":
      return {
        ...ordinary,
        title: "Request resolved",
        text: `Request ${text(payload.requestId) ?? "unknown"} · ${payload.allow === true ? "allowed" : payload.allow === false ? "declined" : "outcome unavailable"}`,
      };
    case "delivery.accepted":
      return { ...ordinary, title: "Instruction accepted", text: text(payload.text) };
    case "delivery.error":
      return { title: "Instruction outcome uncertain", tone: "danger", text: text(payload.text) };
    case "stderr":
    case "adapter.error":
      return {
        title: event.kind === "stderr" ? "Diagnostic output" : "Agent error",
        tone: event.kind === "stderr" ? "warning" : "danger",
        text: text(payload.text),
      };
    case "native.result":
      return {
        title: payload.is_error ? "Agent turn failed" : "Agent turn ended",
        tone: payload.is_error ? "danger" : "default",
        text: text(payload.result),
      };
    case "native.assistant":
    case "native.user":
    case "native.message_end": {
      const message = record(payload.message);
      const content = message.content;
      const parts = Array.isArray(content)
        ? content
            .map((part) => {
              const block = record(part);
              if (block.type === "tool_use") return `Tool: ${text(block.name) ?? "unknown"}`;
              return text(block.text);
            })
            .filter(Boolean)
            .join("\n")
        : text(content);
      return {
        ...ordinary,
        title: event.kind === "native.user" ? "Agent input" : "Message snapshot",
        text: parts,
      };
    }
    case "native.turn/completed": {
      const turn = record(payload.turn);
      return {
        title: "Agent turn ended",
        tone: turn.status === "failed" ? "danger" : "default",
        text: text(turn.status),
      };
    }
    case "native.tool_execution_start":
    case "native.tool_execution_end":
      return {
        title: event.kind.endsWith("_start") ? "Tool started" : "Tool ended",
        tone: payload.isError ? "danger" : "default",
        text: text(payload.toolName),
      };
    case "native.item/started":
    case "native.item/completed": {
      const item = record(payload.item);
      return {
        ...ordinary,
        title: event.kind.endsWith("/started") ? "Activity started" : "Activity ended",
        text: [text(item.type), text(item.command) ?? text(item.text)].filter(Boolean).join("\n"),
      };
    }
  }
  // Unknown participants and native payloads remain inspectable without guessing their meaning.
  return { ...ordinary, title: event.kind, text: text(payload.text) ?? text(event.payload) };
}

/** Display projection only: preserve every source event and never infer task completion. */
export function participantActivity(
  events: RoutingEvent[],
  adapter: string,
): ParticipantActivity[] {
  const blocks: ParticipantActivity[] = [];
  for (const event of events) {
    const previous = blocks.at(-1);
    const last = previous?.events.at(-1);
    const payload = record(event.payload);
    const before = record(last?.payload);
    // These adapters publish text deltas. Arbitrary consumers' output may be complete messages.
    if (
      ["claude", "codex", "pi"].includes(adapter) &&
      event.kind === "output" &&
      last?.kind === "output" &&
      event.sessionId === last.sessionId &&
      event.sequence === last.sequence + 1 &&
      typeof payload.text === "string" &&
      typeof before.text === "string" &&
      payload.method === before.method &&
      payload.itemId === before.itemId
    ) {
      previous!.text = (previous!.text ?? "") + payload.text;
      previous!.events.push(event);
    } else blocks.push({ ...describe(event), events: [event] });
  }
  return blocks;
}

/** A repeated page must not duplicate displayed evidence; retain a bounded window. */
export function mergeParticipantEvents(previous: RoutingEvent[], next: RoutingEvent[]) {
  const events = new Map(previous.map((event) => [event.sequence, event]));
  for (const event of next) events.set(event.sequence, event);
  return [...events.values()].sort((a, b) => a.sequence - b.sequence).slice(-500);
}
