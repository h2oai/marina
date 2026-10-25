// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalogue entries rendered as text for the surfaces that show them to
 * people and agents: the project template's opening note, `crew info` and
 * the steps line a `crew dispatch` offers when the formation has a Score
 * template. Pure: words only, no model calls.
 */

import { type FormationEntry, resolveFormation } from "./catalogue";
import type { TemplateStep } from "./template";

/** `1) … 2) …` — an entry's protocol on one line. */
export function protocolText(entry: FormationEntry): string {
  return entry.protocol.map((step, i) => `${i + 1}) ${step}`).join("; ");
}

/** Who works a template step, in words. */
function stepWorker(step: TemplateStep): string {
  if (step.fanOut === "k") return step.slot === "peer" ? "each member, on a peer's" : "each member";
  if (step.fanOut === "chain") return "one member per stage, in turn";
  if (step.fanOut === "bracket") return "one non-author per pair";
  if (step.slot === "checker") return "one checker";
  if (step.slot === "member") return "one member";
  return step.slot;
}

/**
 * The steps of a formation's free-text Score template, for a crew dispatch:
 * `Score (<name>): draft (each member) → pick (one checker).` Undefined when
 * the formation has none (crew-only formations work from their brief).
 */
export function scoreStepsLine(name: string): string | undefined {
  const entry = resolveFormation(name);
  const template = entry?.text;
  if (!entry || !template) return undefined;
  const steps = template.steps.map((s) => `${s.id} (${stepWorker(s)})`).join(" → ");
  return `Score (${entry.name}): ${steps}.`;
}
