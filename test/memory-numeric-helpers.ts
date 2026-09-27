// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MarinaDB } from "../src/persistence/database";
import { findNumericRelation } from "../src/persistence/db-memory-numeric";
export const findDurableRelation = (
  db: MarinaDB,
  owner: string,
  source: string,
  relationship: string,
  target: string,
) => findNumericRelation(db.memoryRepository().raw, owner, source, relationship, target);
