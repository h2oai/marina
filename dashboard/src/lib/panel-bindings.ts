// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
export type PanelBinding =
  | { kind: "canvas-node"; canvasId: string; nodeId: string }
  | { kind: "participant"; id: string };
export type PanelBindings = Record<string, { resident: string | null; target: PanelBinding }>;

const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  ![...value].some((char) => char.charCodeAt(0) < 32);

export function parsePanelBinding(value: unknown): PanelBinding | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (b.kind === "canvas-node" && identifier(b.canvasId) && identifier(b.nodeId))
    return { kind: b.kind, canvasId: b.canvasId, nodeId: b.nodeId };
  if (b.kind === "participant" && identifier(b.id)) return { kind: b.kind, id: b.id };
  return null;
}

export function boundPanel(
  bindings: PanelBindings,
  id: string,
  resident: string | null,
): PanelBinding | null {
  const entry = bindings[id];
  return entry?.resident === resident ? parsePanelBinding(entry.target) : null;
}

/** An explicit local view request. Carries no content, credentials or operational action. */
export function openBoundPanel(target: PanelBinding) {
  window.dispatchEvent(new CustomEvent("marina:open-panel", { detail: target }));
}
