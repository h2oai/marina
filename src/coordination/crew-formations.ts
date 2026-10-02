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
 *
 * Model requests (`marina:<crew>`) bypass `[crew-task]` dispatch, so a
 * serving crew's formation reaches each request through its `protocol` line
 * instead (`requestProtocolLine`): verification, deliberation, tournament and
 * delphi consult named specialists by bounded awaited tells.
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
  "PRIORITY: a `model_request` takes precedence over formation process: post " +
  "`{type:'model_response',id,content}` on its channel. Formation shapes how you work, " +
  "never delays a reply.";

/**
 * Purpose-built RUNTIME briefs, one per formation. Design rules (from the
 * 2026-09 sweep evidence): structure-light beats process-heavy; name concrete
 * crew primitives (`crew stage`, `crew artifact`, `tell`); bound the process
 * (one round, then act); never give the formation authority over answering.
 */
export const CREW_BRIEFS: Record<CrewFormation, string> = {
  freeform:
    "No fixed structure. Divide work by strength on this channel; merge results. Complete or " +
    "dissolve the crew when the goal is met.",
  deliberation:
    "ONE round: each member posts one proposal here → lead picks or merges → picked owner " +
    "executes now. Another round only if execution fails. One debrief message after delivery.",
  chorus:
    "Parallel phases now. Post partial results here as produced. Before completing, each " +
    "member reviews one other member's partial. Lead merges and delivers.",
  foundry:
    "Lead = overseer and merge gate: split the goal, assign one piece per worker by `tell`. " +
    "Workers deliver to the lead, never merge. Mark handoffs: `crew stage <name> <piece>`.",
  swarm:
    "Self-assign: reply 'claiming: <piece>', then do it. Stuck: hand off here with the partial " +
    "payload. Lead assembles what lands.",
  pipeline:
    "Strict stage order. Stage owner works, posts the handoff here, marks " +
    "`crew stage <name> <stage>`. Next owner starts from the handoff only. No skipped or " +
    "parallel stages.",
  debate:
    "Two members post SEALED positions first (`crew artifact <name> draft -- <ref>`); no " +
    "cross-talk until both land. One non-author judge decides in one message; final. Deliver it.",
  mapreduce:
    "Lead: split into INDEPENDENT chunks now, one `tell` per specialist. Specialists: " +
    "`crew artifact <name> map -- <ref>`. Lead merges when all land: " +
    "`crew artifact <name> reduce -- <ref>`.",
  blackboard:
    "This channel IS the workspace. Post improvements to the CURRENT state; never fork a " +
    "private copy. Stop after two consecutive posts that change nothing material.",
  symbiosis:
    "Pair from different strengths: alternate short contributions here, each building on the " +
    "last. When the exchange stops adding, say so and deliver.",
  research:
    "One hypothesis at a time: state it → smallest test → post the measurement → keep or kill. " +
    "Before completing: `crew artifact <name> synthesis -- <ref>`.",
  delphi:
    "Start — each member: `tell <lead> estimate: <value> | <reasons>` (a choice: pick + " +
    "confidence) before reading others'. Lead: once all are in, post one anonymized summary " +
    "here (range, median, key reasons). Members revise once. Deliver the final estimate with " +
    "surviving dissent.",
  tournament:
    "Start — each member: deposit one candidate alone " +
    "(`crew artifact <name> draft -- <candidate>`) before any winner is named. Lead pairs " +
    "candidates; a non-author picks each pair's winner in one message until one remains. " +
    "Graft losers' best ideas in; deliver.",
  verification:
    "Start — one drafter: `crew artifact <name> draft -- <candidate>`. Each other member " +
    "checks ONE aspect (correctness, requirements, evidence, safety): " +
    "`channel send <crew-channel> aspect: <aspect> pass|fail — <reason>`. Run checks, don't " +
    "argue them. A fail returns to the drafter once; lead delivers when every aspect passes.",
  auction:
    "Start — lead: `channel send <crew-channel> lots: 1) … 2) …`, then wait for bids. Members " +
    "bid per lot: fit (a past result) + expected effort. Lead awards each lot (best fit per " +
    "effort) by `tell`. Winners do their lot; lead merges and delivers.",
  ledger:
    "Start — lead: `channel send <crew-channel> [plan] facts: … | steps: … | owners: …`, then " +
    "a progress ledger (done, in flight, stuck) after each step. A member stuck twice on one " +
    "step: lead replans, not retries. Lead delivers.",
  sharding:
    "Start — lead: run the checker once. Shard when it reports several independent failing " +
    "cases: ONE message with every shard — `channel send <crew-channel> shard 1: <case> | " +
    "shard 2: <case> | …`; for one or two, just fix " +
    "them. Members: reply 'claiming: <shard>', fix WITHOUT editing the checker or tests, " +
    "re-run, post the result. Done = full check passes; lead delivers. Checker can't run: " +
    "verify by hand, deliver with the limitation stated.",
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
      `(pool note / final crew artifact); no competing deliverable. Contribute per the ` +
      `[formation:${canonical}] brief.)`
    );
  }
  return (
    `(Designated depositor: ${depositor}. Everyone works the task; post your result ON THIS ` +
    `CHANNEL. Only ${depositor} writes the final deliverable (pool note / crew artifact) from ` +
    `what lands here; no competing deliverable.)`
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
      ? `\nLead: ${names.lead}; runs every lead step. The requester is not part of the ` +
        `protocol; contributions go to ${names.lead} or this channel.`
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
    `reading others'. ${lead} (lead, not the requester) then posts one anonymized summary here.`,
  tournament: ({ lead, crewName }) =>
    `Start this task — each member: \`crew artifact ${crewName} draft -- <candidate>\` before ` +
    `any winner is named. ${lead} (lead) then pairs candidates.`,
  verification: ({ lead, crewName, channel }) =>
    `Start this task — one drafter: \`crew artifact ${crewName} draft -- <candidate>\`. ` +
    `Verifiers: \`channel send ${channel} aspect: <aspect> pass|fail — <reason>\`. ` +
    `${lead} (lead) delivers once every aspect passes.`,
  auction: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): \`channel send ${channel} lots: 1) … 2) …\` first. ` +
    `Members bid per lot; ${lead} awards each lot by \`tell\`.`,
  ledger: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): \`channel send ${channel} [plan] facts: … | steps: … | ` +
    `owners: …\` first, then a progress ledger after each step.`,
  sharding: ({ lead, channel }) =>
    `Start this task — ${lead} (lead): run the checker. Several independent failing cases: ` +
    `one message, every shard: \`channel send ${channel} shard 1: <case> | shard 2: <case> | …\`, ` +
    `for members to claim. One or two: ` +
    `just fix them.`,
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

// ─── Request protocols: consult the specialist population per request ───────

/**
 * Specialist roles a request protocol may consult, keyed by the agent's
 * configured role, with the aspect each one checks. These are the
 * population's independent minds (each may run on its own model via
 * `MARINA_AGENT_MODELS`); crew membership is not required — a consult is an
 * awaited `marina_tell`, so any online specialist can serve.
 */
export const CONSULT_ROLE_ASPECTS: Readonly<Record<string, string>> = {
  skeptic: "counter-argument",
  mathematician: "math correctness",
  scholar: "reasoning",
  historian: "facts and evidence",
};

/** One consultable specialist as the router sees it. */
export interface Consultant {
  name: string;
  role: string;
  model?: string;
}

/** Wait per consult (an awaited `marina_tell`); bounded below the agent's 120 s prompt cap. */
export const CONSULT_TIMEOUT_MS = 30_000;

/** Consults per request: two bounded waits keep the worst case well inside one prompt. */
export const CONSULTS_PER_REQUEST = 2;

interface RequestProtocol {
  /** Consultant roles in preference order. */
  roles: readonly string[];
  render(n: { consultants: string; timeoutMs: number; count: number }): string;
}

/**
 * Per-request formation protocols. A `marina:<crew>` model request goes
 * straight to a serving member and never passes through a `[crew-task]`
 * dispatch, so without this the formation's brief (posted once on the crew
 * channel) does not reach the request at all. Each line names real
 * consultants and a bounded wait; a slow or silent consultant never holds the
 * reply (timeout ⇒ proceed). Formations not listed here add nothing.
 */
const REQUEST_PROTOCOLS: Partial<Record<CrewFormation, RequestProtocol>> = {
  verification: {
    roles: ["skeptic", "mathematician", "scholar", "historian"],
    render: ({ consultants, timeoutMs, count }) =>
      `[protocol:verification] Draft, then ${count} independent check(s), one awaited ` +
      `\`marina_tell\` each (awaitReply:true, timeoutMs:${timeoutMs}): ${consultants}. ` +
      `Message: "check <aspect>: <question> | draft: <answer> — reply pass|fail: <reason>". ` +
      `A fail: revise once. Timeout: keep your draft. Then send the model_response.`,
  },
  deliberation: {
    roles: ["scholar", "historian", "skeptic", "mathematician"],
    render: ({ consultants, timeoutMs }) =>
      `[protocol:deliberation] One proposal each from ${consultants} (awaited \`marina_tell\`, ` +
      `awaitReply:true, timeoutMs:${timeoutMs}): "propose: <question>". Pick or merge with ` +
      `yours; timeout: proceed without it. Then send the model_response.`,
  },
  tournament: {
    roles: ["scholar", "historian", "mathematician", "skeptic"],
    render: ({ consultants, timeoutMs }) =>
      `[protocol:tournament] One independent candidate each from ${consultants} (awaited ` +
      `\`marina_tell\`, awaitReply:true, timeoutMs:${timeoutMs}): "candidate: <question>". ` +
      `Judge them against yours on the question; graft the best parts. Then send the ` +
      `model_response.`,
  },
  delphi: {
    roles: ["scholar", "historian", "skeptic", "mathematician"],
    render: ({ consultants, timeoutMs }) =>
      `[protocol:delphi] An independent estimate each from ${consultants} (awaited ` +
      `\`marina_tell\`, awaitReply:true, timeoutMs:${timeoutMs}): "estimate: <question> — ` +
      `reply value | confidence | one reason". Aggregate with yours (median, or the majority ` +
      `choice). Then send the model_response.`,
  },
};

/** Formations whose model requests carry a consult protocol. */
export const REQUEST_PROTOCOL_FORMATIONS = Object.keys(REQUEST_PROTOCOLS) as CrewFormation[];

/** Vendor of a model id: `openrouter/anthropic/x` → `anthropic`, `openai/x` → `openai`. */
function modelVendor(model: string | undefined): string {
  if (!model) return "";
  const parts = model.split("/");
  return (parts.length >= 3 ? parts[parts.length - 2] : parts[0]) ?? "";
}

/**
 * Pick the consultants for one request: the formation's roles in order, at
 * most one per role, preferring a model whose vendor differs from the
 * responder's and from those already picked (independent minds, not the
 * responder's own model asked twice). Deterministic for a given roster.
 */
export function pickConsultants(
  formation: CrewFormation,
  candidates: readonly Consultant[],
  responderModel?: string,
  count = CONSULTS_PER_REQUEST,
): Consultant[] {
  const protocol = REQUEST_PROTOCOLS[normalizePatternName(formation) as CrewFormation];
  if (!protocol || count <= 0) return [];
  const usedVendors = new Set([modelVendor(responderModel)].filter(Boolean));
  const picked: Consultant[] = [];
  for (const role of protocol.roles) {
    if (picked.length >= count) break;
    const ofRole = candidates
      .filter((c) => c.role === role && !picked.some((p) => p.name === c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const fresh = ofRole.find((c) => !usedVendors.has(modelVendor(c.model)));
    const choice = fresh ?? ofRole[0];
    if (!choice) continue;
    picked.push(choice);
    const vendor = modelVendor(choice.model);
    if (vendor) usedVendors.add(vendor);
  }
  return picked;
}

/**
 * The `protocol` line a serving crew's model request carries, or undefined
 * when the formation has no request protocol or no consultant is online.
 */
export function requestProtocolLine(
  formation: CrewFormation,
  consultants: readonly Consultant[],
  timeoutMs = CONSULT_TIMEOUT_MS,
): string | undefined {
  const protocol = REQUEST_PROTOCOLS[normalizePatternName(formation) as CrewFormation];
  if (!protocol || consultants.length === 0) return undefined;
  const list = consultants
    .map((c) => `${c.name} (${CONSULT_ROLE_ASPECTS[c.role] ?? c.role})`)
    .join(", ");
  return protocol.render({ consultants: list, timeoutMs, count: consultants.length });
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
      `Pipeline: first stage owner starts now; others wait for a handoff. Mark each: ` +
      `\`crew stage ${crew.name} <stage>\`.`,
    onStageCompleted: (_crew, stage, agentName) =>
      `Stage "${stage}" done by ${agentName}. Next stage owner: start from the handoff above.`,
  },
  mapreduce: {
    onDispatch: (crew) =>
      `Lead: split into independent chunks now, one \`tell\` per specialist. Specialists: ` +
      `\`crew artifact ${crew.name} map -- <ref>\`.`,
    onArtifact: (crew, kind, _ref, agentName) =>
      kind === "map"
        ? `Map chunk from ${agentName}. Lead: when all are in, merge → ` +
          `\`crew artifact ${crew.name} reduce -- <ref>\`.`
        : kind === "reduce"
          ? `Reduce deposited by ${agentName}: verify, then complete the crew.`
          : undefined,
  },
  foundry: {
    onStageCompleted: (_crew, stage, agentName) =>
      `Piece "${stage}" from ${agentName}. Lead (merge gate): review before merging; workers ` +
      `don't merge.`,
  },
  debate: {
    onArtifact: (_crew, kind, _ref, agentName) =>
      kind === "draft"
        ? `Sealed position from ${agentName}. When both are in, a non-author judge decides in ` +
          `one message.`
        : undefined,
  },
  deliberation: {
    onDispatch: () =>
      `One proposal per member, one round. Lead picks or merges; picked owner executes now. ` +
      `Second round only if execution fails.`,
  },
  blackboard: {
    onArtifact: (_crew, _kind, _ref, agentName) =>
      `Workspace updated by ${agentName}: build on the CURRENT state above; never fork a ` +
      `private copy.`,
  },
};

/** Look up the mediator for a formation (legacy names normalized). */
export function getFormationMediator(formation: CrewFormation): FormationMediator | undefined {
  return FORMATION_MEDIATORS[normalizePatternName(formation) as CrewFormation];
}
