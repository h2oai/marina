// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSupports, AgentThinkingLevel } from "../../agent/agent-types";
import type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  EditHistoryRow,
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
  getTraitsByCategory(category: string): TraitRow[];
  deleteTrait(name: string): void;
  saveRole(opts: {
    name: string;
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
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
  }): void;
  getAgentConfig(name: string): AgentConfigRow | undefined;
  getAllAgentConfigs(): AgentConfigRow[];
  getAgentConfigsBySpawnedBy(spawnedBy: string): AgentConfigRow[];
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
  "getTraitsByCategory",
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
  "deleteAgentConfig",
  "updateAttentionPolicy",
  "recordAttentionFeedback",
  "recordAutomaticAttentionOutcome",
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
