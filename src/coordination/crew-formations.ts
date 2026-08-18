// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Crew formations — runtime form of the 10 orchestration patterns.
 *
 * Phase 2: formation brief only. When a crew activates (or formation changes),
 * the manager posts a single `[formation:<name>]` summary message on the crew
 * channel, derived from the same TEMPLATE arrays that the project pool notes
 * use. This keeps pool-note conventions and crew formations in sync — single
 * source of truth.
 *
 * Phase 4 will add active mediation hooks (`onTick`, `onMessage`) for the
 * patterns that benefit from runtime nudging (foundry, pipeline, mapreduce).
 */

import type { CrewFormation } from "../types";
import {
  BLACKBOARD_TEMPLATE,
  CHORUS_TEMPLATE,
  DEBATE_TEMPLATE,
  FOUNDRY_TEMPLATE,
  MAPREDUCE_TEMPLATE,
  NSED_TEMPLATE,
  PIPELINE_TEMPLATE,
  RESEARCH_TEMPLATE,
  SWARM_TEMPLATE,
  SYMBIOSIS_TEMPLATE,
  type TemplateNote,
} from "../world/templates/orchestration";

// Re-export so callers don't need to know about the orchestration module.
export type { TemplateNote };

const FREEFORM_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This crew has no formation. Coordinate by talking on the crew channel; " +
      "decide together how to divide work and merge results. The crew exists " +
      "for the duration of one task — when the goal is met, complete or dissolve it.",
    importance: 6,
    type: "skill",
  },
];

const TEMPLATES: Record<CrewFormation, TemplateNote[]> = {
  nsed: NSED_TEMPLATE,
  chorus: CHORUS_TEMPLATE,
  foundry: FOUNDRY_TEMPLATE,
  swarm: SWARM_TEMPLATE,
  pipeline: PIPELINE_TEMPLATE,
  debate: DEBATE_TEMPLATE,
  mapreduce: MAPREDUCE_TEMPLATE,
  blackboard: BLACKBOARD_TEMPLATE,
  symbiosis: SYMBIOSIS_TEMPLATE,
  research: RESEARCH_TEMPLATE,
  freeform: FREEFORM_TEMPLATE,
};

/** Return the template notes for a formation. Empty array if unknown. */
export function getFormationTemplate(formation: CrewFormation): TemplateNote[] {
  return TEMPLATES[formation] ?? [];
}

/**
 * Build the single-message formation brief that gets posted to the crew
 * channel on activation. Concatenates the template notes — they're already
 * written as standalone paragraphs in the orchestration module.
 */
export function buildFormationBrief(formation: CrewFormation, goal: string): string {
  const notes = getFormationTemplate(formation);
  const header = `[formation:${formation}] crew goal: ${goal || "(unspecified)"}`;
  if (notes.length === 0) return header;
  const body = notes.map((n) => `• ${n.content}`).join("\n");
  return `${header}\n${body}`;
}
