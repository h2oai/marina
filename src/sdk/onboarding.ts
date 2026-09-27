// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
export const ORIENTATION_COMMANDS = ["look", "brief", "next"] as const;
export interface ParticipantOrientation {
  schema: "marina.onboarding.v1";
  entity: { id: string; name: string };
  room: string;
  world: string;
  objective: string | null;
  protocol: string;
  resumed: boolean;
  capabilityRevision: number;
  capabilityCommand: string;
  contextCommand: string;
  actions: { command: string; description: string }[];
}
