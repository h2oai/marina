// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Static world registry for the desktop app.
 *
 * The server (`src/main.ts`) selects a world at runtime via the
 * `MARINA_WORLD` env var and a template-string dynamic import. The desktop's
 * bun process is bundled by Electrobun, so a template-string import can't be
 * statically resolved — we import every world up front and look it up by name.
 *
 * Keep this list in sync with `worlds/` (minus `seed.ts`). Without a world the
 * engine boots empty: no rooms, no seeded traits/roles/projects/markets.
 */
import type { WorldDefinition } from "../../../src/world/world-definition";
import commons from "../../../worlds/commons";
import craft from "../../../worlds/craft";
import defaultWorld from "../../../worlds/default";
import demos from "../../../worlds/demos";
import empty from "../../../worlds/empty";
import evolve from "../../../worlds/evolve";
import markets from "../../../worlds/markets";
import personal from "../../../worlds/personal";
import research from "../../../worlds/research";
import showcase from "../../../worlds/showcase";

export const WORLDS: Record<string, WorldDefinition> = {
  default: defaultWorld,
  showcase,
  commons,
  research,
  personal,
  evolve,
  craft,
  markets,
  demos,
  empty,
};

export const DEFAULT_WORLD = "default";

/** Available world names, for menus / preferences UIs. */
export function worldNames(): string[] {
  return Object.keys(WORLDS);
}

/** Resolve a world by name, falling back to the default world. */
export function resolveWorld(name: string | undefined): WorldDefinition {
  return WORLDS[name ?? DEFAULT_WORLD] ?? WORLDS[DEFAULT_WORLD]!;
}
