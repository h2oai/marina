// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * memory-map-admin-link -- The MEMORY layer's only "action": hand off to the
 * Admin → Memory tab.
 *
 * ## `marina:open-admin` (window CustomEvent)
 *
 * Dispatched on `window` when an operator clicks an action link in the memory
 * inspector. Any admin surface (the unified AdminPanel, the dashboard
 * `components/` AdminPanel, a future standalone route) may listen and route:
 *
 * ```ts
 * window.addEventListener("marina:open-admin", (e) => {
 *   const { tab, jobId, recordId, spaceId, resolutionId } =
 *     (e as CustomEvent<OpenAdminDetail>).detail;
 *   // open the admin panel on `tab`, optionally deep-linking the object
 * });
 * ```
 *
 * `detail.tab` is always present; the id fields are optional deep-link hints.
 * The event is fire-and-forget: if nothing listens, the memory inspector shows
 * a small "no admin surface is listening" hint so the operator isn't left
 * wondering. Detect listeners by having the receiver call
 * `event.preventDefault()` — `openAdminMemory` returns `false` in that case
 * (handled) and `true` when the event went unhandled.
 */

export interface OpenAdminDetail {
  tab: "memory" | string;
  jobId?: string;
  recordId?: string;
  spaceId?: string;
  resolutionId?: string;
}

export const OPEN_ADMIN_EVENT = "marina:open-admin";

/**
 * Dispatch `marina:open-admin` for the Memory tab.
 *
 * @returns `true` when NO listener claimed the event (i.e. it fell through) —
 *          callers use this to degrade gracefully with an inline hint.
 */
export function openAdminMemory(detail: Omit<OpenAdminDetail, "tab"> = {}): boolean {
  if (typeof window === "undefined") return true;
  const event = new CustomEvent<OpenAdminDetail>(OPEN_ADMIN_EVENT, {
    detail: { tab: "memory", ...detail },
    cancelable: true,
  });
  const notCancelled = window.dispatchEvent(event);
  return notCancelled;
}
