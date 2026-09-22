// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * HygieneTrends -- the "Continuous hygiene" body: the live ratio cards from
 * the overview PLUS their history from `GET /api/memory/hygiene/history`
 * (one snapshot per hourly tick, or on demand via `POST …/snapshot`).
 *
 * The history endpoint is privileged: residents get a 403, in which case the
 * trends are hidden behind a one-line note and the live ratios still render.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { describeApiError, fetchApi, postApi } from "../../lib/api";
import type {
  MemoryHygieneHistory,
  MemoryHygieneRatios,
} from "../../lib/memory-observability-types";
import { formatAge } from "./format";
import { RatiosSection } from "./RatiosSection";

export const HYGIENE_HISTORY_KEY = ["memory-hygiene-history"] as const;
export const HYGIENE_SNAPSHOT_PATH = "/api/memory/hygiene/snapshot";

export const TREND_RANGES = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;
export const DEFAULT_TREND_HOURS = 168;

export const TRENDS_EMPTY_TEXT =
  "No snapshots yet — the hourly tick writes one; Snapshot now to start";
export const TRENDS_FORBIDDEN_TEXT =
  "Trend history is operator-only — the live ratios above still apply.";

export function hygieneHistoryUrl(hours: number): string {
  return `/api/memory/hygiene/history?hours=${hours}`;
}

/** `fetchApi` throws `Error("API error: 403")` for a resident without privilege. */
export function isForbiddenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b403\b/.test(message);
}

export function HygieneTrends({ ratios }: { ratios: MemoryHygieneRatios }) {
  const [hours, setHours] = useState<number>(DEFAULT_TREND_HOURS);
  const queryClient = useQueryClient();
  const history = useQuery<MemoryHygieneHistory>({
    queryKey: [...HYGIENE_HISTORY_KEY, hours],
    queryFn: () => fetchApi<MemoryHygieneHistory>(hygieneHistoryUrl(hours)),
    // The hourly tick is the only writer besides "Snapshot now" — no need to hammer it.
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const forbidden = history.error ? isForbiddenError(history.error) : false;
  const samples = history.data?.samples ?? [];
  const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;

  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string>();
  const snapshot = useCallback(async () => {
    setSnapshotting(true);
    setSnapshotError(undefined);
    try {
      await postApi(HYGIENE_SNAPSHOT_PATH);
      await queryClient.invalidateQueries({ queryKey: [...HYGIENE_HISTORY_KEY] });
    } catch (cause) {
      setSnapshotError(describeApiError(cause));
    } finally {
      setSnapshotting(false);
    }
  }, [queryClient]);

  let status: string;
  if (forbidden) status = TRENDS_FORBIDDEN_TEXT;
  else if (history.error) status = `Trend history unavailable (${describeApiError(history.error)})`;
  else if (history.isLoading) status = "Loading trend history…";
  else if (!latest) status = TRENDS_EMPTY_TEXT;
  else
    status = `${samples.length} snapshot${samples.length === 1 ? "" : "s"} · latest ${formatAge(latest.at)} ago`;

  return (
    <div className="space-y-2">
      <div
        role="toolbar"
        aria-label="Hygiene trends"
        className="flex flex-wrap items-center gap-1 text-[9px] text-text-dim"
      >
        <span className="uppercase">trend</span>
        {!forbidden && (
          <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0" aria-label="Trend range">
            {TREND_RANGES.map((range) => (
              <button
                key={range.hours}
                type="button"
                aria-pressed={hours === range.hours}
                onClick={() => setHours(range.hours)}
                className={`rounded border px-1.5 py-0.5 transition-colors ${
                  hours === range.hours
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-text-dim hover:text-text"
                }`}
              >
                {range.label}
              </button>
            ))}
          </fieldset>
        )}
        <span data-testid="trend-status" className={forbidden ? "" : "ml-1"}>
          {status}
        </span>
        {!forbidden && (
          <button
            type="button"
            disabled={snapshotting}
            onClick={() => void snapshot()}
            className="ml-auto rounded border border-border px-1.5 py-0.5 text-text hover:border-primary hover:text-primary disabled:opacity-50"
            title="Take a hygiene snapshot now (POST /api/memory/hygiene/snapshot)"
          >
            {snapshotting ? "Snapshotting…" : "Snapshot now"}
          </button>
        )}
        {snapshotError && (
          <span role="alert" className="text-danger">
            {snapshotError}
          </span>
        )}
      </div>
      <RatiosSection ratios={ratios} samples={!forbidden && latest ? samples : undefined} />
    </div>
  );
}
