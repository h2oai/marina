// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** HTTP clients need an absolute base even when the desktop uses views://.
 * This reserved origin is handled by the native RPC adapter, never a server. */
export function apiOrigin(
  location: Pick<Location, "protocol" | "origin"> = window.location,
): string {
  return location.protocol === "views:" ? "http://marina.desktop.invalid" : location.origin;
}
