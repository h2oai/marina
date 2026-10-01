// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Registry of the procedurally seeded native task generators. */

import { aggregationGenerator } from "./aggregation";
import { auctionGenerator } from "./auction";
import { bugsGenerator } from "./bugs";
import { cspGenerator } from "./csp";
import { delphiGenerator } from "./delphi";
import { pipelineGenerator } from "./pipeline";
import type { NativeGenerator, NativeInstance, NativeTaskId, SetupStep } from "./shared";

export * from "./shared";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous oracle types behind one registry
export const GENERATORS: Record<NativeTaskId, NativeGenerator<any>> = {
  csp: cspGenerator,
  aggregation: aggregationGenerator,
  bugs: bugsGenerator,
  auction: auctionGenerator,
  delphi: delphiGenerator,
  pipeline: pipelineGenerator,
};

/** Short aliases accepted by the CLI. */
const ALIASES: Record<string, NativeTaskId> = {
  agg: "aggregation",
  sharding: "aggregation",
  bug: "bugs",
  verification: "bugs",
  auc: "auction",
  dlp: "delphi",
  forecast: "delphi",
  pipe: "pipeline",
};

export function resolveTask(name: string): NativeTaskId {
  const k = name.trim().toLowerCase();
  if (k in GENERATORS) return k as NativeTaskId;
  const alias = ALIASES[k];
  if (alias) return alias;
  throw new Error(`unknown native task "${name}" (one of ${Object.keys(GENERATORS).join(", ")})`);
}

/**
 * Room-hostable view of an instance: everything a per-instance room module
 * would hold (KV state, per-member private material, files, shared notes),
 * without the transport. Today the runner delivers it as tells, pool notes
 * and workspace files; a room host could serve the same spec from room KV and
 * room-scoped commands, and its oracle would read the same `oracle` data.
 */
export interface EnvironmentSpec {
  roomId: string;
  tag: string;
  dispatch: string;
  kv: Record<string, string>;
  privateMaterial: Record<string, string[]>;
  files: Record<string, string>;
  sharedNotes: { pool: string; text: string }[];
  deliverable: { pool: string; pattern: string };
}

export function environmentSpec(inst: NativeInstance<unknown>): EnvironmentSpec {
  const files: Record<string, string> = {};
  const sharedNotes: { pool: string; text: string }[] = [];
  for (const s of inst.setup as SetupStep[]) {
    if (s.kind === "file") files[s.path] = s.content;
    else if (s.kind === "pool-note") sharedNotes.push({ pool: s.pool, text: s.text });
  }
  return {
    roomId: `native/${inst.tag.toLowerCase()}`,
    tag: inst.tag,
    dispatch: inst.text,
    kv: { task: inst.task, seed: String(inst.seed), shape: inst.shape },
    privateMaterial: inst.privateMaterial,
    files,
    sharedNotes,
    deliverable: { pool: inst.pool, pattern: inst.deliverableRe },
  };
}
