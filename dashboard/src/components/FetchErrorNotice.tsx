// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, RefreshCw } from "lucide-react";

interface FetchErrorNoticeProps {
  /** Human name of the resource, e.g. "feed" or "graph". */
  what: string;
  /** Error message recorded by the store's snapshot loader. */
  error: string;
  /** Re-runs the snapshot fetch. */
  onRetry: () => void;
}

/**
 * Inline "Couldn't load <what>: <error> — retry" line for panels whose data
 * comes from a one-shot REST snapshot (`/api/feed`, `/api/graph`). Without it
 * an unreachable backend is indistinguishable from "nothing has happened yet".
 */
export function FetchErrorNotice({ what, error, onRetry }: FetchErrorNoticeProps) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-1.5 rounded border border-red-400/40 bg-red-400/10 px-2 py-1.5 text-[11px] text-text"
    >
      <AlertTriangle size={11} className="shrink-0 text-red-400" />
      <span className="min-w-0 break-words">
        Couldn't load {what}: <span className="text-red-300">{error}</span>
      </span>
      <span className="text-text-dim">—</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-text transition-colors hover:text-primary"
      >
        <RefreshCw size={10} />
        retry
      </button>
    </div>
  );
}
