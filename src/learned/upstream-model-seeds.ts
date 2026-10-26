// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upstream seeds that choose a model wait for a local person.
 *
 * An imported learned bundle can carry a seed for any default slot. A seed
 * for a slot that chooses WHICH MODEL RUNS (or how many calls a configuration
 * makes) would otherwise change who acts and what it costs with no local
 * approval. Under `MARINA_UPSTREAM_MODEL_SEEDS=propose` (the default) such a
 * seed is never served by `resolveDefault`; it is withheld (traced as
 * `withheld`) and raised as ONE ops-inbox approval per slot and value. A
 * PERSON holding `role.edit` adopts it with `benchmark promote <slot>
 * upstream` (or the model id itself, for a string value), which files it
 * through `fileSlotPromotion` with basis `upstream`. `serve` restores direct
 * serving (operator opt-in, env only).
 *
 * The classification is default-deny: every slot class is model-selecting
 * except the ones listed in `NON_MODEL_SEED_SLOT_CLASSES`. A benchmark-run
 * promotion stores the run's target (`{model, stack, source}`) as the slot
 * value, so any slot filled through the run path names a model; the known
 * model slots are `role-model:*`, `verify:checker`, `forecast-config*`
 * (analysts, planner, critic, verifier, formation) and crew slots
 * (`showcase:crew`, `crew:<name>:formation`). Only the memory-ranking
 * weights choose no model and spend nothing.
 */

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { sha256Hex } from "../security/hash";

const logger = new Logger();

/** Slot classes whose seeds choose no model and spend nothing: served as before. */
export const NON_MODEL_SEED_SLOT_CLASSES: readonly string[] = ["memory-ranking"];

export type UpstreamModelSeedMode = "serve" | "propose";

/** `MARINA_UPSTREAM_MODEL_SEEDS`: `serve` only when set so; anything else proposes. */
export function upstreamModelSeedMode(
  env: Record<string, string | undefined> = process.env,
): UpstreamModelSeedMode {
  return env.MARINA_UPSTREAM_MODEL_SEEDS?.trim().toLowerCase() === "serve" ? "serve" : "propose";
}

/** True unless the slot's class (its first `:` segment) is a known non-model class. */
export function isModelSelectingSlot(slot: string): boolean {
  const base = slot.split(":")[0] ?? "";
  return !NON_MODEL_SEED_SLOT_CLASSES.includes(base);
}

/** Whether `resolveDefault` withholds an upstream seed for this slot. */
export function withholdsUpstreamSeed(
  slot: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return upstreamModelSeedMode(env) === "propose" && isModelSelectingSlot(slot);
}

/** The ops-inbox category shared with live promotion proposals. */
const PROPOSAL_CATEGORY = "promotion";

/** A short digest of a seed's stored value (its `value_json`). */
export function seedValueHash(valueJson: string): string {
  return sha256Hex(valueJson).slice(0, 16);
}

/**
 * One proposal per slot and value. It starts with `promotion:<slot>:`, so a
 * later promotion of the slot resolves it with the live proposals.
 */
export function upstreamProposalKey(slot: string, valueJson: string): string {
  return `${PROPOSAL_CATEGORY}:${slot}:upstream#${seedValueHash(valueJson)}`;
}

interface SeedRow {
  slot: string;
  value_json: string;
  artifact_id: string;
  version: string;
  generation: number;
  item_key: string;
}

export interface UpstreamProposalStore {
  listUpstreamDefaultSeeds(): SeedRow[];
  getBenchmarkDefault(slot: string): unknown;
  listOperationalAlerts(
    status?: undefined,
    limit?: number,
  ): Array<{ alert_key: string; category: string }>;
  upsertOperationalAlert(alert: {
    key: string;
    severity: "critical" | "warning" | "info";
    category: string;
    title: string;
    detail: string;
    remedy: string;
    kind?: string;
    actionLabel?: string;
    actionRef?: string;
    metadata?: Record<string, unknown>;
  }): unknown;
}

/** The command a person runs to adopt a seed. */
export function adoptCommand(slot: string, valueJson: string): string {
  let v: unknown;
  try {
    v = JSON.parse(valueJson);
  } catch {
    v = undefined; // allow-empty-catch: an unreadable value is adopted as `upstream`
  }
  const plain = typeof v === "string" && /^[^\s]+$/.test(v.trim()) ? v.trim() : "upstream";
  return `benchmark promote ${slot} ${plain}`;
}

/**
 * Raise one approval per withheld model seed (slot + value) not raised before,
 * whatever happened to the earlier one. Writes nothing under `serve`, nothing
 * for a slot with a local row, nothing for a non-model slot. Returns how many
 * proposals were raised. Never throws.
 */
export function proposeUpstreamModelSeeds(
  db: UpstreamProposalStore,
  env: Record<string, string | undefined> = process.env,
): number {
  if (upstreamModelSeedMode(env) === "serve") return 0;
  let rows: SeedRow[];
  try {
    rows = db.listUpstreamDefaultSeeds();
  } catch {
    return 0; // allow-empty-catch: a database without migration 161 has no seeds
  }
  let known: Set<string> | undefined;
  let raised = 0;
  for (const s of rows) {
    if (!isModelSelectingSlot(s.slot)) continue;
    try {
      if (db.getBenchmarkDefault(s.slot)) continue;
      known ??= new Set(
        db
          .listOperationalAlerts(undefined, 100_000)
          .filter((a) => a.category === PROPOSAL_CATEGORY)
          .map((a) => a.alert_key),
      );
      const key = upstreamProposalKey(s.slot, s.value_json);
      if (known.has(key)) continue;
      const command = adoptCommand(s.slot, s.value_json);
      db.upsertOperationalAlert({
        key,
        severity: "info",
        category: PROPOSAL_CATEGORY,
        kind: "approval",
        title: `adopt upstream ${s.slot} → ${s.value_json.slice(0, 80)} (withheld pending approval)`,
        detail: `imported bundle ${s.artifact_id}@${s.version} (generation ${s.generation}, item ${s.item_key}) seeds ${s.slot}, which chooses a model; it is not served until a person adopts it (MARINA_UPSTREAM_MODEL_SEEDS=propose)`,
        remedy: `${command} (a person holding role.edit; files it with basis upstream) · learned seeds`,
        actionLabel: "Adopt",
        actionRef: command,
        metadata: {
          slot: s.slot,
          basis: "upstream",
          artifactId: s.artifact_id,
          version: s.version,
          generation: s.generation,
          itemKey: s.item_key,
          valueSha256: sha256Hex(s.value_json),
        },
      });
      known.add(key);
      raised++;
    } catch (err) {
      // One seed that cannot be proposed never stops the others.
      logger.warn("defaults", "upstream model seed not proposed", {
        slot: s.slot,
        error: getErrorMessage(err),
      });
    }
  }
  return raised;
}
