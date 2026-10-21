// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSupports, AgentThinkingLevel } from "../../agent/agent-types";
import type {
  AdapterRow,
  AgentConfigRow,
  AgentRuntimeKind,
  ApiKeyRow,
  AttentionRelay,
  AttentionWakeInput,
  AttentionWakeRow,
  EditHistoryRow,
  RoleLoopSections,
  RoleRow,
  TraitCapabilities,
  TraitRow,
} from "../db-agents";
import type { ExactKeys } from "./exact-keys";

/** Traits, roles, agent configs, API keys and adapters (`db-agents.ts`). */
export interface AgentsStore {
  saveTrait(opts: {
    name: string;
    category: string;
    prompt: string;
    capabilities?: TraitCapabilities;
    createdBy: string;
  }): void;
  getTrait(name: string): TraitRow | undefined;
  getAllTraits(): TraitRow[];
  deleteTrait(name: string): void;
  saveRole(opts: {
    name: string;
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
    loop?: RoleLoopSections;
    createdBy: string;
  }): void;
  getRole(name: string): RoleRow | undefined;
  getAllRoles(): RoleRow[];
  deleteRole(name: string): void;
  getTraitHistory(name: string, limit?: number): EditHistoryRow[];
  getRoleHistory(name: string, limit?: number): EditHistoryRow[];
  saveAgentConfig(opts: {
    name: string;
    model: string;
    role?: string;
    goal?: string;
    keyName?: string;
    room?: string;
    spawnedBy: string;
    supports?: AgentSupports /** Reasoning depth (migration 120). `undefined` keeps the stored value. */;
    thinkingLevel?: AgentThinkingLevel;
    /** Who runs the account (migration 173). `undefined` keeps the stored value. */
    runtime?: AgentRuntimeKind;
    vendor?: string;
  }): void;
  getAgentConfig(name: string): AgentConfigRow | undefined;
  getAllAgentConfigs(): AgentConfigRow[];
  getAgentConfigsBySpawnedBy(spawnedBy: string): AgentConfigRow[];
  /** Bind or clear the routing session of a supervised resident's run (migration 173). */
  setAgentRunSession(name: string, sessionId: string | null): boolean;
  /** `name` and its spawn ancestors, lower-cased, nearest first (`db-agents.ts:spawnLineage`). */
  spawnLineage(name: string): string[];
  /** Every agent `name` owns down its spawn lineage, lower-cased (`db-agents.ts:spawnDescendants`). */
  spawnDescendants(name: string): string[];
  deleteAgentConfig(name: string): void;
  updateAttentionPolicy(
    name: string,
    mode: "focused" | "balanced" | "open",
    threshold?: number,
  ): boolean;
  recordAttentionFeedback(name: string, feedback: "useful" | "noise"): AgentConfigRow | undefined;
  recordAutomaticAttentionOutcome(
    name: string,
    outcome: "success" | "failure",
  ): AgentConfigRow | undefined;
  /** Final-reply relay of a supervised resident (migration 174). */
  setAttentionRelay(name: string, relay: AttentionRelay): boolean;
  /** Append attention-bridge decisions (migration 174): refs and reasons only. */
  recordAttentionWakes(wakes: readonly AttentionWakeInput[]): number;
  listAttentionWakes(entity: string, limit?: number): AttentionWakeRow[];
  saveApiKey(opts: {
    name: string;
    provider: string;
    encryptedValue: string;
    isEncrypted?: boolean;
    setBy: string;
  }): void;
  getApiKey(name: string): ApiKeyRow | undefined;
  getApiKeysByProvider(provider: string): ApiKeyRow[];
  getAllApiKeys(): ApiKeyRow[];
  deleteApiKey(name: string): void;
  /** Encrypt any plaintext API-key rows once MARINA_KEY_SECRET is set. */
  migrateApiKeysToEncrypted(): number;
  /** Count encrypted vs. currently-undecryptable API-key rows. */
  auditEncryptedKeys(): { encrypted: number; unreadable: number };
  saveAdapter(opts: { platform: string; config: string; status: string; setBy: string }): void;
  getAdapter(platform: string): AdapterRow | undefined;
  getAllAdapters(): AdapterRow[];
  updateAdapterStatus(platform: string, status: string): void;
  deleteAdapter(platform: string): void;
}

/** Runtime mirror of `AgentsStore`'s method names — the drift test compares it to the facade. */
export const AGENTS_STORE_METHODS = [
  "saveTrait",
  "getTrait",
  "getAllTraits",
  "deleteTrait",
  "saveRole",
  "getRole",
  "getAllRoles",
  "deleteRole",
  "getTraitHistory",
  "getRoleHistory",
  "saveAgentConfig",
  "getAgentConfig",
  "getAllAgentConfigs",
  "getAgentConfigsBySpawnedBy",
  "setAgentRunSession",
  "spawnLineage",
  "spawnDescendants",
  "deleteAgentConfig",
  "updateAttentionPolicy",
  "recordAttentionFeedback",
  "recordAutomaticAttentionOutcome",
  "setAttentionRelay",
  "recordAttentionWakes",
  "listAttentionWakes",
  "saveApiKey",
  "getApiKey",
  "getApiKeysByProvider",
  "getAllApiKeys",
  "deleteApiKey",
  "migrateApiKeysToEncrypted",
  "auditEncryptedKeys",
  "saveAdapter",
  "getAdapter",
  "getAllAdapters",
  "updateAdapterStatus",
  "deleteAdapter",
] as const satisfies readonly (keyof AgentsStore)[];

export const AGENTS_STORE_COMPLETE: ExactKeys<AgentsStore, typeof AGENTS_STORE_METHODS> = true;
