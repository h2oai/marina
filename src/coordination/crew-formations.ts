// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Crew formations — runtime form of the 10 orchestration patterns.
 *
 * Three runtime layers, each measured in the 2026-09 orchestration sweeps
 * (report: marina-internal design/orchestration-pattern-sweep-2026-09.md):
 *
 * 1. CREW BRIEF — a compact, purpose-built runtime brief per formation
 *    (CREW_BRIEFS below), posted when a crew activates or changes formation.
 *    Runtime briefs replaced the concatenated project pool-note templates
 *    after the sweep showed process-heavy prose displacing the crew's actual
 *    work; every brief leads with the protocol-priority preamble.
 * 2. FORMATION MEDIATORS — deterministic, event-driven nudges (the
 *    long-promised Phase 4): on dispatch / stage-complete / artifact-deposit
 *    the mediator injects one structural next-step line. No timers, no LLM
 *    calls — pure functions over events the crew manager already emits.
 * 3. ENGINE BACKSTOP — pending model_request reminders (model-api) guarantee
 *    a serving crew can never silently drop a request regardless of
 *    formation. Owned by the model API, documented here for the full map.
 *
 * The project pool-note TEMPLATES remain the project-level conventions
 * (seeded into orchestration:<pattern> pools); formations no longer reuse
 * them verbatim for crew runtime.
 */

import type { CrewFormation } from "../types";
import {
  BLACKBOARD_TEMPLATE,
  CHORUS_TEMPLATE,
  DEBATE_TEMPLATE,
  DELIBERATION_TEMPLATE,
  FOUNDRY_TEMPLATE,
  MAPREDUCE_TEMPLATE,
  normalizePatternName,
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
  deliberation: DELIBERATION_TEMPLATE,
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

/** Return the template notes for a formation. Empty array if unknown.
 * Legacy names in persisted crews (e.g. `nsed`) normalize to their
 * functional form. */
export function getFormationTemplate(formation: CrewFormation): TemplateNote[] {
  return TEMPLATES[normalizePatternName(formation) as CrewFormation] ?? [];
}

/**
 * Protocol-priority preamble prepended to every formation brief. Measured in
 * the 2026-09 orchestration sweep: process-heavy briefs (deliberation,
 * mapreduce, debate, symbiosis) displaced the model_response protocol in
 * small-model crews — the crew SOLVED the questions but never replied, so
 * every request timed out. Formation process must never outrank answering.
 */
const PROTOCOL_PRIORITY =
  "PRIORITY: if this crew serves a model endpoint, answering `model_request` " +
  "messages (post `{type:'model_response',id,content}` back on the request's " +
  "channel) always takes precedence over formation process. Apply the " +
  "formation to HOW you work, never as a reason to delay or skip a reply.";

/**
 * Purpose-built RUNTIME briefs, one per formation. Design rules (from the
 * 2026-09 sweep evidence): structure-light beats process-heavy; name concrete
 * crew primitives (`crew stage`, `crew artifact`, `tell`); bound the process
 * (one round, then act); never give the formation authority over answering.
 */
export const CREW_BRIEFS: Record<CrewFormation, string> = {
  freeform:
    "No fixed structure. Talk on this channel, divide work by strength, merge results. " +
    "Complete or dissolve the crew when the goal is met.",
  deliberation:
    "ONE round, then act: each member posts one proposal here → the lead picks (or merges) the " +
    "strongest → the picked owner executes immediately. Do not run further rounds unless the " +
    "execution fails. Debrief in one message after delivery.",
  chorus:
    "Work parallel phases NOW. Post partial results to this channel as you produce them " +
    "(the broadcast wall). Before completing, each member crossfire-reviews one other member's " +
    "partial. Lead merges and delivers.",
  foundry:
    "Lead = overseer: split the goal, assign each worker one piece by `tell`. Workers deliver to " +
    "the lead, never merge directly — the lead is the merge gate. Mark handoffs with " +
    "`crew stage <name> <piece>`.",
  swarm:
    "Self-assign: reply 'claiming: <piece>' for what matches your strength, then do it. If stuck, " +
    "hand off ON THIS CHANNEL with what you have (payload), don't sit on it. Lead assembles " +
    "whatever landed.",
  pipeline:
    "Strict stage order. Current stage owner works, then posts the handoff here and marks " +
    "`crew stage <name> <stage>`. Next owner starts only from the handoff content. No " +
    "stage-skipping, no parallel stages.",
  debate:
    "Two members write SEALED positions first — no cross-talk until both are posted here " +
    "(`crew artifact <name> draft -- <ref>`). Then one judge (not an author) decides in one " +
    "message. The decision is final; deliver it.",
  mapreduce:
    "Lead: split into INDEPENDENT chunks now, one `tell` per specialist. Specialists return " +
    "chunk results here (`crew artifact <name> map -- <ref>`). Lead merges once all land and " +
    "deposits the merge (`crew artifact <name> reduce -- <ref>`). Chunks must not depend on " +
    "each other.",
  blackboard:
    "This channel IS the shared workspace. Post improvements to the CURRENT state — never fork a " +
    "private copy. Each post must build on the last. Stop when two consecutive posts change " +
    "nothing material.",
  symbiosis:
    "Pair on the goal from your different strengths: alternate short contributions here, each " +
    "building on the other's. If you stop learning from the exchange, say so and deliver what " +
    "you have.",
  research:
    "One hypothesis at a time: state it here → run the smallest test → post the measurement → " +
    "keep or kill it. Record what was learned with `crew artifact <name> synthesis -- <ref>` " +
    "before completing.",
};

/**
 * Build the single-message formation brief posted on activation / formation
 * change: header + protocol priority + the formation's runtime brief.
 */
export function buildFormationBrief(formation: CrewFormation, goal: string): string {
  const canonical = normalizePatternName(formation) as CrewFormation;
  const header = `[formation:${canonical}] crew goal: ${goal || "(unspecified)"}`;
  const brief = CREW_BRIEFS[canonical];
  if (!brief) return `${header}\n${PROTOCOL_PRIORITY}`;
  return `${header}\n${PROTOCOL_PRIORITY}\n${brief}`;
}

// ─── Formation mediators (Phase 4 — deterministic event-driven nudges) ──────

/** Minimal crew view a mediator sees — no manager internals. */
export interface MediatorCrewView {
  name: string;
  goal: string;
  memberNames: string[];
  leadName?: string;
}

/**
 * A formation mediator turns crew-manager events into at most ONE structural
 * next-step line, posted on the crew channel as `[formation-mediator] …`.
 * Pure functions: no timers, no state, no LLM. Return undefined to stay
 * silent. The engine-side model_request reminders (model-api) remain the
 * liveness guarantee; mediators only sharpen the next structural step.
 */
export interface FormationMediator {
  onDispatch?(crew: MediatorCrewView, message: string): string | undefined;
  onStageCompleted?(crew: MediatorCrewView, stage: string, agentName: string): string | undefined;
  onArtifact?(
    crew: MediatorCrewView,
    kind: "map" | "reduce" | "synthesis" | "draft",
    artifactRef: string,
    agentName: string,
  ): string | undefined;
}

export const FORMATION_MEDIATORS: Partial<Record<CrewFormation, FormationMediator>> = {
  pipeline: {
    onDispatch: (crew) =>
      `Pipeline order: first stage owner starts now; everyone else waits for a handoff. ` +
      `Mark each handoff with \`crew stage ${crew.name} <stage>\`.`,
    onStageCompleted: (_crew, stage, agentName) =>
      `Stage "${stage}" completed by ${agentName} — next stage owner: pick up from the handoff ` +
      `posted above and start now.`,
  },
  mapreduce: {
    onDispatch: (crew) =>
      `Lead: split the goal into independent chunks NOW — one \`tell\` per specialist. ` +
      `Specialists: deposit results with \`crew artifact ${crew.name} map -- <ref>\`.`,
    onArtifact: (crew, kind, _ref, agentName) =>
      kind === "map"
        ? `Map chunk landed from ${agentName}. Lead: merge when all chunks are in, then ` +
          `\`crew artifact ${crew.name} reduce -- <ref>\`.`
        : kind === "reduce"
          ? `Reduce deposited by ${agentName} — verify and complete the crew.`
          : undefined,
  },
  foundry: {
    onStageCompleted: (_crew, stage, agentName) =>
      `Piece "${stage}" delivered by ${agentName}. Lead (merge gate): review before merging — ` +
      `workers do not merge directly.`,
  },
  debate: {
    onArtifact: (_crew, kind, _ref, agentName) =>
      kind === "draft"
        ? `Sealed position deposited by ${agentName}. When BOTH positions are in, the judge ` +
          `(not an author) decides in one message.`
        : undefined,
  },
  deliberation: {
    onDispatch: () =>
      `One proposal per member, one round. Lead picks or merges, picked owner executes ` +
      `immediately — no second round unless execution fails.`,
  },
  blackboard: {
    onArtifact: (_crew, _kind, _ref, agentName) =>
      `Workspace updated by ${agentName} — build on the CURRENT state above; never fork a ` +
      `private copy.`,
  },
};

/** Look up the mediator for a formation (legacy names normalized). */
export function getFormationMediator(formation: CrewFormation): FormationMediator | undefined {
  return FORMATION_MEDIATORS[normalizePatternName(formation) as CrewFormation];
}
