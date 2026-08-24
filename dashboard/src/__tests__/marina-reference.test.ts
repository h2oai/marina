// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  dashboardInspectionFromSearch,
  marinaReferenceHref,
  primaryReferenceForEvent,
} from "../lib/marina-reference";

describe("Marina references", () => {
  it("links task events to their concrete detail and traced events to their span", () => {
    const task = primaryReferenceForEvent({
      type: "task_approved",
      taskId: 42,
      traceId: "trace-less-specific",
      timestamp: 1,
    });
    expect(task).toEqual({ kind: "task", id: "42" });
    expect(marinaReferenceHref(task!, "https://marina.example/canvas?canvas=x")).toBe(
      "/dashboard?inspect=task%3A42",
    );

    const trace = primaryReferenceForEvent({
      type: "agent_turn_end",
      traceId: "trace/1",
      spanId: "span 1",
      timestamp: 1,
    });
    expect(marinaReferenceHref(trace!, "https://marina.example/dashboard")).toBe(
      "/dashboard?trace=trace%2F1&span=span+1",
    );
  });

  it("opens a Canvas intent only when both parent and node identity are known", () => {
    expect(
      primaryReferenceForEvent({
        type: "canvas_intent",
        canvasId: "canvas-1",
        nodeId: "node-1",
        timestamp: 1,
      }),
    ).toEqual({ kind: "canvas_node", canvasId: "canvas-1", id: "node-1" });
    expect(
      primaryReferenceForEvent({ type: "canvas_intent", nodeId: "node-1", timestamp: 1 }),
    ).toBe(undefined);
  });

  it("parses only supported bounded dashboard inspection targets", () => {
    expect(dashboardInspectionFromSearch("?inspect=task%3A42")).toEqual({ type: "task", id: 42 });
    expect(dashboardInspectionFromSearch("?inspect=task%3A-1")).toBeUndefined();
    expect(dashboardInspectionFromSearch("?inspect=unknown%3A42")).toBeUndefined();
  });
});
