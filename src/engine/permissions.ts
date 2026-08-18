// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Entity, EntityRank } from "../types";
import { RANK_NAMES } from "../types";

export function getRank(entity: Entity): EntityRank {
  const rank = entity.properties.rank;
  if (typeof rank === "number" && rank >= 0 && rank <= 9) return rank as EntityRank;
  return 0;
}

export function setRank(entity: Entity, rank: EntityRank): void {
  entity.properties.rank = rank;
}

export function requireRank(entity: Entity, min: EntityRank): boolean {
  return getRank(entity) >= min;
}

export function rankName(rank: EntityRank): string {
  return RANK_NAMES[rank] ?? "unknown";
}
