// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { LearningJournal } from "../learning/journal";
import type { MarinaDB } from "../persistence/database";

/** First durable result wins. The delivery coordinator serializes local passes. */
export function outcomeLearningJournal(
  db: MarinaDB,
  outcomeId: number,
  prefix = "v1",
): LearningJournal {
  const name = (step: string) => `${prefix}/${step}`;
  return {
    bindSpace: (space) => db.bindOutcomeLearningSpace(outcomeId, space),
    key: (step) => `outcome:${outcomeId}:${createHash("sha256").update(name(step)).digest("hex")}`,
    child: (step) => outcomeLearningJournal(db, outcomeId, name(step)),
    has: (step) => !!db.getOutcomeLearningStep(outcomeId, name(step)),
    async run<T>(step: string, action: () => Promise<T>, keep?: (value: T) => boolean) {
      const saved = db.getOutcomeLearningStep(outcomeId, name(step));
      if (saved) return (JSON.parse(saved.value_json) as { value: T }).value;
      const value = await action();
      if (keep && !keep(value)) return value;
      db.saveOutcomeLearningStep(outcomeId, name(step), JSON.stringify({ value }));
      return (
        JSON.parse(db.getOutcomeLearningStep(outcomeId, name(step))!.value_json) as {
          value: T;
        }
      ).value;
    },
  };
}
