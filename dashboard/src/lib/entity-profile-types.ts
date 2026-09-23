// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard view of the `GET /api/entity/:name/profile` contract behind the
 * `/who/<name>` pages. Re-exported type-only from the backend's single source
 * of truth, `src/net/entity-profile-types.ts` (dependency-free, so this pulls
 * nothing else from `src/` into the dashboard bundle or its `tsc` pass).
 * `src/__tests__/entity-profile-contract.test.ts` pins the `who/types.ts`
 * surface to these shapes.
 */

export type {
  Achievement,
  ChronicleEntry,
  ChronicleKind,
  EntityProfile,
} from "../../../src/net/entity-profile-types";
