// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { selectInitialCanvas } from "../canvas/lib/select-canvas";
import { normalizeNodeType } from "../canvas/lib/types";

const canvases = [
  { id: "global-id", name: "global" },
  { id: "guide-id", name: "guide" },
  { id: "feed-id", name: "feed" },
  { id: "project-id", name: "project" },
];

describe("selectInitialCanvas", () => {
  it("prefers an explicitly requested canvas", () => {
    expect(selectInitialCanvas(canvases, "project-id")?.id).toBe("project-id");
  });

  it("prefers the populated activity feed over global", () => {
    expect(selectInitialCanvas(canvases)?.id).toBe("feed-id");
  });

  it("falls back to the guide, global, and then the first available canvas", () => {
    expect(selectInitialCanvas(canvases.filter((canvas) => canvas.name !== "feed"))?.id).toBe(
      "guide-id",
    );
    expect(
      selectInitialCanvas(
        canvases.filter((canvas) => canvas.name !== "feed" && canvas.name !== "guide"),
      )?.id,
    ).toBe("global-id");
    expect(selectInitialCanvas([{ id: "only", name: "project" }])?.id).toBe("only");
  });

  it("returns undefined when no canvases exist", () => {
    expect(selectInitialCanvas([])).toBeUndefined();
  });
});

describe("normalizeNodeType", () => {
  it("preserves supported renderers and makes unknown producer values visible as text", () => {
    expect(normalizeNodeType("image")).toBe("image");
    expect(normalizeNodeType("future-agent-artifact")).toBe("text");
  });
});
