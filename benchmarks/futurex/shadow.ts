// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shadow challengers for live FutureX rows (`src/forecast/shadow.ts`). A
 * FutureX answer is filed only at learn time, once its row resolves, so its
 * shadow is filed when the answer is ADOPTED as the row's standing answer
 * (the one the submission carries) and settled by `learn` with the same
 * resolution. The map `shadows.json` beside the standing answers says which
 * shadow belongs to which row. A later revision of the standing answer closes
 * the old shadow as superseded (it no longer pairs with what was submitted);
 * a row that is never filed (a fallback) closes it too. Only the `earned`
 * variant plans shadows (`typedForecastFor`); sampling, caps and backtest
 * isolation are the core's. The submitted answer is never touched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  drainForecastShadows,
  settleBoardShadow,
  startBoardShadow,
  supersedeShadow,
} from "../../src/forecast/shadow";
import type { MarinaDB } from "../../src/persistence/database";
import type { RowResult } from "./run";

const mapPath = (out: string) => join(out, "shadows.json");

export function loadShadowMap(out: string): Record<string, number> {
  try {
    return existsSync(mapPath(out))
      ? (JSON.parse(readFileSync(mapPath(out), "utf8")) as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Shadows for rows whose standing answer was just adopted: any earlier shadow
 * of the row is superseded, then a shadow is started for the new answer when
 * one was planned and the gate lets it run. Waits for them and records the
 * filed ones in `shadows.json`.
 */
export async function startAdoptedShadows(
  db: MarinaDB,
  out: string,
  label: string,
  adopted: readonly RowResult[],
  opts: { draw?: () => number; now?: number } = {},
): Promise<{ started: number; filed: number }> {
  const map = loadShadowMap(out);
  let started = 0;
  let filed = 0;
  const pending: Array<Promise<void>> = [];
  for (const r of adopted) {
    const old = map[r.id];
    if (old !== undefined) {
      supersedeShadow(db, old, opts.now);
      delete map[r.id];
    }
    if (r.fallback || !r.answer) continue;
    const s = startBoardShadow(db, r.answer, `futurex/${label}:${r.id}`, {
      ...(opts.draw ? { draw: opts.draw() } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (!s.started) continue;
    started++;
    pending.push(
      s.done.then((d) => {
        if (d.status !== "filed") return;
        map[r.id] = d.answerId;
        filed++;
      }),
    );
  }
  await Promise.all(pending);
  await drainForecastShadows();
  writeFileSync(mapPath(out), JSON.stringify(map));
  return { started, filed };
}

/**
 * At learn time: settle the row's shadow on its live answer's resolution, or
 * close it when the live answer is not filed (a fallback). False when the row
 * has no open shadow.
 */
export function settleRowShadow(
  db: MarinaDB,
  out: string,
  rowId: string,
  resolution: { value: unknown; resolvedAt: number } | "unfiled",
): boolean {
  const id = loadShadowMap(out)[rowId];
  if (id === undefined) return false;
  if (resolution === "unfiled") {
    supersedeShadow(db, id, Date.now());
    return false;
  }
  return settleBoardShadow(db, id, resolution.value, resolution.resolvedAt);
}
