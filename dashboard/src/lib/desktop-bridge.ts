// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Native helpers the desktop shell installs before the dashboard loads
 * (`marina-desktop/src/views/dashboard/rpc-shim.ts`). The shell patches
 * `fetch`, so ordinary requests need nothing from here; this covers what a
 * patched `fetch` cannot express — byte progress and cancel for an upload body.
 * Present only on the desktop shell's `views:` page.
 */

export interface DesktopBodyRequest {
  /** Absolute API URL (`apiOrigin()` + path). */
  url: string;
  method: string;
  headers?: Record<string, string>;
  body: FormData | Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
  /** Fraction of the body's bytes handed to the native process so far. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface MarinaDesktopBridge {
  /** Send a binary request body to the local server; resolves with its response. */
  sendBody(request: DesktopBodyRequest): Promise<Response>;
}

declare global {
  interface Window {
    marinaDesktop?: MarinaDesktopBridge;
  }
}

/** The desktop bridge, when this page is the desktop shell and installed one. */
export function desktopBridge(
  location: Pick<Location, "protocol"> = window.location,
): MarinaDesktopBridge | undefined {
  return location.protocol === "views:" ? window.marinaDesktop : undefined;
}
