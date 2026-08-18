// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResponsiveLayouts } from "react-grid-layout";

type Bp = "lg" | "md";

export interface LayoutPreset {
  id: string;
  name: string;
  layouts: ResponsiveLayouts<Bp>;
  createdAt: number;
  updatedAt: number;
  locked?: boolean;
}

interface StoredState {
  presets: LayoutPreset[];
  activeId: string;
}

const STORAGE_KEY = "marina-dashboard-layout-presets-v1";
const DEFAULT_ID = "default";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `preset_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function loadStoredState(defaultLayouts: ResponsiveLayouts<Bp>): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredState;
      if (parsed?.presets?.length) {
        return parsed;
      }
    }
  } catch {
    // ignore corrupt data
  }
  const now = Date.now();
  return {
    presets: [
      {
        id: DEFAULT_ID,
        name: "Default",
        layouts: defaultLayouts,
        createdAt: now,
        updatedAt: now,
        locked: true,
      },
    ],
    activeId: DEFAULT_ID,
  };
}

export function useLayoutPresets(defaultLayouts: ResponsiveLayouts<Bp>) {
  const [state, setState] = useState<StoredState>(() => loadStoredState(defaultLayouts));

  // Ensure default preset is present even if stored data is missing it.
  useEffect(() => {
    setState((prev) => {
      const hasDefault = prev.presets.some((p) => p.id === DEFAULT_ID);
      if (hasDefault) return prev;
      const now = Date.now();
      return {
        presets: [
          {
            id: DEFAULT_ID,
            name: "Default",
            layouts: defaultLayouts,
            createdAt: now,
            updatedAt: now,
            locked: true,
          },
          ...prev.presets,
        ],
        activeId: prev.activeId ?? DEFAULT_ID,
      };
    });
  }, [defaultLayouts]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota errors
    }
  }, [state]);

  const presets = useMemo(() => state.presets, [state.presets]);
  const activeId = state.activeId;

  const applyPreset = useCallback(
    (id: string): ResponsiveLayouts<Bp> | null => {
      const preset = state.presets.find((p) => p.id === id);
      if (!preset) return null;
      setState((prev) => ({ ...prev, activeId: id }));
      return preset.layouts;
    },
    [state.presets],
  );

  const savePreset = useCallback((name: string, layouts: ResponsiveLayouts<Bp>) => {
    const now = Date.now();
    const preset: LayoutPreset = {
      id: createId(),
      name: name.trim() || `Workspace ${new Date(now).toLocaleTimeString()}`,
      layouts,
      createdAt: now,
      updatedAt: now,
    };
    setState((prev) => ({
      presets: [preset, ...prev.presets],
      activeId: preset.id,
    }));
    return preset.id;
  }, []);

  const renamePreset = useCallback((id: string, name: string) => {
    setState((prev) => ({
      ...prev,
      presets: prev.presets.map((p) =>
        p.id === id && !p.locked ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p,
      ),
    }));
  }, []);

  const deletePreset = useCallback((id: string) => {
    setState((prev) => {
      const preset = prev.presets.find((p) => p.id === id);
      if (!preset || preset.locked) return prev;
      const nextPresets = prev.presets.filter((p) => p.id !== id);
      const nextActive = prev.activeId === id ? DEFAULT_ID : prev.activeId;
      return {
        presets: nextPresets,
        activeId: nextActive,
      };
    });
  }, []);

  const updateActiveLayouts = useCallback((layouts: ResponsiveLayouts<Bp>) => {
    setState((prev) => ({
      ...prev,
      presets: prev.presets.map((p) =>
        p.id === prev.activeId && !p.locked ? { ...p, layouts, updatedAt: Date.now() } : p,
      ),
    }));
  }, []);

  return {
    presets,
    activeId,
    applyPreset,
    savePreset,
    renamePreset,
    deletePreset,
    updateActiveLayouts,
  };
}
