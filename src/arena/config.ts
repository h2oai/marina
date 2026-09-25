// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Arena participation is env-only and OFF by default: nothing in-world can
 * register Marina, choose its entrant id, or point it at a key. The private key
 * lives in a file only the server user can read; the environment names the
 * file, never the key.
 */

import { readFileSync, statSync } from "node:fs";
import { DEFAULT_ARENA_DATA_URL } from "./data";
import { DEFAULT_AUDIENCE, DEFAULT_ORIGIN, loadPrivateKey } from "./protocol";

export const ENTRANT_ID = /^[a-z0-9][a-z0-9_.-]{1,47}$/;

export interface ArenaConfig {
  /** `MARINA_ARENA_ENTRANT` — the permanent id registered in `entrants/<id>.json`. */
  entrant: string;
  /** `MARINA_ARENA_KEY_FILE` — PKCS#8 PEM or raw 32-byte Ed25519 seed, mode 0600. */
  keyFile?: string;
  /** `MARINA_ARENA_KEY_ID` — the registration key id (default `k1`). */
  keyId: string;
  /** `MARINA_ARENA_URL` — intake origin (default the arena; a rehearsal fork overrides it). */
  origin: string;
  /** `MARINA_ARENA_AUDIENCE` — must match the intake's audience (default production). */
  audience: string;
  /** `MARINA_ARENA_DATA_URL` — where round definitions, locks and resolutions are read. */
  dataUrl: string;
  /** `MARINA_ARENA_AUTOPILOT=on` — file due rounds automatically from the hourly tick. */
  autopilot: boolean;
  /** `MARINA_ARENA_WINDOW_HOURS` — file when a round's lock is this close (default 24, the arena's call window). */
  windowHours: number;
  /** `MARINA_ARENA_FORECASTER` — `baseline` (default) or `model:<provider/model>`. */
  forecaster: string;
  /** `MARINA_ARENA_MODEL_WEIGHT` — share of a model's move from the baseline kept (default 0.5). */
  modelWeight: number;
}

const MODEL_ID = "[a-z0-9-]+\\/[\\w.:/-]+";
const FORECASTER_SPEC = new RegExp(
  `^(baseline|model:${MODEL_ID}|crew:${MODEL_ID}(,${MODEL_ID}){0,2})$`,
  "i",
);

/**
 * `baseline`, `model:<provider/model>`, or `crew:<model>` / `crew:<statistician>,<analyst>,<skeptic>`
 * (one vendor per role). Validated here; model ids are resolved at use.
 */
export function parseForecasterSpec(raw: string | undefined): string {
  const spec = raw?.trim() || "baseline";
  if (FORECASTER_SPEC.test(spec)) return spec;
  throw new Error(
    `MARINA_ARENA_FORECASTER "${spec}" must be baseline, model:<provider/model> or crew:<model>[,<model>,<model>]`,
  );
}

export function arenaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArenaConfig | undefined {
  const entrant = env.MARINA_ARENA_ENTRANT?.trim();
  if (!entrant) return undefined;
  if (!ENTRANT_ID.test(entrant)) {
    throw new Error(`MARINA_ARENA_ENTRANT "${entrant}" must match ${ENTRANT_ID}`);
  }
  const origin = env.MARINA_ARENA_URL?.trim() || DEFAULT_ORIGIN;
  if (!origin.startsWith("https://")) throw new Error("MARINA_ARENA_URL must be https");
  const hours = Number(env.MARINA_ARENA_WINDOW_HOURS ?? 24);
  return {
    entrant,
    ...(env.MARINA_ARENA_KEY_FILE?.trim() ? { keyFile: env.MARINA_ARENA_KEY_FILE.trim() } : {}),
    keyId: env.MARINA_ARENA_KEY_ID?.trim() || "k1",
    origin: origin.replace(/\/$/, ""),
    audience: env.MARINA_ARENA_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
    dataUrl: env.MARINA_ARENA_DATA_URL?.trim() || DEFAULT_ARENA_DATA_URL,
    autopilot: /^(1|on|true)$/i.test(env.MARINA_ARENA_AUTOPILOT ?? ""),
    windowHours: Number.isFinite(hours) && hours > 0 && hours <= 168 ? hours : 24,
    forecaster: parseForecasterSpec(env.MARINA_ARENA_FORECASTER),
    modelWeight: clampWeight(env.MARINA_ARENA_MODEL_WEIGHT),
  };
}

/** Load the signing key, refusing a file other users could read (as ssh does). */
export function loadArenaKey(path: string) {
  const mode = statSync(path).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 ${path}`,
    );
  }
  return loadPrivateKey(readFileSync(path));
}

function clampWeight(raw: string | undefined): number {
  const w = Number(raw ?? 0.5);
  return Number.isFinite(w) ? Math.min(Math.max(w, 0), 1) : 0.5;
}
