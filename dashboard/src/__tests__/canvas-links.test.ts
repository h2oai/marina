// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canvasPermalink, canvasSelectionFromSearch } from "../canvas/lib/canvas-links";

describe("Canvas deep links", () => {
  it("reads bounded canvas, node, and edge references", () => {
    expect(canvasSelectionFromSearch("?canvas=canvas-1&node=node%2F1&edge=edge-1")).toEqual({
      canvasId: "canvas-1",
      nodeId: "node/1",
      edgeId: "edge-1",
    });
    expect(canvasSelectionFromSearch(`?canvas=${"x".repeat(201)}&node=%20`)).toEqual({
      canvasId: undefined,
      nodeId: undefined,
      edgeId: undefined,
    });
  });

  it("creates a canonical Canvas URL without leaking unrelated surface state", () => {
    expect(
      canvasPermalink(
        { canvasId: "canvas/1", nodeId: "node 1" },
        "https://marina.example/dashboard?trace=req-1#panel",
      ),
    ).toBe("/canvas?canvas=canvas%2F1&node=node+1");
  });
});
