// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { availableInstant } from "../research/measurement";

export interface ReadingVintage {
  series: string;
  date: string;
  value: number;
  availableAt: string;
  source: string;
}

/** Diagnostic only: revised history is not the same as real-time forecast error. */
export function revisionInventory(readings: ReadingVintage[], asOf: string) {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new Error("invalid revision cutoff");
  const groups = new Map<string, ReadingVintage[]>();
  let unavailable = 0;
  for (const reading of readings) {
    if (
      !Number.isFinite(reading.value) ||
      !Number.isFinite(Date.parse(reading.date)) ||
      availableInstant(reading.availableAt) === undefined ||
      Date.parse(reading.date) > availableInstant(reading.availableAt)! ||
      !reading.series ||
      !reading.source
    )
      throw new Error("invalid reading vintage");
    if (availableInstant(reading.availableAt)! >= cutoff) {
      unavailable++;
      continue;
    }
    const key = JSON.stringify([reading.series, reading.date]);
    const values = groups.get(key) ?? [];
    const previous = values.find((r) => r.availableAt === reading.availableAt);
    if (previous && previous.value !== reading.value)
      throw new Error("conflicting reading vintage");
    if (!previous) values.push({ ...reading });
    groups.set(key, values);
  }
  const observations = [...groups.values()].map((values) => {
    values.sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt));
    const first = values[0]!;
    const last = values.at(-1)!;
    return {
      series: first.series,
      date: first.date,
      first,
      last,
      vintages: values.length,
      revision: last.value - first.value,
      maxAbsoluteRevision: Math.max(...values.map((r) => Math.abs(r.value - first.value))),
    };
  });
  return {
    asOf,
    unavailable,
    observations,
    changed: observations.filter((o) => o.maxAbsoluteRevision > 0).length,
  };
}
