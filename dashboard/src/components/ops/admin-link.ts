// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Header → Admin hand-off. Dispatches the cancelable `marina:open-admin`
 * window event the AdminPanel (and the unified CommandBar) listen for; a
 * receiver calls `preventDefault()` to claim it. Returns true when claimed so
 * a caller can fall back to an inline hint when no admin surface is mounted.
 */

export const OPEN_ADMIN_EVENT = "marina:open-admin";

/** Alias the AdminPanel maps onto the tab that renders readiness. */
export const READINESS_TAB = "readiness";
export const OPS_TAB = "ops";

export function openAdminTab(tab: string, detail: Record<string, unknown> = {}): boolean {
  const event = new CustomEvent(OPEN_ADMIN_EVENT, {
    cancelable: true,
    detail: { tab, ...detail },
  });
  return !window.dispatchEvent(event);
}
