// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic resolution: answers linked to a market (`resolves:<venue>/<ticker>`,
 * `forecast track`, `POST /v1/forecast` with `resolves`) are checked on a
 * schedule instead of waiting for someone to run `probe`. A resolved market is
 * written as a Sample exactly as `probe` writes it, so the calibration finder
 * settles every answer waiting on it through `resolveForecast`.
 *
 * Bounded: at most `max` markets per pass, oldest waiting answer first; only
 * a `resolved` reading is written (an open market leaves no note behind).
 * Public market reads only (Kalshi, Polymarket); `MARINA_OUTCOME_AUTORESOLVE=off`
 * turns it off.
 */

import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import { parseSampleId } from "../resolvers/calibration";
import { getResolver } from "../resolvers/registry";
import { findLatestSample, writeSample } from "../resolvers/sample-writer";
import type { EngineEvent } from "../types";

const logger = new Logger();

/** Markets checked per pass. */
export const AUTORESOLVE_MAX = 20;
/** The resolver kind for market-linked answers. */
const KIND = "resolving";

export function autoresolveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_OUTCOME_AUTORESOLVE?.trim().toLowerCase() !== "off";
}

export interface AutoresolveReport {
  checked: number;
  resolved: number;
  open: number;
  errors: number;
  /** Linked ids no registered resolver reads (e.g. an unknown venue). */
  unsupported: number;
}

export async function autoresolveLinked(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number; emitEvent?: (e: EngineEvent) => void } = {},
): Promise<AutoresolveReport> {
  const report: AutoresolveReport = { checked: 0, resolved: 0, open: 0, errors: 0, unsupported: 0 };
  if (!autoresolveEnabled(opts.env)) return report;
  const resolver = getResolver(KIND);
  if (!resolver) return report;
  for (const id of db.openLinkedSampleIds(opts.max ?? AUTORESOLVE_MAX)) {
    const parts = parseSampleId(id);
    const parsed = parts ? resolver.parseArgs(parts) : undefined;
    if (!parsed?.ok || resolver.idFromArgs(parsed.args) !== id) {
      report.unsupported++;
      continue;
    }
    report.checked++;
    const previous = findLatestSample(db, KIND, id);
    let output: Awaited<ReturnType<typeof resolver.resolve>>;
    try {
      output = await resolver.resolve({
        args: parsed.args,
        previousSample: previous?.sample,
        ctx: { db },
      });
    } catch (err) {
      output = { status: "error", reason: (err as Error).message };
    }
    if (output.status === "resolved") {
      writeSample({
        db,
        sample: {
          kind: KIND,
          id,
          ts: Date.now(),
          status: "resolved",
          value: output.value,
          source: output.source,
          ...(output.rawHash ? { rawHash: output.rawHash } : {}),
        },
        ...(previous?.noteId ? { previousSampleNoteId: previous.noteId } : {}),
        ...(opts.emitEvent ? { emitEvent: opts.emitEvent } : {}),
      });
      report.resolved++;
    } else if (output.status === "error") report.errors++;
    else report.open++;
  }
  if (report.errors) logger.warn("main", "automatic resolution: some markets failed", { report });
  return report;
}
