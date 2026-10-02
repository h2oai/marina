// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type CodingCommandTarget, parseCodingCommandTarget } from "./command-target";

export type PanelInputValue = string | boolean | { field: string };
export type PanelOperation =
  | { kind: "message"; targetId: string; message: PanelInputValue }
  | {
      kind: "control";
      targetId: string;
      control: "prompt" | "interrupt" | "stop" | "resume" | "respond";
      values?: Record<string, PanelInputValue>;
    }
  | {
      kind: "command";
      command: string;
      syntax: string;
      values?: Record<string, PanelInputValue>;
      enabled?: string[];
      codingTarget?: CodingCommandTarget;
    };

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function parsePanelOperation(value: unknown): PanelOperation | null {
  if (!record(value)) return null;
  let codingTarget: CodingCommandTarget | undefined;
  if (value.codingTarget !== undefined) {
    if (value.kind !== "command" || value.command !== "code") return null;
    try {
      codingTarget = parseCodingCommandTarget(value.codingTarget);
    } catch {
      return null;
    }
  }
  const text = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 1000;
  const input = (v: unknown): v is PanelInputValue =>
    typeof v === "string" ||
    typeof v === "boolean" ||
    (record(v) && text(v.field) && Object.keys(v).length === 1);
  const values =
    value.values === undefined ||
    (record(value.values) &&
      Object.keys(value.values).length <= 32 &&
      Object.values(value.values).every(input));
  if (value.kind === "message" && text(value.targetId) && input(value.message))
    return { kind: value.kind, targetId: value.targetId, message: value.message };
  if (
    value.kind === "control" &&
    text(value.targetId) &&
    ["prompt", "interrupt", "stop", "resume", "respond"].includes(String(value.control)) &&
    values
  )
    return {
      kind: "control",
      targetId: value.targetId,
      control: value.control as Extract<PanelOperation, { kind: "control" }>["control"],
      ...(value.values ? { values: value.values as Record<string, PanelInputValue> } : {}),
    };
  if (
    value.kind === "command" &&
    text(value.command) &&
    /^[a-z][a-z0-9_-]*$/.test(value.command) &&
    text(value.syntax) &&
    values &&
    (value.enabled === undefined ||
      (Array.isArray(value.enabled) && value.enabled.length <= 32 && value.enabled.every(text)))
  )
    return {
      kind: value.kind,
      command: value.command,
      syntax: value.syntax,
      ...(value.values ? { values: value.values as Record<string, PanelInputValue> } : {}),
      ...(value.enabled ? { enabled: value.enabled as string[] } : {}),
      ...(codingTarget ? { codingTarget } : {}),
    };
  return null;
}

export function panelInput(
  value: PanelInputValue,
  fields: Record<string, string | boolean>,
): string | boolean {
  if (typeof value === "object") {
    if (!Object.hasOwn(fields, value.field))
      throw new Error(`Enter ${value.field} before submitting.`);
    return fields[value.field]!;
  }
  return value;
}
export function panelOperationLabel(operation: PanelOperation): string {
  switch (operation.kind) {
    case "message":
      return `Send a message to participant ${operation.targetId}`;
    case "control":
      return `${operation.control} · participant ${operation.targetId}`;
    case "command":
      return `World command · ${operation.syntax}${operation.codingTarget ? ` · session ${operation.codingTarget.sessionId}${operation.codingTarget.runId ? ` · attempt ${operation.codingTarget.runId}` : ""}` : ""}`;
  }
}
