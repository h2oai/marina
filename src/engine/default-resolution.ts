// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One resolution path for defaults — the place evidence reaches a choice.
 *
 * Every configurable default that earned promotion may move (a forecast
 * configuration, the `marina/verify` checker, a crew model) resolves through
 * `resolveDefault`, in a fixed order:
 *
 *   1. env       — the operator's explicit setting (an env var or an explicit
 *                  flag/argument the caller passes as such). Always wins.
 *   2. slot      — the local slot: `<slot>:<board>` when the choice is for a
 *                  named board, else `<slot>` itself (a deployment slot such as
 *                  `showcase:crew`). Filled only by earned promotion on a
 *                  benchmark's holdout (`benchmark-promotion.ts`).
 *   3. family    — the family slot `<slot>:family:<family>`, for each family
 *                  the caller declares, in order. The per-board promotion path
 *                  REFUSES family slots (one board never sets a default for a
 *                  family), so today only an upstream seed or a future
 *                  multi-board rule can fill one.
 *   4. upstream  — a seed from an imported learned bundle, consulted only when
 *                  no local slot answered: the ledger's own active
 *                  `upstream_default_seeds` rows (`src/learned/upstream-seed.ts`;
 *                  a seed never answers while its slot has a local row), or a
 *                  source registered with `setUpstreamSeedSource` (tests). A
 *                  database that never imported a bundle has no seeds, so its
 *                  trace is unchanged. A seed for a slot that chooses a model
 *                  (every class but memory-ranking,
 *                  `src/learned/upstream-model-seeds.ts`) is WITHHELD under
 *                  `MARINA_UPSTREAM_MODEL_SEEDS=propose` (the default): traced
 *                  `withheld`, never served, until a person adopts it.
 *   5. builtin   — the caller's built-in value (today's behaviour).
 *
 * A slot whose incumbent run was invalidated rests on no evidence and is
 * skipped (the next layer answers). A slot value the caller cannot read (a
 * different shape, a malformed field) is skipped too, never half-applied.
 *
 * Every resolution is traced: it names the layer that answered, the key it
 * answered from, and why each earlier layer did not (`DefaultResolution`),
 * and is delivered to every `onDefaultResolved` listener (the engine turns it
 * into a `default_resolved` event) and the `defaults` Logger category. With
 * nothing promoted and no seed source, the built-in answers — exactly the
 * behaviour before this module existed.
 */

import { withholdsUpstreamSeed } from "../learned/upstream-model-seeds";
import { upstreamSeedFor } from "../learned/upstream-seed";
import type { BenchmarkDefaultRow, BenchmarkRunRow } from "../persistence/db-benchmarks";
import type { UpstreamDefaultSeedRow } from "../persistence/db-learned";
import { Logger } from "./logger";

const logger = new Logger();

export type DefaultSource = "env" | "slot" | "family" | "upstream" | "builtin";

/** The store slice resolution reads (any `MarinaDB`). */
export interface DefaultSlotReader {
  getBenchmarkDefault(slot: string): BenchmarkDefaultRow | undefined;
  getBenchmarkRun?(id: string): BenchmarkRunRow | undefined;
  /** The active seed an imported learned bundle left for a slot (migration 161). */
  latestUpstreamDefaultSeed?(slot: string): UpstreamDefaultSeedRow | undefined;
}

/** An upstream seed for a slot key: the value and the bundle version it came from. */
export interface UpstreamSeed {
  value: unknown;
  version: string;
}

export type UpstreamSeedSource = (slotKey: string) => UpstreamSeed | undefined;

export interface DefaultSpec<T> {
  /** The slot's base name (`forecast-config`, `verify:checker`, `showcase:crew`). */
  slot: string;
  /** The board this choice is for: the local slot becomes `<slot>:<board>`. */
  board?: string;
  /** Families this choice belongs to, most specific first (`<slot>:family:<f>`). */
  families?: readonly string[];
  /** The operator's explicit value and where it came from (`MARINA_…`, `--config`). */
  env?: { name: string; value: T | undefined };
  /** Read the caller's value out of a slot's stored value; undefined = not usable here. */
  read: (value: unknown) => T | undefined;
  /** The built-in default. */
  builtIn: T;
  /** Describe the built-in in the trace (default: "built-in"). */
  builtInLabel?: string;
  /** The ledger (absent: only env and built-in can answer). */
  db?: DefaultSlotReader;
  /** Who asked (the surface), for the trace. */
  surface?: string;
}

export interface ConsultedLayer {
  layer: DefaultSource;
  key: string;
  /** `withheld`: an upstream seed for a model-selecting slot, pending local approval. */
  outcome: "answered" | "unset" | "invalidated" | "unreadable" | "unavailable" | "withheld";
}

export interface DefaultResolution<T> {
  slot: string;
  surface?: string;
  value: T;
  source: DefaultSource;
  /** The env var / slot key / seed version / built-in label that answered. */
  key: string;
  /** For a slot answer: the incumbent run it rests on. */
  incumbentRunId?: string | null;
  /** One line: who answered and why the earlier layers did not. */
  reason: string;
  consulted: ConsultedLayer[];
  /** Upstream seeds withheld pending local approval (`<slot>@upstream:<version>`). */
  withheld?: string[];
}

const FAMILY_SEGMENT = "family";

/** The per-board slot key. */
export function boardSlotKey(slot: string, board: string): string {
  return `${slot}:${slugify(board)}`;
}

/** The family slot key. */
export function familySlotKey(slot: string, family: string): string {
  return `${slot}:${FAMILY_SEGMENT}:${slugify(family)}`;
}

/** True for a family slot key (`…:family:<f>`). */
export function isFamilySlot(key: string): boolean {
  return key.split(":").includes(FAMILY_SEGMENT);
}

/** Lower-case, slot-safe: letters, digits and `. _ -`. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let upstreamSeeds: UpstreamSeedSource | undefined;

/** Register (or clear, with undefined) the upstream seed source. Returns the previous one. */
export function setUpstreamSeedSource(
  source: UpstreamSeedSource | undefined,
): UpstreamSeedSource | undefined {
  const prev = upstreamSeeds;
  upstreamSeeds = source;
  return prev;
}

type Listener = (r: DefaultResolution<unknown>) => void;
const listeners = new Set<Listener>();

/** Observe every resolution. Returns the unsubscribe function. */
export function onDefaultResolved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const RECENT_MAX = 64;
const recent = new Map<string, DefaultResolution<unknown>>();

/** The latest resolution per (surface, slot), newest last — for `benchmark defaults`. */
export function recentResolutions(): DefaultResolution<unknown>[] {
  return [...recent.values()];
}

function readSlot(
  db: DefaultSlotReader,
  key: string,
):
  | { kind: "unset" | "invalidated" | "unavailable" }
  | { kind: "value"; value: unknown; row: BenchmarkDefaultRow } {
  let row: BenchmarkDefaultRow | undefined;
  try {
    row = db.getBenchmarkDefault(key);
  } catch {
    // allow-empty-catch: a database without migration 147 has no promoted defaults
    return { kind: "unavailable" };
  }
  if (!row) return { kind: "unset" };
  if (row.incumbent_run_id && db.getBenchmarkRun?.(row.incumbent_run_id)?.status === "invalid") {
    return { kind: "invalidated" };
  }
  try {
    return { kind: "value", value: JSON.parse(row.value_json) as unknown, row };
  } catch {
    // allow-empty-catch: a malformed stored value reads as unusable; the next layer answers
    return { kind: "value", value: undefined, row };
  }
}

/** Resolve one default through env → local slot → family slots → upstream → built-in, traced. */
export function resolveDefault<T>(spec: DefaultSpec<T>): DefaultResolution<T> {
  const consulted: ConsultedLayer[] = [];
  const done = (
    value: T,
    source: DefaultSource,
    key: string,
    extra: { incumbentRunId?: string | null } = {},
  ): DefaultResolution<T> => {
    const skipped = consulted
      .filter((c) => c.outcome !== "answered")
      .map((c) => `${c.key} ${c.outcome === "withheld" ? "withheld pending approval" : c.outcome}`);
    const withheld = consulted.filter((c) => c.outcome === "withheld").map((c) => c.key);
    const r: DefaultResolution<T> = {
      slot: spec.slot,
      ...(spec.surface ? { surface: spec.surface } : {}),
      value,
      source,
      key,
      ...extra,
      ...(withheld.length ? { withheld } : {}),
      reason: `${source} ${key}${skipped.length ? ` (before it: ${skipped.join(", ")})` : ""}`,
      consulted,
    };
    publish(r as DefaultResolution<unknown>);
    return r;
  };

  if (spec.env) {
    if (spec.env.value !== undefined) {
      consulted.push({ layer: "env", key: spec.env.name, outcome: "answered" });
      return done(spec.env.value, "env", spec.env.name);
    }
    consulted.push({ layer: "env", key: spec.env.name, outcome: "unset" });
  }

  const slots: Array<{ layer: "slot" | "family"; key: string }> = [
    { layer: "slot", key: spec.board ? boardSlotKey(spec.slot, spec.board) : spec.slot },
  ];
  for (const f of spec.families ?? []) {
    slots.push({ layer: "family", key: familySlotKey(spec.slot, f) });
  }
  for (const s of slots) {
    if (!spec.db) {
      consulted.push({ layer: s.layer, key: s.key, outcome: "unavailable" });
      continue;
    }
    const found = readSlot(spec.db, s.key);
    if (found.kind !== "value") {
      consulted.push({ layer: s.layer, key: s.key, outcome: found.kind });
      continue;
    }
    const value = found.value === undefined ? undefined : spec.read(found.value);
    if (value === undefined) {
      consulted.push({ layer: s.layer, key: s.key, outcome: "unreadable" });
      continue;
    }
    consulted.push({ layer: s.layer, key: s.key, outcome: "answered" });
    return done(value, s.layer, s.key, { incumbentRunId: found.row.incumbent_run_id });
  }

  const seeds = upstreamSeeds ?? ledgerSeedSource(spec.db);
  if (seeds) {
    // The ledger's own seeds are traced only where one exists, so a world that
    // never imported a bundle resolves (and traces) exactly as before.
    const quietUnset = !upstreamSeeds;
    for (const s of slots) {
      let seed: UpstreamSeed | undefined;
      try {
        seed = seeds(s.key);
      } catch (err) {
        logger.warn("defaults", "upstream seed source failed", {
          slot: s.key,
          error: err instanceof Error ? err.message : String(err),
        });
        seed = undefined;
      }
      const value = seed ? spec.read(seed.value) : undefined;
      if (seed && value !== undefined) {
        const key = `${s.key}@upstream:${seed.version}`;
        if (withholdsUpstreamSeed(s.key)) {
          // A seed that chooses a model waits for a local person to adopt it.
          consulted.push({ layer: "upstream", key, outcome: "withheld" });
          continue;
        }
        consulted.push({ layer: "upstream", key, outcome: "answered" });
        return done(value, "upstream", key);
      }
      if (seed || !quietUnset)
        consulted.push({
          layer: "upstream",
          key: s.key,
          outcome: seed ? "unreadable" : "unset",
        });
    }
  }

  const label = spec.builtInLabel ?? "built-in";
  consulted.push({ layer: "builtin", key: label, outcome: "answered" });
  return done(spec.builtIn, "builtin", label);
}

/** The upstream seeds stored in `db` itself, when it can read them. */
function ledgerSeedSource(db: DefaultSlotReader | undefined): UpstreamSeedSource | undefined {
  const latest = db?.latestUpstreamDefaultSeed?.bind(db);
  if (!db || !latest) return undefined;
  const reader = {
    getBenchmarkDefault: db.getBenchmarkDefault.bind(db),
    latestUpstreamDefaultSeed: latest,
  };
  return (slotKey) => {
    const seed = upstreamSeedFor(reader, slotKey);
    return seed ? { value: seed.value, version: `${seed.artifactId}@${seed.version}` } : undefined;
  };
}

function publish(r: DefaultResolution<unknown>): void {
  const id = `${r.surface ?? ""}\u0000${r.slot}`;
  recent.delete(id);
  recent.set(id, r);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  logger.debug("defaults", "resolved", {
    slot: r.slot,
    surface: r.surface,
    source: r.source,
    key: r.key,
    reason: r.reason,
  });
  for (const l of listeners) {
    try {
      l(r);
    } catch (err) {
      logger.warn("defaults", "resolution listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** A short, content-free summary of a resolved value for events (ids, names, numbers). */
export function summarizeDefaultValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .map((v) => summarizeDefaultValue(v))
      .join(",")
      .slice(0, 160);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.label === "string") return o.label.slice(0, 160);
    if (typeof o.model === "string") return o.model.slice(0, 160);
  }
  return "(object)";
}
