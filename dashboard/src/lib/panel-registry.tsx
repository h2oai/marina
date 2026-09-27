// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ComponentType, useSyncExternalStore } from "react";
import type { PanelFocusProps } from "../components/GlassPanel";
import type { WorldMap } from "../components/WorldMap";

export interface DashboardPanelProps extends PanelFocusProps {
  worldData?: Parameters<typeof WorldMap>[0]["worldData"];
}
export interface DashboardPanelDefinition {
  id: string;
  title: string;
  slot: "grid" | "sidebar" | "admin-tab";
  modes?: readonly ("workspace" | "legacy")[];
  /** A statically imported local React component, never a URL or module name. */
  component: ComponentType<DashboardPanelProps>;
}

/** Local bundle composition only. Server manifests cannot register components. */
export function createDashboardPanelRegistry() {
  let panels: readonly DashboardPanelDefinition[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => panels,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(definition: DashboardPanelDefinition) {
      if (
        !/^[a-z][a-z0-9-]*$/.test(definition.id) ||
        !definition.title?.trim() ||
        !["grid", "sidebar", "admin-tab"].includes(definition.slot) ||
        typeof definition.component !== "function" ||
        definition.modes?.some((mode) => mode !== "workspace" && mode !== "legacy")
      )
        throw new Error("Invalid trusted dashboard panel");
      if (panels.some((panel) => panel.id === definition.id))
        throw new Error(`Dashboard panel already registered: ${definition.id}`);
      const panel = Object.freeze({
        ...definition,
        modes: definition.modes && Object.freeze([...definition.modes]),
      });
      panels = Object.freeze([...panels, panel]);
      changed();
      return () => {
        if (!panels.includes(panel)) return;
        panels = Object.freeze(panels.filter((entry) => entry !== panel));
        changed();
      };
    },
  };
}

export const dashboardPanels = createDashboardPanelRegistry();
export function useDashboardPanels(registry = dashboardPanels) {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

export function TrustedDashboardPanels({ slot }: { slot: "sidebar" | "admin-tab" }) {
  const panels = useDashboardPanels();
  return (
    <>
      {panels
        .filter((panel) => panel.slot === slot)
        .map((panel) => {
          const Panel = panel.component;
          return (
            <section key={panel.id} aria-label={panel.title}>
              <Panel />
            </section>
          );
        })}
    </>
  );
}
