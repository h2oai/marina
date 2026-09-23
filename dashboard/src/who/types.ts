// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract surface for the /who pages. The wire shape is the backend's
 * `src/net/entity-profile-types.ts`, re-exported type-only through
 * `../lib/entity-profile-types` — there is no hand-maintained mirror to drift.
 * Only dashboard-side derived helpers live here.
 */

export type {
  Achievement,
  ChronicleEntry,
  ChronicleKind,
  EntityProfile,
} from "../lib/entity-profile-types";

import type { EntityProfile as Profile } from "../lib/entity-profile-types";

/** The `identity` block of a profile (derived, so it follows the contract). */
export type EntityIdentity = Profile["identity"];

/** One `connections` row (derived). */
export type EntityConnection = Profile["connections"][number];

/** Viewport width (px) at or below which the profile renders single-column. */
export const NARROW_LAYOUT_MAX_WIDTH = 640;

/** The media query the page consults for its narrow layout. */
export const NARROW_LAYOUT_QUERY = `(max-width: ${NARROW_LAYOUT_MAX_WIDTH}px)`;
