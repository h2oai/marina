// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What an in-world `benchmark run` measures.
 *
 * The world's benchmark measures its RESIDENTS by default. Before 2026-10 a
 * bare `benchmark run mmlu-pro` sent every item to the upstream model with no
 * resident involved (the runner's internal token takes the passthru branch),
 * so the flagship in-world benchmark mostly measured the provider.
 *
 * - `crew:<name>` — the residents serving `marina:<name>` (the crew's
 *   `model-<name>` channel, created with the crew and joined by its agent
 *   members, must have an online member).
 * - `model:<id>` — a bare-model CONTROL: the model alone, no residents,
 *   recorded `targetKind: "model"`, `control: true`. `model:marina:<name>`
 *   (the older spelling) is the crew `<name>`.
 * - neither — the world's serving crew: the one live crew endpoint (or, in a
 *   world with no crews, the one live `marina:<name>` endpoint). None, or
 *   several, is refused with what to pass instead — the run never silently
 *   falls back to the bare model.
 */

import { crewOfTarget } from "./benchmark-runner";

export interface ServingCrew {
  name: string;
  formation?: string;
}

export type RunTarget =
  | { kind: "crew"; model: string; crew: string; formation?: string; defaulted: boolean }
  | { kind: "model"; model: string; control: true };

export function resolveRunTarget(opts: {
  crew?: string;
  model?: string;
  /** Live `marina:<name>` endpoints (a `model-<name>` channel with an online member). */
  orchestrations: readonly string[];
  /**
   * The world's crews that serve a `marina:<name>` endpoint, with their
   * formation — online or not (`orchestrations` says which are live).
   */
  crews: readonly ServingCrew[];
}): RunTarget | { error: string } {
  const live = new Set(opts.orchestrations);
  const crewByName = new Map(opts.crews.map((c) => [c.name, c]));
  const asCrew = (name: string, defaulted: boolean): RunTarget | { error: string } => {
    const model = `marina:${name}`;
    if (!live.has(model)) {
      const others = `Live endpoints: ${[...live].join(", ") || "none"}.`;
      const control = "Or measure a bare model as a control with model:<id>.";
      return {
        error: crewByName.has(name)
          ? `crew ${name} is not serving: none of its agent members is online on model-${name} (people never answer it). ${others} An invited agent accepts with \`crew join ${name}\`; a member that is not running starts with \`agent spawn\` and needs a model provider (\`readiness providers\`). ${control}`
          : `crew ${name} is not serving: there is no crew named ${name}. ${others} Create one with \`crew create ${name} <agents> -- <goal>\`; its agent members serve marina:${name} once they join and are online. ${control}`,
      };
    }
    const formation = crewByName.get(name)?.formation;
    return { kind: "crew", model, crew: name, ...(formation ? { formation } : {}), defaulted };
  };

  const crewArg = opts.crew?.trim();
  const modelArg = opts.model?.trim();
  if (crewArg && modelArg)
    return { error: "name one target: crew:<name> (residents) or model:<id> (a control)." };
  if (crewArg) return asCrew(crewArg.replace(/^marina:/, ""), false);
  if (modelArg) {
    const crew = crewOfTarget(modelArg);
    return crew ? asCrew(crew, false) : { kind: "model", model: modelArg, control: true };
  }

  // Default: the world's serving crew.
  const crewEndpoints = opts.crews.filter((c) => live.has(`marina:${c.name}`)).map((c) => c.name);
  const candidates =
    crewEndpoints.length > 0
      ? crewEndpoints
      : [...live].flatMap((m) => {
          const c = crewOfTarget(m);
          return c ? [c] : [];
        });
  if (candidates.length === 1) return asCrew(candidates[0] as string, true);
  if (candidates.length === 0)
    return {
      error:
        "No serving crew in this world, so there are no residents to measure. Name a target: " +
        "crew:<name> (a crew serving marina:<name>), or model:<id> for a bare-model control run " +
        "(e.g. model:marina — the default upstream model, no residents).",
    };
  return {
    error: `Several crews serve this world (${candidates
      .map((c) => `crew:${c}`)
      .join(", ")}): name one, or model:<id> for a bare-model control run.`,
  };
}
