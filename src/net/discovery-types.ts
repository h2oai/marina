// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface CommandCatalogEntry {
  name: string;
  aliases: string[];
  category: string;
  help: string;
  minRank: number;
  gate?: string;
}

export interface DiscoveryResult {
  kind: "entity" | "room" | "task" | "note" | "board" | "channel";
  id: string;
  title: string;
  detail: string;
  command?: string;
}

export interface QuestProgress {
  id: string;
  name: string;
  active: boolean;
  completed: boolean;
  steps: { id: string; description: string; hint: string; done: boolean }[];
}

export interface EntityPreview {
  name: string;
  rank: number;
  standing: number | null;
  inventory: string[] | null;
  task: string | null;
  crew: string | null;
  privateVisible: boolean;
}
