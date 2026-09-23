// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sparkline -- a tiny inline-SVG trend line for the hygiene ratio cards.
 *
 * `values` are ordered oldest → newest; a `null` is a gap (denominator was 0
 * at that snapshot), so the line breaks rather than dipping to zero. The
 * latest non-null point is highlighted and the `<title>` carries
 * "min · max · latest" so hovering reads the numbers the line summarizes.
 * Strokes use `currentColor` — the caller's text tone class colors the line,
 * which keeps it theme-aware without a chart library.
 */

const VIEW_W = 100;
const VIEW_H = 24;
const PAD = 2;

export interface SparklineStats {
  min: number;
  max: number;
  latest: number;
  points: number;
  gaps: number;
}

/** Summary of the non-null values, or null when every sample is a gap. */
export function sparklineStats(values: readonly (number | null)[]): SparklineStats | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let latest: number | null = null;
  let points = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    points += 1;
    latest = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (latest === null) return null;
  return { min, max, latest, points, gaps: values.length - points };
}

/** Consecutive non-null runs as index lists — each becomes one polyline. */
function runs(values: readonly (number | null)[]): number[][] {
  const result: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) result.push(current);
      current = [];
      return;
    }
    current.push(index);
  });
  if (current.length > 0) result.push(current);
  return result;
}

export function Sparkline({
  values,
  format,
  label,
  className,
  testId,
}: {
  values: readonly (number | null)[];
  /** Renders a value for the tooltip (e.g. "12%" or "3.0×"). */
  format: (value: number) => string;
  /** Human label used in the tooltip and the accessible name. */
  label: string;
  className?: string;
  testId?: string;
}) {
  const stats = sparklineStats(values);
  const title = stats
    ? `${label}: min ${format(stats.min)} · max ${format(stats.max)} · latest ${format(stats.latest)}`
    : `${label}: no samples`;

  const n = values.length;
  const x = (index: number) =>
    n <= 1 ? VIEW_W - PAD : PAD + (index / (n - 1)) * (VIEW_W - 2 * PAD);
  const y = (value: number) => {
    if (!stats || stats.max === stats.min) return VIEW_H / 2;
    return PAD + (1 - (value - stats.min) / (stats.max - stats.min)) * (VIEW_H - 2 * PAD);
  };

  let latestIndex = -1;
  for (let index = n - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      latestIndex = index;
      break;
    }
  }

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className={className}
      data-testid={testId}
      data-points={stats?.points ?? 0}
      data-gaps={stats ? stats.gaps : n}
    >
      <title>{title}</title>
      {stats &&
        runs(values).map((run) =>
          run.length === 1 ? (
            <circle
              key={`lone-${run[0]}`}
              data-lone=""
              cx={x(run[0]!)}
              cy={y(values[run[0]!] as number)}
              r={1.2}
              fill="currentColor"
              opacity={0.7}
            />
          ) : (
            <polyline
              key={`run-${run[0]}`}
              data-run=""
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={0.7}
              points={run.map((index) => `${x(index)},${y(values[index] as number)}`).join(" ")}
            />
          ),
        )}
      {stats && latestIndex >= 0 && (
        <circle
          data-latest=""
          cx={x(latestIndex)}
          cy={y(values[latestIndex] as number)}
          r={2}
          fill="currentColor"
        />
      )}
    </svg>
  );
}
