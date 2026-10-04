// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getErrorMessage } from "../engine/errors";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { ArenaData } from "./data";
import { forecastRound } from "./forecast";
import { forecastSettings } from "./forecast-config";
import type { HorizonMode } from "./research/civiqs-horizon";
import { type LiveCiviqs, nowcastForecaster } from "./research/civiqs-nowcast";

/** Compare statistical policies on shared archive/live inputs, with no model calls or filing. */
export async function recordHorizonShadows(
  store: Pick<ArenaStore, "recordArenaShadow">,
  data: ArenaData,
  roundIds: string[],
  opts: { live?: LiveCiviqs; now?: () => number; weeklyAnchor?: boolean } = {},
) {
  const now = opts.now ?? Date.now;
  const variants: Array<[HorizonMode, number, boolean?]> = [
    ["off", 0.8],
    ["drift", 0.8],
    ["drift", 1],
    ["sd", 0.8],
    ["both", 0.8],
  ];
  if (opts.weeklyAnchor) variants.push(["drift", 0.8, true], ["drift", 1, true]);
  const out: Array<{ roundId: string; variant?: string; recorded: boolean; error?: string }> = [];
  for (const roundId of roundIds) {
    try {
      const round = await data.round(roundId);
      if (round?.tracker !== "civiqs") throw new Error("expected a Civiqs round");
      if (now() >= Date.parse(round.lock_at)) throw new Error("already locked");
      const lock = await data.lock(roundId);
      const frozen = data.frozen();
      // Each tracker is read live once for this round. All candidates see its
      // same revision, including a profile's shared topline/subgroup reads.
      const liveReadings = new Map<string, ReturnType<LiveCiviqs>>();
      const live: LiveCiviqs | undefined =
        opts.live &&
        ((name, filters) => {
          const key = JSON.stringify([name, filters]);
          if (!liveReadings.has(key)) liveReadings.set(key, opts.live!(name, filters));
          return liveReadings.get(key)!;
        });
      const capturedAt = new Date(now()).toISOString();
      const candidates = await Promise.all(
        variants.map(async ([mode, phi, weeklyAnchor]) => {
          const f = await nowcastForecaster(frozen, forecastRound, {
            horizon: { mode, phi, ...(weeklyAnchor ? { weeklyAnchor } : {}) },
            ...(live ? { live } : {}),
          })(round, lock);
          const settings = forecastSettings("nowcast", {
            MARINA_ARENA_NOWCAST_HORIZON: mode,
            MARINA_ARENA_NOWCAST_DAMPING: String(phi),
            MARINA_ARENA_CIVIQS_LIVE: live ? "on" : "off",
          });
          if (weeklyAnchor) {
            settings.horizon.weeklyAnchor = true;
            const { fingerprint: _prior, ...policy } = settings;
            settings.fingerprint = createHash("sha256")
              .update(JSON.stringify(policy))
              .digest("hex");
          }
          return { f, settings, label: `nowcast#${settings.fingerprint.slice(0, 16)}` };
        }),
      );
      // A late batch records nothing: all variants must be prospective.
      if (now() >= Date.parse(round.lock_at)) throw new Error("comparison finished after lock");
      for (const { f, settings, label } of candidates) {
        const recorded = store.recordArenaShadow({
          roundId,
          forecaster: label,
          forecast: JSON.stringify({ topline: f.topline, profile: f.profile }),
          detail: JSON.stringify({ ...f, settings, capturedAt, lock }),
          costUsd: 0,
        });
        out.push({
          roundId,
          variant: `${settings.horizon.mode}:${settings.horizon.phi}${settings.horizon.weeklyAnchor ? ":weekly" : ""}`,
          recorded,
        });
      }
    } catch (err) {
      out.push({
        roundId,
        recorded: false,
        error: getErrorMessage(err),
      });
    }
  }
  return out;
}
