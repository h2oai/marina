// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Crew formations — runtime form of the 16 orchestration patterns.
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
 *
 * Every formation has a runtime brief; mediators are optional. Delphi,
 * tournament, verification, auction, ledger and sharding (added 2026-09) run
 * on their brief alone, like swarm, chorus, symbiosis and research — their
 * mechanics use existing primitives (`tell`, `channel send`, `crew artifact`)
 * and need no special runtime roles. Each of their briefs opens with one
 * concrete starting move ("Start — …"), and every `[crew-task]` dispatch
 * restates that move for the task at hand with the lead named
 * (`dispatchStartMove`). The pool-note templates stay advisory reference.
 */

import type { CrewFormation } from "../types";
import { normalizePatternName } from "../world/templates/orchestration";

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
  delphi:
    "Start — each member: send your estimate privately to the lead before reading anyone else's " +
    "(`tell <lead> estimate: <value> | <reasons>`; for a choice, your pick plus a confidence). " +
    "Lead: once all are in, post one anonymized summary here (range, median, key reasons, no " +
    "names). Members revise once. Keep dissenting reasons; deliver the final estimate with the " +
    "dissent that survived.",
  tournament:
    "Start — each member: produce one candidate alone and deposit it as a draft " +
    "(`crew artifact <name> draft -- <candidate>`) before anyone names a winner. Lead pairs " +
    "candidates; a non-author picks the stronger of each pair in one message until one remains. " +
    "Graft the losers' best ideas into the winner, then deliver.",
  verification:
    "Start — one drafter deposits the candidate (`crew artifact <name> draft -- <candidate>`). " +
    "Each other member checks ONE named aspect (correctness, requirements, evidence, safety) and " +
    "replies `channel send <crew-channel> aspect: <aspect> pass|fail — <reason>`. Run checks " +
    "rather than argue them. A failed aspect goes back to the drafter once; the lead delivers " +
    "when every aspect passes.",
  auction:
    "Start — lead: post the lots first (`channel send <crew-channel> lots: 1) … 2) …`), then " +
    "wait for bids. Each member bids per lot: fit (a past result) and expected effort. Lead " +
    "awards each lot to the best fit per effort by `tell`. Winners do their lot; lead merges and " +
    "delivers.",
  ledger:
    "Start — lead: post the plan ledger first " +
    "(`channel send <crew-channel> [plan] facts: … | steps: … | owners: …`), then a progress " +
    "ledger (done, in flight, stuck) after each step. When a member reports being stuck twice on " +
    "the same step, the lead replans rather than retries. Lead delivers.",
  sharding:
    "Start — lead: run the checker once. Shard when it reports several independent failing " +
    "cases: post one shard per case (`channel send <crew-channel> shard 1: <case>`); for one or " +
    "two, just fix them. Each member replies 'claiming: <shard>', " +
    "fixes it WITHOUT editing the checker or tests, re-runs, posts the result. Done = the full " +
    "check passes; lead delivers. If the checker cannot run, say so, verify by hand and deliver " +
    "with the limitation stated.",
};

/**
 * Formations whose protocol routes contributions somewhere other than the crew
 * channel (private estimates to the lead, drafts, bids, claimed shards,
 * per-aspect checks). Their dispatch line names the depositor and defers to
 * the brief instead of telling every member to post results on the channel.
 */
const BRIEF_ROUTED_FORMATIONS = new Set<CrewFormation>([
  "delphi",
  "tournament",
  "verification",
  "auction",
  "sharding",
]);

/**
 * The designated-depositor line appended to a `[crew-task]` dispatch.
 *
 * Broadcast formations keep "everyone works, one writes": members all engage
 * the task and post results on the CHANNEL (visible, mergeable
 * contributions) while only the depositor writes the deliverable. Measured
 * 2026-09: suppress-everyone-else ("only X works") solved duplication but
 * halved completion — one member's dropped turn had no cover.
 *
 * Brief-routed formations (above) get the same single-writer rule without the
 * channel instruction, which would contradict their brief.
 */
export function dispatchDepositorLine(formation: CrewFormation, depositor: string): string {
  const canonical = normalizePatternName(formation) as CrewFormation;
  if (BRIEF_ROUTED_FORMATIONS.has(canonical)) {
    return (
      `(Designated depositor: ${depositor}. Only ${depositor} writes the final deliverable ` +
      `(pool note / final crew artifact); never write a competing one. Otherwise follow the ` +
      `[formation:${canonical}] brief for how and where to contribute.)`
    );
  }
  return (
    `(Designated depositor: ${depositor}. Everyone works the task, but post your result ` +
    `ON THIS CHANNEL — only ${depositor} writes the final deliverable (pool note / crew ` +
    `artifact), consolidating what lands here. Never write a competing deliverable.)`
  );
}

/**
 * The concrete names a brief or dispatch is rendered with. `CREW_BRIEFS`
 * keep `<lead>`, `<name>` and `<crew-channel>` placeholders (they document
 * the protocol); the text a crew reads names the real lead, crew and
 * channel. Measured 2026-09: with only `tell <lead> …` in the brief, a delphi
 * lead sent its own estimate to the requester and waited for the requester's
 * summary.
 */
export interface FormationNames {
  /** The crew lead's agent name (see {@link crewLeadName}). */
  lead?: string;
  /** Crew name, as `crew artifact <name> …` takes it. */
  crewName?: string;
  /** Crew channel name, as `channel send <crew-channel> …` takes it. */
  channel?: string;
}

/**
 * The crew lead: the member whose role is `lead`, else the first member. One
 * resolution for the brief, the per-task dispatch line and the depositor, so
 * every text names the same facilitator.
 */
export function crewLeadName(
  members: readonly { agentName: string; role?: string }[],
): string | undefined {
  return (members.find((m) => m.role === "lead") ?? members[0])?.agentName;
}

/** Substitute the known names for the brief placeholders. */
export function fillFormationNames(text: string, names: FormationNames = {}): string {
  let out = text;
  if (names.lead) out = out.replaceAll("<lead>", names.lead);
  if (names.crewName) out = out.replaceAll("<name>", names.crewName);
  if (names.channel) out = out.replaceAll("<crew-channel>", names.channel);
  return out;
}

/**
 * Build the single-message formation brief posted on activation / formation
 * change: header + protocol priority + the formation's runtime brief, with
 * the real lead, crew and channel names substituted. When the brief routes
 * work through a lead, a `Lead:` line names that member and states that the
 * requester is not a participant: the lead facilitates.
 */
export function buildFormationBrief(
  formation: CrewFormation,
  goal: string,
  names: FormationNames = {},
): string {
  const canonical = normalizePatternName(formation) as CrewFormation;
  const header = `[formation:${canonical}] crew goal: ${goal || "(unspecified)"}`;
  const brief = CREW_BRIEFS[canonical];
  if (!brief) return `${header}\n${PROTOCOL_PRIORITY}`;
  const leadLine =
    names.lead && /\blead\b/i.test(brief)
      ? `\nLead: ${names.lead}. The lead facilitates this protocol; whoever dispatched the ` +
        `task (e.g. Operator) is not part of it — contributions go to ${names.lead} or this ` +
        `channel, and ${names.lead} runs every lead step.`
      : "";
  return `${header}\n${PROTOCOL_PRIORITY}\n${fillFormationNames(brief, names)}${leadLine}`;
}

/**
 * Per-task restatement of each lead-routed formation's starting move. The
 * brief's "Start — …" posts once, at activation; measured 2026-09, the move
 * then fired for the first task only (auction lots posted once as standing
 * routing, one ledger plan, `aspect:` verdicts decaying after two tasks).
 * Appending the move to every `[crew-task]` dispatch puts the formation's
 * essential protocol command in the perception members act on, for THIS task.
 */
const START_MOVES: Partial<Record<CrewFormation, (n: Required<FormationNames>) => string>> = {
  delphi: ({ lead }) =>
    `Start this task — each member: \`tell ${lead} estimate: <value> | <reasons>\` before ` +
    `reading anyone else's. ${lead} (lead, not the requester) then posts one anonymized ` +
    `summary here.`,
  tournament: ({ lead, crewName }) =>
    `Start this task — each member: deposit your candidate draft for this task ` +
    `(\`crew artifact ${crewName} draft -- <candidate>\`) before anyone names a winner. ` +
    `${lead} (lead) then pairs the candidates.`,
  verification: ({ lead, crewName, channel }) =>
    `Start this task — one drafter deposits the candidate ` +
    `(\`crew artifact ${crewName} draft -- <candidate>\`). Verifiers: reply ` +
    `\`channel send ${channel} aspect: <aspect> pass|fail — <reason>\` for this task. ` +
    `${lead} (lead) delivers once every aspect passes.`,
  auction: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): post lots for this task first ` +
    `(\`channel send ${channel} lots: 1) … 2) …\`). Members bid per lot; ${lead} awards each ` +
    `lot by \`tell\`.`,
  ledger: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): post this task's plan ledger first ` +
    `(\`channel send ${channel} [plan] facts: … | steps: … | owners: …\`), then a progress ` +
    `ledger after each step.`,
  sharding: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): run the checker. Several independent failing cases: ` +
    `post one shard per case (\`channel send ${channel} shard 1: <case>\`) for members to ` +
    `claim. One or two: just fix them.`,
};

/** Formations whose per-task dispatch restates a starting move. */
export const START_MOVE_FORMATIONS = Object.keys(START_MOVES) as CrewFormation[];

/**
 * The per-task starting move appended to a formation's `[crew-task]`
 * dispatch, or undefined when the formation has none. Missing names fall
 * back to the brief placeholders.
 */
export function dispatchStartMove(
  formation: CrewFormation,
  names: FormationNames = {},
): string | undefined {
  const move = START_MOVES[normalizePatternName(formation) as CrewFormation];
  if (!move) return undefined;
  return move({
    lead: names.lead ?? "the lead",
    crewName: names.crewName ?? "<name>",
    channel: names.channel ?? "<crew-channel>",
  });
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
