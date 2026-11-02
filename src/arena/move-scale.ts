// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The move scale a formation's start carries into the arena filing path.
 *
 * A formation judges every member's move against its start: a proposal
 * further than `MAX_PROPOSAL_SD_MOVE` scales away is a blowup and dropped, the
 * settled mean never moves more than `MAX_FINAL_SD_MOVE` scales, and agreement
 * reads the dispersion of the moves in scales. Until 2026-11 that scale was
 * the start SD — which says how uncertain the start is, not how far the series
 * moves in a step. After a Google Trends spike the nowcast sd of the spiked
 * cell was 0.9 while the plausible reversion was 8 points: every member called
 * the reversion, every call was "beyond 4 start sd", and persistence filed
 * (trends-basket-2026-10-31: skill 0.07 against the panel's 0.78).
 *
 * The scale is now the series' own: the typical large one-step change over
 * its published history (`seriesMoveScale`, the verification band's
 * quantile), never below the start sd. It rides on the START the service hands
 * the formation (`RoundForecast.moveScale`), so a formation called without one
 * — the pinned legacy run, a bare test — behaves exactly as before.
 */

import { seriesMoveScale } from "../orchestration/formations/combine-numeric";
import type { RoundForecast } from "./forecast";
import { cellHistories } from "./profile-shape";
import type { ArenaLock, ArenaRound } from "./types";

/**
 * `start` with the series' (or each cell's) move scale from the lock's
 * published history. A start with nothing to scale (a ranking) is returned as
 * given; a scale equal to the sd is still recorded, so the filing's detail
 * says what the formation judged moves against.
 */
export function withSeriesMoveScale(
  round: ArenaRound,
  lock: ArenaLock,
  start: RoundForecast,
): RoundForecast {
  const moveScale: NonNullable<RoundForecast["moveScale"]> = {};
  if (start.topline) {
    const history = lock.answer_history ?? lock.history ?? [];
    moveScale.topline = seriesMoveScale(
      start.topline.sd,
      history.map((p) => p.value),
    );
  }
  if (start.profile) {
    const histories = cellHistories(round, lock);
    const cells: Record<string, number> = {};
    for (const [cell, d] of Object.entries(start.profile)) {
      cells[cell] = seriesMoveScale(
        d.sd,
        (histories[cell] ?? []).map((p) => p.value),
      );
    }
    moveScale.cells = cells;
  }
  return moveScale.topline === undefined && moveScale.cells === undefined
    ? start
    : { ...start, moveScale };
}
