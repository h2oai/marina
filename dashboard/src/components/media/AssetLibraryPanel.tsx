// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DashboardPanelProps } from "../../lib/panel-registry";
import { GlassPanel } from "../GlassPanel";
import { AssetLibrary } from "./AssetLibrary";

/** The Asset Library as a repeatable grid panel ("Open library below"). */
export function AssetLibraryPanel({ active = true, ...props }: DashboardPanelProps) {
  const { binding: _binding, onBindingChange: _change, worldData: _world, ...focus } = props;
  return (
    <GlassPanel title="Library" {...focus} bodyScroll={false}>
      <AssetLibrary active={active} />
    </GlassPanel>
  );
}
