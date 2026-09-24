// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Code-split entry points for heavy panels that are not visible on first paint:
 * the Admin tabs that carry most of the admin weight (Ops, Memory, Traces, Logs)
 * and the Pulse / Work / Memory drawers. Every importer goes through this module,
 * so each panel is one chunk no matter how many surfaces show it — a single
 * eager import elsewhere would pull it back into the main bundle.
 *
 * AttentionDrawer is deliberately NOT here: it polls while closed to drive
 * desktop alerts, so it must mount with the app.
 */

import { lazy, type ReactNode, Suspense, useState } from "react";

import { PanelSkeleton } from "./OperatorFeedback";

export const OpsTab = lazy(() => import("./ops/OpsTab").then((m) => ({ default: m.OpsTab })));
export const MemoryOpsTab = lazy(() =>
  import("./MemoryOpsTab").then((m) => ({ default: m.MemoryOpsTab })),
);
export const TraceExplorer = lazy(() =>
  import("./TraceExplorer").then((m) => ({ default: m.TraceExplorer })),
);
export const LogExplorer = lazy(() =>
  import("./LogExplorer").then((m) => ({ default: m.LogExplorer })),
);

export const PulseDrawer = lazy(() =>
  import("./PulseDrawer").then((m) => ({ default: m.PulseDrawer })),
);
export const WorkDrawer = lazy(() =>
  import("./WorkDrawer").then((m) => ({ default: m.WorkDrawer })),
);
export const MemoryWorkspace = lazy(() =>
  import("./MemoryWorkspace").then((m) => ({ default: m.MemoryWorkspace })),
);

/** Suspense boundary for a lazy tab body. */
export function TabSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PanelSkeleton />}>{children}</Suspense>;
}

/**
 * Mount a lazy drawer only once it has been opened, then keep it mounted so its
 * exit animation still plays on close. Rendering a lazy component while closed
 * would start its download on first paint and defeat the split.
 */
export function DeferredDrawer({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}
