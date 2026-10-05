// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast defaults through the one resolution path (`resolveDefault`).
 *
 * The forecast configuration a surface uses — formation, analysts (with their
 * planner and critic), the checker (verifier) and the selection mode — each
 * resolves in the same order: the operator's env var, then the local slot
 * (`forecast-config`, or `forecast-config:<board>` for a board's live run),
 * then the family slot (`forecast-config:family:forecast`), then an upstream
 * seed, then today's built-in. A slot holds a forecast configuration as data
 * — the target a backtest filed (`{ configuration: {...} }`) or the
 * configuration itself — and only earned promotion writes it.
 *
 * With nothing promoted every field resolves to `env` or `builtin`, and the
 * caller passes nothing new: behaviour is exactly as before.
 */

import {
  type DefaultResolution,
  type DefaultSlotReader,
  resolveDefault,
} from "../engine/default-resolution";
import { SELECTION_MODES, type SelectionMode } from "./answer-types";
import { type TypedFormation, typedFormation } from "./formations";

/** The slot family name for forecast configuration defaults. */
export const FORECAST_CONFIG_SLOT = "forecast-config";
/** The task family every forecast choice belongs to. */
export const FORECAST_FAMILY = "forecast";

/** The parts of a forecast configuration a default may carry (data, never code). */
export interface ForecastConfigValue {
  label?: string;
  formation?: string;
  analysts?: string[];
  planner?: string;
  critic?: string;
  verifier?: string;
  verify?: boolean;
  selection?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A slot value as a forecast configuration: `{ configuration: {...} }` (the
 * target a backtest files) or the configuration itself. Undefined when it
 * names no analysts — a value that is not a forecast configuration.
 */
export function forecastConfigFromSlot(value: unknown): ForecastConfigValue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const outer = value as { configuration?: unknown };
  const c = (
    outer.configuration && typeof outer.configuration === "object" ? outer.configuration : value
  ) as Record<string, unknown>;
  const analysts = Array.isArray(c.analysts)
    ? c.analysts.map(str).filter((m): m is string => !!m)
    : [];
  if (analysts.length === 0) return undefined;
  const out: ForecastConfigValue = { analysts };
  for (const k of ["label", "formation", "planner", "critic", "verifier", "selection"] as const) {
    const v = str(c[k]);
    if (v) out[k] = v;
  }
  if (c.verify === true) out.verify = true;
  return out;
}

export interface ForecastDefaults {
  formation: TypedFormation;
  /** Set only when a slot answered (env and built-in are applied by `typedForecastDeps`). */
  team?: { analysts: string[]; planner?: string; critic?: string };
  checker?: { verifier: string; verify: true };
  selection?: SelectionMode;
  resolutions: DefaultResolution<unknown>[];
}

/**
 * Resolve the forecast defaults for a surface. `board` names the board a live
 * run files on (its local slot is `forecast-config:<board>`); without it the
 * local slot is `forecast-config`.
 */
export function resolveForecastDefaults(opts: {
  env?: NodeJS.ProcessEnv;
  db?: DefaultSlotReader;
  board?: string;
  surface?: string;
}): ForecastDefaults {
  const env = opts.env ?? process.env;
  const base = {
    slot: FORECAST_CONFIG_SLOT,
    families: [FORECAST_FAMILY],
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    surface: opts.surface ?? "forecast",
  };
  const fromSlot = <T>(pick: (c: ForecastConfigValue) => T | undefined) => {
    return (v: unknown) => {
      const c = forecastConfigFromSlot(v);
      return c ? pick(c) : undefined;
    };
  };

  const formation = resolveDefault<TypedFormation>({
    ...base,
    surface: `${base.surface}:formation`,
    env: {
      name: "MARINA_FORECAST_FORMATION",
      value: typedFormation(env.MARINA_FORECAST_FORMATION),
    },
    read: fromSlot((c) => typedFormation(c.formation)),
    builtIn: "ensemble",
  });

  const team = resolveDefault<ForecastDefaults["team"]>({
    ...base,
    surface: `${base.surface}:analysts`,
    env: {
      name: "MARINA_FORECAST_ANALYSTS",
      value: env.MARINA_FORECAST_ANALYSTS?.trim() ? { analysts: [] } : undefined,
    },
    read: fromSlot((c) => ({
      analysts: c.analysts ?? [],
      ...(c.planner ? { planner: c.planner } : {}),
      ...(c.critic ? { critic: c.critic } : {}),
    })),
    builtIn: undefined,
    builtInLabel: "installation default analysts",
  });

  const checkerEnv = env.MARINA_FORECAST_VERIFIER?.trim() || env.MARINA_FORECAST_VERIFY?.trim();
  const checker = resolveDefault<ForecastDefaults["checker"]>({
    ...base,
    surface: `${base.surface}:checker`,
    env: {
      name: "MARINA_FORECAST_VERIFIER",
      value: checkerEnv ? { verifier: "", verify: true } : undefined,
    },
    read: fromSlot((c) =>
      c.verify && c.verifier ? { verifier: c.verifier, verify: true as const } : undefined,
    ),
    builtIn: undefined,
    builtInLabel: "no checker",
  });

  const selectionEnv = env.MARINA_FORECAST_SELECTION?.trim().toLowerCase();
  const selection = resolveDefault<SelectionMode | undefined>({
    ...base,
    surface: `${base.surface}:selection`,
    env: {
      name: "MARINA_FORECAST_SELECTION",
      value: SELECTION_MODES.includes(selectionEnv as SelectionMode)
        ? (selectionEnv as SelectionMode)
        : undefined,
    },
    read: fromSlot((c) =>
      SELECTION_MODES.includes(c.selection as SelectionMode)
        ? (c.selection as SelectionMode)
        : undefined,
    ),
    builtIn: undefined,
    builtInLabel: "built-in selection",
  });

  const earned = (r: DefaultResolution<unknown>) => r.source !== "env" && r.source !== "builtin";
  return {
    formation: formation.value,
    ...(earned(team) && team.value ? { team: team.value } : {}),
    ...(earned(checker) && checker.value ? { checker: checker.value } : {}),
    ...(earned(selection) && selection.value ? { selection: selection.value } : {}),
    resolutions: [formation, team, checker, selection] as DefaultResolution<unknown>[],
  };
}

/**
 * `typedForecastDeps` overrides for the earned parts only — and never one the
 * operator set in the environment (an override would beat the env var there).
 */
export function forecastDefaultOverrides(
  d: ForecastDefaults,
  env: NodeJS.ProcessEnv = process.env,
): {
  analysts?: string[];
  planner?: string;
  critic?: string;
  verifier?: string;
  verify?: boolean;
  selection?: SelectionMode;
} {
  return {
    ...(d.team ? { analysts: d.team.analysts } : {}),
    ...(d.team?.planner && !env.MARINA_FORECAST_PLANNER?.trim() ? { planner: d.team.planner } : {}),
    ...(d.team?.critic && !env.MARINA_FORECAST_CRITIC?.trim() ? { critic: d.team.critic } : {}),
    ...(d.checker ? { verifier: d.checker.verifier, verify: true } : {}),
    ...(d.selection ? { selection: d.selection } : {}),
  };
}
