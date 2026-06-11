import { act, renderHook } from "@testing-library/react";
import type { ResponsiveLayouts } from "react-grid-layout";
import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutPresets } from "../hooks/use-layout-presets";

type Bp = "lg" | "md";

const DEFAULTS: ResponsiveLayouts<Bp> = {
  lg: [{ i: "a", x: 0, y: 0, w: 1, h: 1 }],
  md: [{ i: "a", x: 0, y: 0, w: 1, h: 1 }],
};
const LAYOUT_B: ResponsiveLayouts<Bp> = {
  lg: [{ i: "b", x: 1, y: 0, w: 2, h: 2 }],
  md: [{ i: "b", x: 0, y: 0, w: 2, h: 2 }],
};

beforeEach(() => {
  localStorage.clear();
});

describe("useLayoutPresets", () => {
  it("seeds a locked Default preset as active when storage is empty", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    expect(result.current.activeId).toBe("default");
    expect(result.current.presets).toHaveLength(1);
    expect(result.current.presets[0]).toMatchObject({
      id: "default",
      name: "Default",
      locked: true,
    });
  });

  it("saves a new preset, makes it active, and returns its id", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    let id = "";
    act(() => {
      id = result.current.savePreset("Focus", LAYOUT_B);
    });
    expect(id).toBeTruthy();
    expect(result.current.activeId).toBe(id);
    expect(result.current.presets).toHaveLength(2);
    expect(result.current.presets.find((p) => p.id === id)?.layouts).toEqual(LAYOUT_B);
  });

  it("renames a custom preset but refuses to rename the locked default", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    let id = "";
    act(() => {
      id = result.current.savePreset("Focus", LAYOUT_B);
    });
    act(() => result.current.renamePreset(id, "Renamed"));
    expect(result.current.presets.find((p) => p.id === id)?.name).toBe("Renamed");

    act(() => result.current.renamePreset("default", "Hacked"));
    expect(result.current.presets.find((p) => p.id === "default")?.name).toBe("Default");
  });

  it("deletes a custom preset and re-homes active to default; refuses to delete default", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    let id = "";
    act(() => {
      id = result.current.savePreset("Focus", LAYOUT_B);
    });
    expect(result.current.activeId).toBe(id);

    act(() => result.current.deletePreset(id));
    expect(result.current.presets.find((p) => p.id === id)).toBeUndefined();
    expect(result.current.activeId).toBe("default");

    act(() => result.current.deletePreset("default"));
    expect(result.current.presets.find((p) => p.id === "default")).toBeDefined();
  });

  it("updateActiveLayouts edits the active custom preset but never the locked default", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    // active is the locked default → no-op
    act(() => result.current.updateActiveLayouts(LAYOUT_B));
    expect(result.current.presets.find((p) => p.id === "default")?.layouts).toEqual(DEFAULTS);

    let id = "";
    act(() => {
      id = result.current.savePreset("Focus", DEFAULTS);
    });
    act(() => result.current.updateActiveLayouts(LAYOUT_B));
    expect(result.current.presets.find((p) => p.id === id)?.layouts).toEqual(LAYOUT_B);
  });

  it("applyPreset returns the layouts and sets it active; null for unknown", () => {
    const { result } = renderHook(() => useLayoutPresets(DEFAULTS));
    let id = "";
    act(() => {
      id = result.current.savePreset("Focus", LAYOUT_B);
    });
    act(() => result.current.applyPreset("default"));
    expect(result.current.activeId).toBe("default");

    let applied: ResponsiveLayouts<Bp> | null = null;
    act(() => {
      applied = result.current.applyPreset(id);
    });
    expect(applied).toEqual(LAYOUT_B);
    expect(result.current.activeId).toBe(id);

    let missing: ResponsiveLayouts<Bp> | null = LAYOUT_B;
    act(() => {
      missing = result.current.applyPreset("nope");
    });
    expect(missing).toBeNull();
  });

  it("persists presets to localStorage and rehydrates them", () => {
    const first = renderHook(() => useLayoutPresets(DEFAULTS));
    act(() => {
      first.result.current.savePreset("Focus", LAYOUT_B);
    });
    // A fresh hook instance reads the persisted state.
    const second = renderHook(() => useLayoutPresets(DEFAULTS));
    expect(second.result.current.presets.some((p) => p.name === "Focus")).toBe(true);
  });
});
