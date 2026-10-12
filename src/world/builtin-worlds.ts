// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Explicit imports let Bun include built-in worlds in the standalone CLI.
// The parity test keeps this catalog aligned with worlds/ and its shared rooms.
import type { RoomModule } from "../types";
import type { WorldDefinition } from "./world-definition";

export const BUILTIN_WORLDS: Record<string, () => Promise<{ default: WorldDefinition }>> = {
  commons: () => import("../../worlds/commons"),
  craft: () => import("../../worlds/craft"),
  "data-investigation": () => import("../../worlds/data-investigation"),
  "deep-research": () => import("../../worlds/deep-research"),
  default: () => import("../../worlds/default"),
  demos: () => import("../../worlds/demos"),
  "due-diligence": () => import("../../worlds/due-diligence"),
  empty: () => import("../../worlds/empty"),
  evolve: () => import("../../worlds/evolve"),
  markets: () => import("../../worlds/markets"),
  personal: () => import("../../worlds/personal"),
  "prediction-lab": () => import("../../worlds/prediction-lab"),
  "red-team": () => import("../../worlds/red-team"),
  research: () => import("../../worlds/research"),
  showcase: () => import("../../worlds/showcase"),
};

const SHARED_ROOMS: Record<string, () => Promise<{ default: RoomModule }>> = {
  "agent/modes": () => import("../../worlds/default/agent/modes"),
  "analysis/room": () => import("../../worlds/default/analysis/room"),
  "audit/room": () => import("../../worlds/default/audit/room"),
  "bench/arena": () => import("../../worlds/default/bench/arena"),
  "channels/hub": () => import("../../worlds/default/channels/hub"),
  commons: () => import("../../worlds/default/commons"),
  "coord/center": () => import("../../worlds/default/coord/center"),
  "coord/tasks": () => import("../../worlds/default/coord/tasks"),
  "craft/forge": () => import("../../worlds/default/craft/forge"),
  "craft/review": () => import("../../worlds/default/craft/review"),
  "craft/studio": () => import("../../worlds/default/craft/studio"),
  "debug/room": () => import("../../worlds/default/debug/room"),
  "eval/chamber": () => import("../../worlds/default/eval/chamber"),
  "hub/crossroads": () => import("../../worlds/default/hub/crossroads"),
  "integration/bay": () => import("../../worlds/default/integration/bay"),
  "knowledge/hub": () => import("../../worlds/default/knowledge/hub"),
  "markets/desk": () => import("../../worlds/default/markets/desk"),
  "markets/floor": () => import("../../worlds/default/markets/floor"),
  "memory/vault": () => import("../../worlds/default/memory/vault"),
  observatory: () => import("../../worlds/default/observatory"),
  "ops/launch": () => import("../../worlds/default/ops/launch"),
  "projects/room": () => import("../../worlds/default/projects/room"),
  "research/lab": () => import("../../worlds/default/research/lab"),
  "strategy/room": () => import("../../worlds/default/strategy/room"),
  "system/config": () => import("../../worlds/default/system/config"),
};

export async function loadBuiltinWorld(slug: string): Promise<WorldDefinition> {
  if (!Object.hasOwn(BUILTIN_WORLDS, slug)) throw new Error(`World "${slug}" not found`);
  const world = (await BUILTIN_WORLDS[slug]!()).default;
  if (!world.roomsDir) return world;
  // The built-ins currently share worlds/default. Fail explicitly if a new
  // directory is introduced without adding it to the compiled catalog.
  if (!world.roomsDir.replaceAll("\\", "/").endsWith("/default"))
    throw new Error(`World "${slug}" has an unpackaged rooms directory`);
  const rooms = { ...world.rooms };
  for (const [id, load] of Object.entries(SHARED_ROOMS)) rooms[id] = (await load()).default;
  return { ...world, rooms, roomsDir: undefined };
}
