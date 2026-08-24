// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const MAX_TRACE_ID_LENGTH = 200;

export function traceIdFromSearch(search: string): string | undefined {
  const traceId = new URLSearchParams(search).get("trace")?.trim();
  if (
    !traceId ||
    traceId.length > MAX_TRACE_ID_LENGTH ||
    [...traceId].some((character) => character.charCodeAt(0) < 32)
  ) {
    return undefined;
  }
  return traceId;
}

export function tracePermalink(traceId: string, currentUrl: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set("trace", traceId);
  url.hash = "";
  return url.toString();
}
