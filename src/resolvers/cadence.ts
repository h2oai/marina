// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Cadence parser — voice-friendly duration syntax for watch specs.
//
// Accepts: "1h", "30s", "5m", "7d", "1w", "once" (case-insensitive).
// Rejects hyphens, underscores, "every-1h", "every 1h" — the user-facing
// surface is bare-duration only. Storage in the spec note can render as
// "every 1h" for readability since that is machine-only.
//
// Voice test: "cadence one hour", "cadence thirty seconds", "cadence once"
// all read cleanly via TTS.

const UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export type Cadence = { kind: "interval"; ms: number } | { kind: "once" };

export type CadenceParseResult = { ok: true; cadence: Cadence } | { ok: false; error: string };

export function parseCadence(raw: string | undefined): CadenceParseResult {
  if (!raw?.trim()) {
    return { ok: false, error: "cadence is required (e.g. cadence:1h, cadence:30s, cadence:once)" };
  }
  const trimmed = raw.trim().toLowerCase();
  if (/[-_]/.test(trimmed)) {
    return {
      ok: false,
      error: "cadence must not contain hyphens or underscores (try cadence:1h or cadence:once)",
    };
  }
  if (trimmed === "once") return { ok: true, cadence: { kind: "once" } };

  const m = trimmed.match(/^(\d+)\s*([smhdw])$/);
  if (!m) {
    return {
      ok: false,
      error: `unrecognized cadence "${raw}" — try 30s, 5m, 1h, 7d, 1w, or once`,
    };
  }
  const n = Number.parseInt(m[1]!, 10);
  if (n <= 0) return { ok: false, error: "cadence must be positive" };
  const unitMs = UNITS_MS[m[2]!];
  if (!unitMs) return { ok: false, error: `unknown cadence unit: ${m[2]}` };
  return { ok: true, cadence: { kind: "interval", ms: n * unitMs } };
}

/** Render cadence in the spec-note storage form. Machine-only — humans
 *  type the input form (`1h`), the spec stores the readable form
 *  (`every 1h` or `once`). Tolerant: identical for "once". */
export function renderCadence(cadence: Cadence): string {
  if (cadence.kind === "once") return "once";
  // Pick the largest unit that divides cleanly for readability.
  const ms = cadence.ms;
  for (const [unit, unitMs] of [
    ["w", UNITS_MS.w!],
    ["d", UNITS_MS.d!],
    ["h", UNITS_MS.h!],
    ["m", UNITS_MS.m!],
  ] as const) {
    if (ms % unitMs === 0 && ms >= unitMs) {
      return `every ${ms / unitMs}${unit}`;
    }
  }
  return `every ${Math.round(ms / 1000)}s`;
}

/** Determine whether a sample's age means a fresh probe is due.
 *  - kind=once: due iff no prior sample exists
 *  - kind=interval: due iff (now - lastSampleTs) >= ms; missing prior sample
 *    is also due (cadence elapsed against epoch) */
export function isDue(
  cadence: Cadence,
  lastSampleTs: number | undefined,
  now = Date.now(),
): boolean {
  if (lastSampleTs === undefined) return true;
  if (cadence.kind === "once") return false;
  return now - lastSampleTs >= cadence.ms;
}
