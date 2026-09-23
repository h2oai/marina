// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ExactKeys } from "./exact-keys";

/** Settings (`db-agents.ts`) and the meta key-value table (`db-meta.ts`). */
export interface SettingsStore {
  getMetaValue(key: string): string | undefined;
  setMetaValue(key: string, value: string): void;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  listSettingsByPrefix(prefix: string): { key: string; value: string }[];
  /** Effective default model — DB `default_model` setting, else MARINA_DEFAULT_MODEL. */
  getDefaultModel(): string;
}

/** Runtime mirror of `SettingsStore`'s method names — the drift test compares it to the facade. */
export const SETTINGS_STORE_METHODS = [
  "getMetaValue",
  "setMetaValue",
  "getSetting",
  "setSetting",
  "deleteSetting",
  "listSettingsByPrefix",
  "getDefaultModel",
] as const satisfies readonly (keyof SettingsStore)[];

export const SETTINGS_STORE_COMPLETE: ExactKeys<SettingsStore, typeof SETTINGS_STORE_METHODS> =
  true;
