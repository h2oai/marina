// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import type { InvestigationActor } from "../sdk/investigation-types";
import { InvestigationError } from "./validation";

/** Both residents and external clients have world accounts. Names resolve only after auth. */
export function investigationActor(db: MarinaDB, authenticatedName?: string): InvestigationActor {
  const user = authenticatedName ? db.getUserByName(authenticatedName) : undefined;
  if (!user)
    throw new InvestigationError(
      "account_required",
      "Sign in to a Marina account to use private investigations",
      403,
    );
  return { key: user.id, name: user.name };
}

export function investigationRecipient(db: MarinaDB, name: unknown): InvestigationActor {
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new InvestigationError("invalid_recipient", "Give an existing Marina account name");
  const user = db.getUserByName(name.trim());
  if (!user)
    throw new InvestigationError("invalid_recipient", "Recipient must have a Marina account");
  return { key: user.id, name: user.name };
}
