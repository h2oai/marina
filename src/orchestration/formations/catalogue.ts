// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * THE formation catalogue: one entry per formation, one description each.
 * It is Marina's one orchestration surface, run four ways: a crew
 * (`crew create … formation:<f>`), a project (`project <name> orchestrate
 * <f>`, whose pool notes are generated from the entry), one free-text task
 * (`pattern run <f>`) and a room's turn rule (`build formation`). Every
 * formation name, legacy alias, description, fit, role list and protocol
 * lives here; the surfaces resolve names through `canonicalFormationName`.
 *
 * A formation used to be implemented once per surface — pool-note templates
 * for projects, crew briefs, numeric arena protocols, typed forecast
 * formations, free-text patterns, the Score executor — sharing names, not
 * code. Here each formation is ONE entry:
 *
 *   summary   the one-line description (the orchestration catalogue's
 *             `PATTERN_FIT` reads it; nothing else restates it)
 *   title, roles, protocol, fit
 *             display name, the parts members play, the protocol in
 *             surface-neutral steps and the task shapes it fits: the project
 *             template's opening note, `crew info` and `suggestPatterns`
 *   room      it is also a room's turn rule
 *   typed     the Score template typed forecasts run (`src/forecast/formations.ts`,
 *             models and residents alike: `src/forecast/resident-forecast.ts`)
 *   text      the Score template a free-text task runs (`pattern run`,
 *             `POST /v1/patterns/run`: `src/orchestration/text-patterns.ts`)
 *   numeric   the arena's numeric protocol: `catalogue` when it runs from the
 *             template here, `arena` while it still runs its own code
 *             (`src/arena/formations.ts`; migration is a follow-up)
 *   crew      the formation also runs as a persistent crew: its runtime brief
 *             (`CREW_BRIEFS`) and project template (`ORCHESTRATION_TEMPLATES`)
 *             carry the same name, and `markers` are phrases both must keep
 *             (`test/formation-catalogue.test.ts` fails when they drift)
 *   crewOnly  why it has no one-task text protocol (it needs a crew over time)
 *
 * Assignees in a template are abstract slots resolved at run time:
 *   pipeline     pure code, or the typed pipeline's own stage
 *   forecaster   a typed run: `model:<id>`, `role:<r>`, `marina:<crew>`, a part
 *   referee      a tournament match (typed: the pipeline's critic)
 *   skeptic      the skeptic crew's trust call (typed: the pipeline's critic)
 *   member       a text-task member (the i-th)
 *   peer         a text-task member's ring neighbour (the (i+1)-th)
 *   checker      the text task's checker (picks, reviews, summaries)
 *
 * A leaf module: templates and words only — no model calls, no surface code.
 */

import type { FormationTemplate } from "./template";

export const FORMATION_NAMES = [
  "ensemble",
  "skeptic",
  "deliberation",
  "chorus",
  "foundry",
  "swarm",
  "pipeline",
  "debate",
  "mapreduce",
  "blackboard",
  "symbiosis",
  "research",
  "delphi",
  "tournament",
  "verification",
  "auction",
  "ledger",
  "sharding",
  "freeform",
] as const;

export type FormationName = (typeof FORMATION_NAMES)[number];

/** Coordination shapes a goal can take (`suggestPatterns` matches a goal against each entry's `fit`). */
export type TaskShape =
  | "decomposable"
  | "contested"
  | "parallel"
  | "sequential"
  | "hierarchical"
  | "shared-artifact"
  | "open-ended"
  | "verifiable";

export interface FormationEntry {
  name: FormationName;
  /** Display name (`MapReduce`). */
  title: string;
  /** The one-line description. */
  summary: string;
  /** The parts members play. */
  roles: string[];
  /** The protocol in surface-neutral steps: the project template and `crew info` render it. */
  protocol: string[];
  /** The coordination shapes it fits (empty: never suggested). */
  fit: TaskShape[];
  /** Also a crew protocol: a `CREW_BRIEFS` brief and an `ORCHESTRATION_TEMPLATES` template of this name. */
  crew: boolean;
  /** Also a room's turn rule (`build formation`, `src/coordination/room-formations.ts`). */
  room?: true;
  /** Phrases (case-insensitive) its crew brief and its project template both carry. */
  markers?: string[];
  /** The project template's phrases, where they differ from the brief's. */
  templateMarkers?: string[];
  /** Why it runs only as a crew, never as one free-text task. */
  crewOnly?: string;
  typed?: FormationTemplate;
  text?: FormationTemplate;
  numeric?: { runtime: "catalogue" | "arena"; template?: FormationTemplate };
}

// ─── Typed forecast templates ────────────────────────────────────────────────

/** Step 0 of every typed formation: the typed pipeline's research round. */
const RESEARCH_STEP = {
  id: "research",
  slot: "pipeline",
  instruction:
    "Plan the question, research it up to the evidence cutoff, check citations mechanically and run the structured lookups (the typed pipeline's research round).",
  access: [],
} as const;

const RUN_STEP = {
  id: "f",
  slot: "forecaster",
  fanOut: "k",
  instruction: (i: number, n: number) =>
    `Forecast independently from the research dossier (run ${i + 1} of ${n}); use your own tools within the evidence cutoff.`,
  access: ["research"],
} as const;

const TYPED_COMBINE =
  "Combine by type (pure code): the formation's combination, the critique rule, the answer contract, triage and the Arbiter.";

const typedGoal = (name: string) => (n: number) => `Forecast (${name}, ${n} members)`;

const TYPED = {
  ensemble: {
    goal: typedGoal("ensemble"),
    entrants: "f",
    steps: [
      RESEARCH_STEP,
      RUN_STEP,
      { id: "combine", slot: "pipeline", instruction: TYPED_COMBINE, access: ["f"] },
    ],
  },
  delphi: {
    goal: typedGoal("delphi"),
    entrants: "f",
    steps: [
      RESEARCH_STEP,
      RUN_STEP,
      {
        id: "summary",
        slot: "pipeline",
        instruction:
          "Summarise the panel anonymously: per-option medians and ranges, reason snippets.",
        access: ["f"],
      },
      {
        id: "v",
        slot: "forecaster",
        fanOut: "k",
        instruction: (i: number) =>
          `Revise run ${i + 1} once after reading the anonymous panel summary.`,
        access: ["summary", { step: "f", each: "same" }],
      },
      {
        id: "combine",
        slot: "pipeline",
        instruction: TYPED_COMBINE,
        access: ["f", "summary", "v"],
      },
    ],
  },
  tournament: {
    goal: typedGoal("tournament"),
    entrants: "f",
    steps: [
      RESEARCH_STEP,
      RUN_STEP,
      {
        id: "m",
        slot: "referee",
        fanOut: "bracket",
        bracket: { entrants: "f", schedule: "sequential" },
        instruction:
          "Referee one match: of two anonymous forecasts from the same research, pick the one more likely to score better under a proper scoring rule.",
        access: [],
      },
      { id: "combine", slot: "pipeline", instruction: TYPED_COMBINE, access: ["f", "m"] },
    ],
  },
  skeptic: {
    goal: typedGoal("skeptic"),
    k: 2,
    entrants: "f",
    steps: [
      RESEARCH_STEP,
      {
        id: "f",
        slot: "forecaster",
        fanOut: "k",
        instruction: (i: number) =>
          i === 0
            ? "As the crew's statistician, propose from the numbers in the research dossier: base rates, the latest readings, the start forecast."
            : "As the crew's analyst, propose from the specifics in the research dossier: who and what decide it, scheduled events, the sources.",
        access: ["research"],
      },
      {
        id: "skeptic",
        slot: "skeptic",
        instruction:
          "Say how much of the proposals' move away from the start forecast to trust (0–1); never propose a move of your own.",
        access: ["f"],
      },
      { id: "combine", slot: "pipeline", instruction: TYPED_COMBINE, access: ["f", "skeptic"] },
    ],
  },
} satisfies Record<string, FormationTemplate>;

export type TypedFormationName = keyof typeof TYPED;
export const TYPED_TEMPLATES: Readonly<Record<TypedFormationName, FormationTemplate>> = TYPED;

/** The typed formations, in catalogue order. */
export const TYPED_FORMATION_NAMES = Object.keys(TYPED_TEMPLATES) as TypedFormationName[];

/** The assignee of a typed template's `pipeline` slot (and of the pipeline's own critic). */
export const TYPED_PIPELINE_ASSIGNEE = "model:marina-forecast";

/** An assignee for a part named `name`: its own address when it has one, else `model:<name>`. */
export function partAssignee(name: string): string {
  return name.includes(":") ? name : `model:${name}`;
}

// ─── Free-text templates ─────────────────────────────────────────────────────

const textGoal = (name: string) => (n: number) => `Text task (${name}, ${n} members)`;

const draftStep = (id: string, instruction = "Answer the task independently and completely.") =>
  ({ id, slot: "member", fanOut: "k", instruction, access: [] }) as const;

const pickStep = (id: string, access: string[]) =>
  ({
    id,
    slot: "checker",
    instruction: "Pick ONE whole candidate answer (never a merge).",
    access,
  }) as const;

const TEXT = {
  ensemble: {
    goal: textGoal("ensemble"),
    entrants: "draft",
    steps: [draftStep("draft"), pickStep("pick", ["draft"])],
  },
  debate: {
    goal: textGoal("debate"),
    k: 2,
    entrants: "opening",
    steps: [
      draftStep("opening", "Advocate: answer the task and argue for it."),
      {
        id: "rebuttal",
        slot: "member",
        fanOut: "k",
        instruction:
          "Rebut the opponent's opening, concede what it got right, and give your final answer in full.",
        access: ["opening"],
      },
      pickStep("judge", ["opening", "rebuttal"]),
    ],
  },
  delphi: {
    goal: textGoal("delphi"),
    entrants: "round1",
    steps: [
      draftStep("round1"),
      {
        id: "summary",
        slot: "checker",
        instruction:
          "Summarise the anonymous answers: where they agree, where they disagree, the strongest reason on each side.",
        access: ["round1"],
      },
      {
        id: "round2",
        slot: "member",
        fanOut: "k",
        instruction: "Revise your answer once against the anonymous panel summary.",
        access: ["summary", { step: "round1", each: "same" }],
      },
      pickStep("pick", ["round1", "round2"]),
    ],
  },
  tournament: {
    goal: textGoal("tournament"),
    entrants: "draft",
    steps: [
      draftStep("draft"),
      {
        id: "match",
        slot: "checker",
        fanOut: "bracket",
        bracket: { entrants: "draft", schedule: "rounds" },
        instruction: "Pick the better of two candidate answers; the winner advances.",
        access: [],
      },
    ],
  },
  verification: {
    goal: textGoal("verification"),
    k: 1,
    steps: [
      {
        id: "draft",
        slot: "member",
        instruction: "Answer the task directly and completely.",
        access: [],
      },
      {
        id: "review",
        slot: "checker",
        instruction: "Review the draft for errors, omissions and unsupported claims.",
        access: ["draft"],
      },
      {
        id: "revise",
        slot: "member",
        instruction: "Revise the draft once, fixing the reviewer's issues (only when asked to).",
        access: ["draft", "review"],
      },
    ],
  },
  deliberation: {
    goal: textGoal("deliberation"),
    entrants: "propose",
    steps: [
      draftStep("propose"),
      {
        id: "revise",
        slot: "member",
        fanOut: "k",
        instruction: "Revise your proposal once, adopting what is better in your peers' proposals.",
        access: ["propose"],
      },
      pickStep("pick", ["propose", "revise"]),
    ],
  },
  chorus: {
    goal: textGoal("chorus"),
    entrants: "propose",
    steps: [
      draftStep("propose"),
      {
        id: "critique",
        slot: "peer",
        fanOut: "k",
        instruction: "Critique the proposal: its most important errors and gaps.",
        access: [{ step: "propose", each: "same" }],
      },
      {
        id: "revise",
        slot: "member",
        fanOut: "k",
        instruction: "Revise your proposal once against the critique it received.",
        // Every critique lands before any revision starts (one budget check between stages).
        access: [{ step: "propose", each: "same" }, "critique"],
      },
      pickStep("pick", ["propose", "revise"]),
    ],
  },
  pipeline: {
    goal: textGoal("pipeline"),
    steps: [
      {
        id: "stage",
        slot: "member",
        fanOut: "chain",
        instruction: (i: number) =>
          i === 0
            ? "Produce a complete first answer; later stages refine it."
            : "Improve the previous stage's handoff: fix errors, fill gaps, tighten it.",
        access: [],
      },
    ],
  },
} satisfies Record<string, FormationTemplate>;

export type TextFormationName = keyof typeof TEXT;
export const TEXT_TEMPLATES: Readonly<Record<TextFormationName, FormationTemplate>> = TEXT;

// ─── Numeric (arena) templates ───────────────────────────────────────────────

const numericGoal = (name: string) => (n: number) => `Arena round (${name}, ${n} members)`;

const NUMERIC = {
  ensemble: {
    goal: numericGoal("ensemble"),
    steps: [
      {
        id: "propose",
        slot: "member",
        fanOut: "k",
        instruction: "Forecast the round independently: a mean and an sd.",
        access: [],
      },
      {
        id: "combine",
        slot: "pipeline",
        instruction: "Median move and sd, trust 0.5 × agreement, the crew's clamps (pure code).",
        access: ["propose"],
      },
    ],
  },
  delphi: {
    goal: numericGoal("delphi"),
    steps: [
      {
        id: "round1",
        slot: "member",
        fanOut: "k",
        instruction: "Forecast the round independently: a mean and an sd.",
        access: [],
      },
      {
        id: "summary",
        slot: "pipeline",
        instruction:
          "Summarise the panel anonymously: median and range of means and sds, sorted reason snippets.",
        access: ["round1"],
      },
      {
        id: "round2",
        slot: "member",
        fanOut: "k",
        instruction: "Revise your round-1 forecast once against the anonymous summary.",
        access: ["summary", { step: "round1", each: "same" }],
      },
      {
        id: "combine",
        slot: "pipeline",
        instruction:
          "Median of the revisions (a failed revision keeps its round-1 forecast), the crew's clamps (pure code).",
        access: ["round1", "round2"],
      },
    ],
  },
} satisfies Record<string, FormationTemplate>;

export const NUMERIC_TEMPLATES: Readonly<Record<keyof typeof NUMERIC, FormationTemplate>> = NUMERIC;

// ─── The catalogue ───────────────────────────────────────────────────────────

export const FORMATIONS: Readonly<Record<FormationName, FormationEntry>> = {
  ensemble: {
    name: "ensemble",
    title: "Ensemble",
    summary: "independent answers, combined (the control for every other formation)",
    roles: ["member", "checker"],
    protocol: ["each member answers independently", "one checker picks or combines the answers"],
    fit: ["parallel", "verifiable"],
    crew: false,
    typed: TYPED_TEMPLATES.ensemble,
    text: TEXT_TEMPLATES.ensemble,
    numeric: { runtime: "catalogue", template: NUMERIC_TEMPLATES.ensemble },
  },
  skeptic: {
    name: "skeptic",
    title: "Skeptic",
    summary:
      "a statistician and an analyst propose; a skeptic sets how much of their move from the prior to trust",
    roles: ["statistician", "analyst", "skeptic"],
    protocol: [
      "a statistician proposes from the numbers",
      "an analyst proposes from the specifics",
      "a skeptic sets how much of their move from the prior to trust",
    ],
    fit: ["contested"],
    crew: false,
    typed: TYPED_TEMPLATES.skeptic,
  },
  deliberation: {
    name: "deliberation",
    title: "Deliberation",
    summary: "propose → cross-evaluate → converge",
    roles: ["proposer", "evaluator", "lead"],
    protocol: [
      "each member posts one proposal",
      "everyone evaluates the proposals",
      "the lead picks or merges one and its owner executes it",
      "a debrief records the lesson",
    ],
    fit: ["contested", "open-ended"],
    crew: true,
    markers: ["propos"],
    text: TEXT_TEMPLATES.deliberation,
    numeric: { runtime: "arena" },
  },
  chorus: {
    name: "chorus",
    title: "Chorus",
    summary: "parallel phases + crossfire review",
    roles: ["researcher", "builder", "reviewer", "lead"],
    protocol: [
      "members work each phase in parallel and post partial results",
      "each partial gets a crossfire review from a member of another role",
      "the lead merges and delivers",
    ],
    fit: ["parallel", "shared-artifact"],
    crew: true,
    markers: ["parallel", "review"],
    text: TEXT_TEMPLATES.chorus,
    numeric: { runtime: "arena" },
    room: true,
  },
  foundry: {
    name: "foundry",
    title: "Foundry",
    summary: "overseer → workers → merge gate",
    roles: ["overseer", "worker", "patrol", "gate"],
    protocol: [
      "the overseer splits the goal and assigns one piece per worker",
      "workers deliver pieces to the overseer and never merge",
      "patrol nudges stalled workers",
      "the merge gate reviews each piece before it lands",
    ],
    fit: ["hierarchical", "decomposable"],
    crew: true,
    markers: ["overseer", "merge"],
    crewOnly: "an overseer assigns work to a crew and merges it through a gate over time",
  },
  swarm: {
    name: "swarm",
    title: "Swarm",
    summary: "self-organizing expertise matching",
    roles: ["specialist"],
    protocol: [
      "each member claims a piece that matches its expertise",
      "a stuck member hands off its partial work",
      "the lead assembles what lands",
    ],
    fit: ["parallel", "open-ended"],
    crew: true,
    markers: ["claim"],
    crewOnly: "crew members self-select subtasks by expertise across many turns",
  },
  pipeline: {
    name: "pipeline",
    title: "Pipeline",
    summary: "stage-by-stage with handoff gates",
    roles: ["stage owner"],
    protocol: [
      "stages run in a fixed order, never skipped or in parallel",
      "each stage owner works from the previous handoff only",
      "a stage ends by posting its handoff for the next stage",
    ],
    fit: ["sequential"],
    crew: true,
    markers: ["stage", "handoff"],
    text: TEXT_TEMPLATES.pipeline,
    numeric: { runtime: "arena" },
  },
  debate: {
    name: "debate",
    title: "Debate",
    summary: "adversarial positions, judged",
    roles: ["advocate", "judge"],
    protocol: [
      "two advocates post sealed positions before any cross-talk",
      "each rebuts the other once",
      "one non-author judge decides in one message",
    ],
    fit: ["contested"],
    crew: true,
    markers: ["position", "judge"],
    text: TEXT_TEMPLATES.debate,
    numeric: { runtime: "arena" },
    room: true,
  },
  mapreduce: {
    name: "mapreduce",
    title: "MapReduce",
    summary: "fan out independent chunks, merge",
    roles: ["coordinator", "mapper", "reducer"],
    protocol: [
      "the coordinator splits the goal into independent chunks",
      "mappers process chunks in parallel with no cross-talk",
      "the reducer merges every result",
    ],
    fit: ["decomposable", "parallel"],
    crew: true,
    markers: ["chunk"],
    crewOnly: "fans a decomposed goal out to crew members as separate tasks",
    numeric: { runtime: "arena" },
  },
  blackboard: {
    name: "blackboard",
    title: "Blackboard",
    summary: "incremental refinement on one workspace",
    roles: ["contributor"],
    protocol: [
      "one shared workspace holds the current state",
      "members post improvements to the current state, never a private fork",
      "stop when two posts in a row change nothing material",
    ],
    fit: ["shared-artifact"],
    crew: true,
    markers: ["workspace"],
    crewOnly: "crew members refine one shared workspace incrementally",
    numeric: { runtime: "arena" },
  },
  symbiosis: {
    name: "symbiosis",
    title: "Symbiosis",
    summary: "mutual benefit, frontier scanning",
    roles: ["partner"],
    protocol: [
      "pair members from different strengths",
      "alternate short contributions in an exchange, each building on the last",
      "deliver when the exchange stops adding",
    ],
    fit: ["open-ended"],
    crew: true,
    // The crew brief is the pair's exchange; the project template is the frontier scan.
    markers: ["exchange"],
    templateMarkers: ["frontier"],
    crewOnly: "an ongoing exchange between crews scanning a frontier",
    numeric: { runtime: "arena" },
  },
  research: {
    name: "research",
    title: "Research",
    summary: "hypothesis → act → measure → record loop",
    roles: ["experimenter"],
    protocol: [
      "state one hypothesis",
      "run the smallest test",
      "measure and record the result",
      "keep or kill it, then take the next hypothesis",
    ],
    fit: ["open-ended"],
    crew: true,
    markers: ["hypothes"],
    crewOnly: "a hypothesis → act → measure → record loop that runs over days",
    numeric: { runtime: "arena" },
  },
  delphi: {
    name: "delphi",
    title: "Delphi",
    summary: "independent estimates → anonymized summary → revision",
    roles: ["estimator", "facilitator"],
    protocol: [
      "each member forms an estimate alone",
      "the facilitator posts an anonymized summary of the spread",
      "members revise once",
      "the final estimate keeps any surviving dissent",
    ],
    fit: ["contested", "open-ended"],
    crew: true,
    markers: ["anonymized summary", "revise"],
    typed: TYPED_TEMPLATES.delphi,
    text: TEXT_TEMPLATES.delphi,
    numeric: { runtime: "catalogue", template: NUMERIC_TEMPLATES.delphi },
  },
  tournament: {
    name: "tournament",
    title: "Tournament",
    summary: "pairwise elimination among candidates",
    roles: ["entrant", "referee"],
    protocol: [
      "each member produces one candidate alone",
      "candidates meet in pairs and a non-author picks each pair's winner",
      "winners advance until one remains",
      "the losers' best ideas are grafted into the winner",
    ],
    fit: ["contested", "parallel"],
    crew: true,
    markers: ["candidate", "pair"],
    typed: TYPED_TEMPLATES.tournament,
    text: TEXT_TEMPLATES.tournament,
    numeric: { runtime: "arena" },
  },
  verification: {
    name: "verification",
    title: "Verification",
    summary: "generate, then one verifier per aspect",
    roles: ["drafter", "verifier"],
    protocol: [
      "one drafter produces a candidate",
      "each verifier checks ONE aspect: correctness, requirements, evidence or safety",
      "a fail returns to the drafter once",
      "it is delivered when every aspect passes",
    ],
    fit: ["decomposable", "shared-artifact", "verifiable"],
    crew: true,
    markers: ["aspect", "correctness"],
    text: TEXT_TEMPLATES.verification,
    numeric: { runtime: "arena" },
    room: true,
  },
  auction: {
    name: "auction",
    title: "Auction",
    summary: "tasks awarded to the best-fit bid",
    roles: ["coordinator", "bidder"],
    protocol: [
      "the coordinator posts the lots",
      "members bid per lot with their fit and expected effort",
      "each lot goes to the best fit for its effort",
      "afterwards the coordinator records whether the winner's fit held up",
    ],
    fit: ["decomposable", "parallel"],
    crew: true,
    markers: ["bid"],
    crewOnly: "tasks are awarded to crew members by bid",
  },
  ledger: {
    name: "ledger",
    title: "Ledger",
    summary: "task + progress ledgers, replan on repeated stalls",
    roles: ["orchestrator", "member"],
    protocol: [
      "the orchestrator keeps a task ledger (facts, plan, owners)",
      "and a progress ledger (done, in flight, stuck)",
      "a step stuck twice gets a replan, not a retry",
    ],
    fit: ["hierarchical", "sequential"],
    crew: true,
    markers: ["ledger", "replan"],
    crewOnly: "a running account of commitments kept by a crew",
  },
  sharding: {
    name: "sharding",
    title: "Sharding",
    summary: "an oracle splits a failing target into claimable shards",
    roles: ["coordinator", "member"],
    protocol: [
      "the oracle (a test suite or checker) runs once",
      "each independent failing case becomes a shard",
      "members claim a shard, fix it without editing the oracle, and re-run it",
      "the target is done when the full oracle run passes",
    ],
    fit: ["decomposable", "parallel", "verifiable"],
    crew: true,
    markers: ["shard", "claim"],
    crewOnly: "work is partitioned across crew members holding their own state",
  },
  freeform: {
    name: "freeform",
    title: "Freeform",
    summary: "no fixed protocol: divide work by strength, merge the results",
    roles: [],
    protocol: ["divide work by strength", "merge the results", "complete when the goal is met"],
    fit: [],
    crew: true,
    markers: ["divide work"],
    crewOnly: "a crew-defined protocol with no fixed shape",
  },
};

/**
 * Legacy and retired names, accepted on input and in stored rows, never
 * advertised: `nsed` (Negotiate/Select/Execute/Debrief) is Deliberation, and a
 * project's `custom` orchestration is the catalogue's `freeform`.
 */
export const FORMATION_ALIASES: Readonly<Record<string, FormationName>> = {
  nsed: "deliberation",
  custom: "freeform",
};

/** A name's catalogue form: trimmed, lower-cased, a legacy alias resolved. Unknown names pass through. */
export function canonicalFormationName(name: string): string {
  const lower = name.trim().toLowerCase();
  return Object.hasOwn(FORMATION_ALIASES, lower) ? FORMATION_ALIASES[lower]! : lower;
}

export function formationEntry(name: string): FormationEntry | undefined {
  return Object.hasOwn(FORMATIONS, name) ? FORMATIONS[name as FormationName] : undefined;
}

/** The catalogue entry for a name or alias, or undefined. */
export function resolveFormation(name: string | undefined): FormationEntry | undefined {
  return name ? formationEntry(canonicalFormationName(name)) : undefined;
}

/** Formations that run as a persistent crew (and as `project <name> orchestrate`). */
export type CrewFormationName = Exclude<FormationName, "ensemble" | "skeptic">;

/** The crew formations, in catalogue order (`freeform` last). */
export const CREW_FORMATION_NAMES = FORMATION_NAMES.filter(
  (n) => FORMATIONS[n].crew,
) as CrewFormationName[];

/** Formations a room runs as its turn rule (`build formation`, `src/coordination/room-formations.ts`). */
export type RoomFormationName = Extract<FormationName, "debate" | "chorus" | "verification">;

/** The room formations, in catalogue order. */
export const ROOM_FORMATION_NAMES = FORMATION_NAMES.filter(
  (n) => FORMATIONS[n].room,
) as RoomFormationName[];

/** `name: summary` — one line per formation, for help, seeds and listings. */
export function formationLine(name: FormationName): string {
  return `${name}: ${FORMATIONS[name].summary}`;
}
