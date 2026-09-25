// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CODING_AGENTS = ["marina", "claude", "codex", "pi"] as const;
export type CodingAgent = (typeof CODING_AGENTS)[number];
export interface CodingHarness {
  version: 1;
  agent: CodingAgent;
  model?: string;
  /** Marina's command dialect; independent of the native runtime. */
  profile?: CodingAgent;
}
interface HarnessPreferences {
  version: 1;
  default?: string;
  harnesses: Record<string, CodingHarness>;
}
export function codingAgent(value: string): CodingAgent {
  if (!CODING_AGENTS.includes(value as CodingAgent))
    throw new Error(`Unknown agent ${value}. Choose ${CODING_AGENTS.join(", ")}.`);
  return value as CodingAgent;
}
export function validateHarness(value: unknown): CodingHarness {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A harness must be a JSON object");
  const row = value as Record<string, unknown>;
  if (row.version !== 1) throw new Error("Unsupported harness version (expected 1)");
  for (const key of Object.keys(row))
    if (!["version", "agent", "model", "profile"].includes(key))
      throw new Error(`Unsupported harness field: ${key}`);
  const agent = codingAgent(String(row.agent));
  if (
    row.model !== undefined &&
    (typeof row.model !== "string" ||
      !row.model.trim() ||
      row.model.length > 256 ||
      /\s/.test(row.model))
  )
    throw new Error(
      "Model must be a nonempty model identifier without whitespace (up to 256 characters)",
    );
  return {
    version: 1,
    agent,
    ...(row.model === undefined ? {} : { model: row.model as string }),
    ...(row.profile === undefined ? {} : { profile: codingAgent(String(row.profile)) }),
  };
}

/** Personal, per-project preferences. Repository files are only read by explicit --harness path. */
export class HarnessStore {
  readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, "harnesses.json");
  }
  private read(): HarnessPreferences {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, harnesses: {} };
      throw error;
    }
    const value = JSON.parse(raw) as HarnessPreferences;
    if (
      value.version !== 1 ||
      !value.harnesses ||
      typeof value.harnesses !== "object" ||
      Array.isArray(value.harnesses)
    )
      throw new Error(`Invalid harness preferences: ${this.path}`);
    if (value.default !== undefined && typeof value.default !== "string")
      throw new Error("Invalid default harness");
    return value;
  }
  list(): string[] {
    return Object.keys(this.read().harnesses).sort();
  }
  load(name?: string): CodingHarness | undefined {
    if (name && (name.includes("/") || name.endsWith(".json")))
      return validateHarness(JSON.parse(readFileSync(resolve(name), "utf8")));
    const preferences = this.read();
    const selected = name ?? preferences.default;
    if (!selected) return undefined;
    if (!Object.hasOwn(preferences.harnesses, selected))
      throw new Error(`Harness not found: ${selected}`);
    return validateHarness(preferences.harnesses[selected]);
  }
  save(name: string, harness: CodingHarness): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw new Error("Harness name must contain 1–64 letters, numbers, underscores or hyphens");
    const value = this.read();
    Object.defineProperty(value.harnesses, name, {
      value: validateHarness(harness),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    value.default = name;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
