// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyLayerKey,
  LAYER_ORDER,
  type LayerVisibility,
  layerForKey,
  loadLayerHidden,
  MEMORY_LAYER_PREF_KEY,
  saveLayerHidden,
  soloLayer,
} from "../unified/lib/memory-map-layer";

const allVisible: LayerVisibility = {
  world: false,
  canvas: false,
  graph: false,
  feed: false,
  memory: false,
};

describe("layer keys", () => {
  it("maps 1-5 onto WORLD · CANVAS · GRAPH · FEED · MEMORY", () => {
    expect(LAYER_ORDER).toEqual(["world", "canvas", "graph", "feed", "memory"]);
    expect(layerForKey("5")).toBe("memory");
    expect(layerForKey("1")).toBe("world");
    expect(layerForKey("6")).toBeNull();
    expect(layerForKey("a")).toBeNull();
  });

  it("key 5 toggles the memory layer without touching the others", () => {
    const hidden = applyLayerKey(allVisible, "5", false)!;
    expect(hidden).toEqual({ ...allVisible, memory: true });
    const back = applyLayerKey(hidden, "5", false)!;
    expect(back).toEqual(allVisible);
  });

  it("shift+5 solos the memory layer; shift+3 solos the graph (memory hidden)", () => {
    expect(applyLayerKey(allVisible, "5", true)).toEqual(soloLayer("memory"));
    expect(soloLayer("memory")).toEqual({
      world: true,
      canvas: true,
      graph: true,
      feed: true,
      memory: false,
    });
    expect(applyLayerKey(allVisible, "3", true)?.memory).toBe(true);
    expect(applyLayerKey(allVisible, "3", true)?.graph).toBe(false);
  });

  it("returns null for non-layer keys so the caller leaves the event alone", () => {
    expect(applyLayerKey(allVisible, "/", false)).toBeNull();
    expect(applyLayerKey(allVisible, "0", true)).toBeNull();
  });
});

describe("layer persistence", () => {
  beforeEach(() => localStorage.clear());

  it("persists the memory layer under uc:hide-memory like the other layers", () => {
    expect(MEMORY_LAYER_PREF_KEY).toBe("uc:hide-memory");
    expect(loadLayerHidden("memory")).toBe(false); // first visit → visible
    saveLayerHidden("memory", true);
    expect(localStorage.getItem("uc:hide-memory")).toBe("true");
    expect(loadLayerHidden("memory")).toBe(true);
    saveLayerHidden("memory", false);
    expect(loadLayerHidden("memory")).toBe(false);
  });

  it("honours a first-visit default when nothing is stored", () => {
    expect(loadLayerHidden("memory", true)).toBe(true);
    localStorage.setItem("uc:hide-memory", "false");
    expect(loadLayerHidden("memory", true)).toBe(false);
  });
});
