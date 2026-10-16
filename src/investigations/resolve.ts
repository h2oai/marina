// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolveForecast } from "../outcomes/forecast";
import type { MarinaDB } from "../persistence/database";
import type { InvestigationActor } from "../sdk/investigation-types";
import { InvestigationError } from "./validation";

export function resolveInvestigation(
  db: MarinaDB,
  actor: InvestigationActor,
  id: string,
  value: unknown,
) {
  return db.transaction(() => {
    const answerId = db.investigationResolutionTarget(actor.key, id);
    const result = resolveForecast(db, answerId, value, Date.now(), { resolvedBy: actor.name });
    if (!result)
      throw new InvestigationError(
        "invalid_outcome",
        "Already resolved, or the outcome does not match the answer format",
        409,
      );
    db.recordInvestigationResolution(actor, id);
    return result;
  });
}
