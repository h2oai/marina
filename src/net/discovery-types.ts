// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export type { CommandCatalogEntry } from "../sdk/capabilities";

export interface DiscoveryResult {
  kind: "entity" | "room" | "task" | "note" | "board" | "channel";
  id: string;
  title: string;
  detail: string;
  command?: string;
}

export interface EntityPreview {
  name: string;
  rank: number;
  standing: number | null;
  task: string | null;
  crew: string | null;
  privateVisible: boolean;
}
