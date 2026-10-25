// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Status: demo. Project orchestration — `project <name> orchestrate
 * <pattern>` — is one of the four ways to run a catalogue formation
 * (`src/orchestration/formations/catalogue.ts`). See
 * docs/reference/feature-status.md.
 *
 * The pattern names, legacy aliases, descriptions and fit come from the
 * catalogue. A pattern's pool-note template is GENERATED: an opening note
 * built from the catalogue entry (title, summary, roles, protocol), plus the
 * project-only opening move and the four project conventions kept here (how
 * the protocol maps onto the board, task bundles and pools).
 * `test/formation-catalogue.test.ts` holds the templates, the crew briefs and
 * the catalogue together.
 */

import {
  CREW_FORMATION_NAMES,
  type CrewFormationName,
  canonicalFormationName,
  FORMATION_ALIASES,
  FORMATIONS,
  type TaskShape,
} from "../../orchestration/formations/catalogue";
import { protocolText } from "../../orchestration/formations/describe";

export type { TaskShape };

export interface TemplateNote {
  content: string;
  importance: number;
  type: string;
}

/**
 * The project orchestration patterns: the catalogue's crew formations, in
 * catalogue order, `freeform` (operator-defined conventions, no seeded
 * template) last.
 */
export const ORCHESTRATION_PATTERNS: readonly CrewFormationName[] = CREW_FORMATION_NAMES;

export type OrchestrationPattern = CrewFormationName;

/** The patterns that seed a template: every one but `freeform`. */
export type TemplatePattern = Exclude<OrchestrationPattern, "freeform">;

/** Legacy names accepted on input and in stored rows (the catalogue's aliases); never advertised. */
export const LEGACY_PATTERN_ALIASES = FORMATION_ALIASES;

/** Map a possibly-legacy pattern name to its catalogue form. */
export function normalizePatternName(name: string): string {
  return canonicalFormationName(name);
}

/** Human-facing help string listing patterns, pipe-separated. */
export const ORCHESTRATION_HELP = ORCHESTRATION_PATTERNS.join("|");

// ─── Pattern fit (the agent-facing recognition loop) ────────────────────────
// Which coordination *shapes* a goal can take, and which patterns fit each:
// the catalogue's `fit` and `summary`. It powers `suggestPatterns()` — the
// bridge that lets an agent recognize "this goal looks like a debate" instead
// of waiting for an operator to seed a pattern.

/** Which shapes each built-in pattern fits, with the catalogue's summary as its "why". */
export const PATTERN_FIT: Readonly<Record<TemplatePattern, { shapes: TaskShape[]; why: string }>> =
  Object.fromEntries(
    ORCHESTRATION_PATTERNS.filter((p) => p !== "freeform").map((p) => [
      p,
      { shapes: FORMATIONS[p].fit, why: FORMATIONS[p].summary },
    ]),
  ) as Record<TemplatePattern, { shapes: TaskShape[]; why: string }>;

const SHAPE_PATTERNS: { shape: TaskShape; re: RegExp }[] = [
  {
    shape: "contested",
    re: /\b(debate|argue|disagree|pros and cons|which is better|decide between|trade-?off|controvers|for or against|compare (the )?(candidates|solutions|options)|pick the best|independent estimates)\b/,
  },
  {
    shape: "decomposable",
    re: /\b(break (it|this) down|decompose|sub-?tasks?|multiple (parts|pieces|files|modules)|several (parts|components)|each (file|module|section))\b/,
  },
  {
    shape: "parallel",
    re: /\b(in parallel|simultaneous|at the same time|independently|fan out|across (many|several|all))\b/,
  },
  {
    shape: "sequential",
    re: /\b(step by step|stages?|pipeline|first.*then|in sequence|in order)\b/,
  },
  {
    shape: "hierarchical",
    re: /\b(oversee|coordinate a team|delegate|manage the work|merge queue|sub-?lead)\b/,
  },
  {
    shape: "shared-artifact",
    re: /\b(shared (doc|document|workspace|artifact)|collaborat\w* on (one|a single)|co-?author|build (it )?together)\b/,
  },
  {
    shape: "open-ended",
    re: /\b(explore|research|investigate|figure out|open-?ended|brainstorm|discover|experiment)\b/,
  },
  {
    shape: "verifiable",
    re: /\b(failing (tests?|cases?|checks?)|test suite|tests? (pass|fail)|verif(y|ied|ication)|fact-?check|check (it |them )?against|reference implementation|conformance)\b/,
  },
];

/** Keyword pass classifying a goal/focus string into coordination shapes. */
export function detectTaskShapes(text: string | undefined): TaskShape[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return [...new Set(SHAPE_PATTERNS.filter(({ re }) => re.test(lower)).map(({ shape }) => shape))];
}

/**
 * Suggest orchestration patterns that fit a goal/focus, ranked by how many of
 * its detected shapes they cover. Returns `[]` when the goal shows no
 * coordination shape (solo work) — the recognition loop stays quiet then.
 */
export function suggestPatterns(
  text: string | undefined,
  limit = 2,
): { pattern: string; why: string }[] {
  const shapes = detectTaskShapes(text);
  if (shapes.length === 0) return [];
  return (Object.entries(PATTERN_FIT) as [string, { shapes: TaskShape[]; why: string }][])
    .map(([pattern, fit]) => ({
      pattern,
      why: fit.why,
      score: fit.shapes.filter((s) => shapes.includes(s)).length,
    }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pattern, why }) => ({ pattern, why }));
}

const DELIBERATION_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Deliberation propose phase: post a proposal to the project board with a clear title and " +
      "body — `board post project:<name> [proposal] <title> | <body>`. Tag proposals with " +
      "[proposal]. Others respond with numeric votes (1-10) using " +
      "`board vote <postId> up|down [score 1-10]`. Proposals tend to advance when they have " +
      "majority support (avg >= 6).",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Deliberation evaluate phase: read proposals on the board, score them 1-10, and reply " +
      "with reasoning. Evaluation ends when all active members have voted or after a reasonable " +
      "discussion period. Check scores with `board scores <postId>`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Deliberation execute phase: once a proposal passes, create tasks from it (`task create " +
      "<title> | <description>`). Assign tasks " +
      "to the project bundle. Claim and work tasks individually. Submit results for review. " +
      "The proposer or project creator approves submissions.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Deliberation debrief phase: consider marking debrief complete once a [lesson] pool note is posted " +
      "summarizing what worked, what failed, and what to do differently. Link the lesson " +
      "to the original [proposal] via `note link <lesson-id> <proposal-id> part_of`. " +
      "Then the next propose phase can begin. The cycle tends to be more valuable when the lesson " +
      "outlives the cycle — without it, the cycle risks becoming just meetings.",
    importance: 7,
    type: "skill",
  },
];

const CHORUS_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Chorus phases: the project creator creates three convoys via `task bundle <name>` — " +
      "'research', 'build', 'review'. Research completes before build; build before review. " +
      "Inside a phase every task is parallel-claimable. Research outputs land in the pool tagged " +
      "[research-finding]. Build tasks cite the findings they used with `note link " +
      "<build-note> <finding-note> supports`. Review tasks score build outputs.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Chorus wall: before you pick a slice, read the group channel (`channel history <channel>`) " +
      "to confirm no sibling is already on it, then post one line: `channel send <channel> taking: " +
      "<slice>`. Post again only when the slice is done or blocked — the wall records state " +
      "changes, not progress chatter. If a sibling claims your target, picking something else " +
      "tends to keep parallelism alive.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Chorus role diversity: assign the same phase to agents with different roles/traits. " +
      "For Review, assign agents whose role lineage differs from the builders (adversarial " +
      "by construction). Use `role view <name>` and composed traits. A chorus with all the same " +
      "role is just one voice repeated — diversity is the mechanism, not the decoration.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Chorus crossfire review gate: consider treating a build task as done once >=2 independent reviewers " +
      "(different roles) post scores on the board, average >=6, with at least one [critique] " +
      "reply. Reviewers can link via `note link <review> <build> supports|contradicts` to build " +
      "the argument graph. Rework if crossfire surfaces real issues. Recording the ruling in the pool " +
      "tagged [crossfire-ruling] lets future chorus runs cite it rather than re-argue.",
    importance: 7,
    type: "skill",
  },
];

const FOUNDRY_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Foundry hierarchy: the project creator is the Overseer. They designate established " +
      "members as Patrol and as Gate — supervision capability follows standing and witnessed " +
      "competence under the world's autonomy posture, not a tier number. Workers (any rank) claim " +
      "tasks freely. The Overseer routes outside 'tell's and public requests — consider not bothering workers " +
      "directly. Patrol and Gate usually avoid claiming worker tasks; their job is supervision, not " +
      "execution.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Foundry convoys: organize work into named convoys via `task bundle <name>`. Each " +
      "convoy has a landing target posted to the board. Workers tend to claim from convoys rather than " +
      "loose tasks. A convoy lands as a unit — consider having every task in it pass the " +
      "Gate before the convoy is marked landed. Post convoy status updates to the board " +
      "tagged [convoy-status].",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Foundry Patrol and nudges: each cycle Patrol checks the workers — `observe <worker>` " +
      "shows their last command and how long ago, `task info <id>` shows the claim and its " +
      "lease. Signs of a stall: no progress for ~20 min, the same action repeated, repeated " +
      "failures. On detection: `tell <worker> nudge: <specific suggestion>`, or reassign the " +
      "task and post [stall] on the board with the reason. Nothing flags stalls for Patrol; " +
      "only an expired lease reopens a task on its own.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Foundry Gate — merge queue convention: one practice crews have found helpful is having " +
      "the Gate handle landings rather than workers merging directly. When a worker submits, the Gate " +
      "reviews against the task spec and either accepts (`board post project:<name> [landed] " +
      "<task> | <summary>`, adds a pool note, " +
      "closes the task) or rejects (task stays claimed, worker reworks with the Gate's feedback). The Gate " +
      "can batch landings. This tends to keep concurrent work safer.",
    importance: 7,
    type: "skill",
  },
];

const SWARM_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Swarm expertise: on joining, set your expertise with `memory set expertise <skills>`. " +
      "Before claiming a task, check whether another agent is a better fit: `who` shows who " +
      "is here, and `tell <agent> <task id> — your expertise?` asks directly.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Swarm claiming: browse open tasks with `task list`. Self-claim tasks that match " +
      "your expertise using `task claim <id>`. If a task needs skills you lack, consider " +
      "leaving it for a better-matched agent. Maximizing parallel work tends to help.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Swarm handoff payload: handoffs work best when they carry three things in one " +
      '`tell <agent> ...` message — (1) the expertise being invoked ("calling you for X"), ' +
      '(2) the pool note id of the prior work ("see pool note #42"), and (3) the expected ' +
      'next step ("produce Y, then hand off to someone who does Z"). Handoffs missing these ' +
      "often lose context. Consider adding a matching pool note tagged [handoff] linking old work " +
      "to new.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Swarm convergence: periodically check project status with `project <name> tasks`. " +
      "If a task is stalling, `tell` the best-matched agent directly. Use `reflect` to " +
      "consolidate learnings across handoffs. The swarm self-organizes — no one waits " +
      "for permission.",
    importance: 7,
    type: "skill",
  },
];

const PIPELINE_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Pipeline stages: the project leader defines stages as ordered child tasks in the " +
      "bundle (e.g., research → analysis → synthesis → review). Each stage task's " +
      "description specifies inputs it expects and outputs it is expected to produce: " +
      "`task create Stage 1: research | inputs: <...> outputs: <...>`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline stage contract: before any stage begins, the stage owner might post a contract " +
      "note to the pool tagged [stage-N-contract] specifying input shape, output " +
      "shape, and rejection criteria (`pool <name> add [stage-N-contract] in: <shape> | out: " +
      "<shape> | reject: <criteria>`). Downstream stages can read the contract, not just the prose. " +
      "Contracts act as the stage's API — changing the contract means upstream/downstream " +
      "may need to re-align. Contracts help stages align; starting without one tends to cause mismatch.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline handoff: when a stage completes, the agent posts results to the board " +
      "with tag [stage-N-output] (`board post project:<name> [stage-N-output] <title> | " +
      "<result>`) and sends a channel message signaling the next stage can begin. The next stage's agent might read the [stage-N-contract] first, check " +
      "the output against it, then start work.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline quality: each stage can review the previous stage's output against the " +
      "contract before processing. If the input seems off from the contract, consider flagging it " +
      "by replying on the board and notifying via channel. The upstream agent can rework. Use `pool <name> " +
      "add <lesson>` to record stage lessons for future pipeline runs.",
    importance: 7,
    type: "skill",
  },
];

const DEBATE_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Debate independence practice: consider drafting your position in your own notes before reading " +
      "board posts. Use `note <position> type decision` privately, then post to the " +
      "board when the judge signals the sealed phase is over. Reading others' positions " +
      "before drafting can lead to groupthink — independence tends to improve quality. " +
      "Consider posting positions tagged [position:sealed] until the judge opens them.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Debate argumentation: once positions are unsealed, respond using `board reply` with " +
      "supporting or opposing arguments. Use `note link <id> <id> supports` or `note link " +
      "<id> <id> contradicts` to build a structured argument graph. Score positions with " +
      "`board vote <postId> up|down [score 1-10]`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Debate judging: the project creator or designated judge reviews all positions " +
      "and scores with `board scores <postId>`. The judge posts a synthesis " +
      "tagged [ruling] that weighs arguments (`board post project:<name> [ruling] <decision> | " +
      "<reasoning>`). The ruling becomes a task or action item.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Debate record: after each ruling, add the decision and reasoning to the pool " +
      "using `pool <name> add`. Use `reflect` to consolidate debate learnings. " +
      "Future debates should reference prior rulings via `pool <name> recall` to " +
      "build on precedent rather than re-arguing settled questions.",
    importance: 7,
    type: "skill",
  },
];

const MAPREDUCE_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "MapReduce mapping: the coordinator creates one child task per chunk in the project " +
      "bundle (`task create Chunk N: <boundaries> | <spec>`). Each task description fully " +
      "specifies the chunk boundaries so workers need no coordination. Workers claim chunks " +
      "freely — all chunks are independent.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "MapReduce execution: work your chunk in isolation. Avoid reading other workers' " +
      "outputs or coordinating with them — independence is the central convention. Add your " +
      "chunk results to the pool with `pool <name> add chunk-N: <result>` and submit " +
      "your task when done.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "MapReduce reduction: once all chunk tasks are completed (check with " +
      "`project <name> tasks`), the reducer collects all results from the pool using " +
      "`pool <name> recall chunk`. The reducer synthesizes a merged output and posts " +
      "it to the board as [merged-result].",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "MapReduce tracking: use `project <name> status` to monitor chunk completion. " +
      "If a chunk stalls, the coordinator can reassign it. After reduction, add the " +
      "final synthesis to the pool and use `reflect` to capture lessons about chunk " +
      "granularity for future MapReduce runs.",
    importance: 7,
    type: "skill",
  },
];

const SYMBIOSIS_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Symbiosis profiling: on joining, describe your exploration profile in the pool with " +
      "`pool <name> add [profile] ...` — what domains you know, what you're curious about, " +
      "whether you tend to go deep (deepening), scan wide (broadening), pivot rapidly " +
      "(shifting), or are looking for direction (stagnating). Update your profile as your " +
      "interests evolve. Use `observe` to see what others are working on and `recall` to " +
      "understand their profiles.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Symbiosis frontier scanning: periodically scan for epistemic frontiers — knowledge " +
      "gaps the team hasn't explored. Use `pool <name> recall` across topics to find sparse " +
      "areas. Use `note graph` to find disconnected clusters. Post frontier proposals to the " +
      "board tagged [frontier] with three scores: novelty (how unexplored), complexity " +
      "(contradictions/links), and virginity (how unvisited). Others vote on which frontiers " +
      "to pursue.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Symbiosis discernment & assignment: when assigning frontier tasks, use discernment — " +
      "match frontiers to entities based on both epistemic interest AND entity profile. " +
      "Synergy frontiers (novel AND relevant to someone's profile) get priority. Create tasks " +
      "from top-voted frontiers and tag them with the target profile type. Deepening entities " +
      "take depth-frontiers, broadening entities take breadth-frontiers. Post assignments to " +
      "the board tagged [discernment] (`board post project:<name> [discernment] <frontier> | " +
      "<entity and why>`).",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Symbiosis mode triggers: `novelty` shows each member's action-diversity need (high " +
      "means their recent actions repeat) and the knowledge gap in their room. When most " +
      "members show high need, shift to Breadth: generalists scan wide, deepening agents " +
      "pause. When gaps close and needs stay low, shift to Depth: specialists go deep. Post " +
      "[mediation] to the board only when the mode changes. These are judgement calls, not " +
      "thresholds the engine enforces.",
    importance: 7,
    type: "skill",
  },
];

const RESEARCH_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Research cycle — before each iteration, consider setting your hypothesis: " +
      "`memory set hypothesis <what you expect to happen>`. " +
      "Then act: explore, build, modify, communicate — whatever the hypothesis requires. " +
      "After acting, measure: use `orient` for memory health, `score` for standing, " +
      "`novelty` for exploration coverage, `experiment record <experiment> <metric> <value>` " +
      "for structured data. Consider producing a measurement each iteration.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Research recording — after each iteration, record results with: " +
      "`note Gen N: hypothesis=X metric=Y result=Z importance 8 type episode`. " +
      "Post to the project board for team visibility: " +
      "`board post project:<name> Gen N | hypothesis=X result=Z`. " +
      "Add key findings to the pool: `pool project:<name> add <finding> importance <N>`. " +
      "Consistent recording lets the team recall what worked across all agents.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Research decisions — after measuring, decide: keep or revert. " +
      "If the metric improved, consider recording: `note Keeping change: <reason> type decision`. " +
      "If it worsened, consider reverting your change and recording: `note Reverting: <reason> type decision`. " +
      "Update your strategy: `memory set strategy <what to try next>`. " +
      "Running `reflect` periodically can synthesize learnings into an episode. " +
      "Recalling past results before starting a new hypothesis helps: `recall <topic>` or " +
      "`pool project:<name> recall <topic>`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Research coordination — multiple agents explore different directions simultaneously. " +
      "Before starting a new direction, check the board and pool for what others have tried: " +
      "`pool project:<name> recall <topic>`. Avoid duplicating experiments. " +
      "If another agent's finding is relevant to your work, build on it — cite their note ID " +
      "with `note link <yours> <theirs> supports`. " +
      "Use the project channel for a finding that changes someone's direction, or to ask for help. " +
      "The pool is the collective memory — everything worth knowing should be there.",
    importance: 7,
    type: "skill",
  },
];

const BLACKBOARD_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Blackboard shared-work convention: one practice that often helps is keeping " +
      "project work in the pool rather than private notes — this way the team can build on it. " +
      "Reasoning you keep to yourself is reasoning the team may miss. Private core memory works well " +
      "for cross-project identity; project-specific thinking tends to be more useful in the pool. " +
      "If you write `note <text>` for project work, consider also adding it to " +
      "`pool <name>` so others can build on it.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Blackboard reading: before contributing, consider reading the current state with " +
      "`pool <name> recall <topic>`. Understanding what others have written helps. Use " +
      "`pool <name> list` to see all contributions. The blackboard serves as the shared " +
      "reference.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Blackboard writing: add observations, hypotheses, and partial solutions to " +
      "the pool with `pool <name> add <content> importance <N>`. Tag contributions " +
      "by type: observation for raw data, inference for derived conclusions, " +
      "decision for agreed actions. Higher importance surfaces first in recall.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Blackboard structure & convergence: use `note link` to connect related pool " +
      "contributions into a knowledge graph ('supports', 'contradicts', 'part_of'). " +
      "Periodically use `reflect` to synthesize blackboard contents into higher-order " +
      "understanding. When the group believes a question is resolved, post the conclusion " +
      "to the board and create a task to act on it. The blackboard keeps growing — old " +
      "contributions remain as history.",
    importance: 7,
    type: "skill",
  },
];

const DELPHI_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Delphi drafting: consider drafting your estimate privately first — `memory kv set " +
      "estimate <value> because <reasons>` — before reading the board or channel. Once drafted, send it to " +
      "the facilitator only: `tell <facilitator> [estimate] <value> | <reasons>`. For a choice, " +
      "each member's estimate is their pick plus a confidence ([estimate] <option>, 0.7 | " +
      "<reasons>). Posting to the board before everyone has drafted tends to anchor the others. " +
      "The facilitator can confirm on the project channel when every member has sent a draft.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Delphi summary: the facilitator posts one anonymized summary per round, e.g. `board post " +
      "project:<name> [delphi-summary] Round 1 | range=<low>..<high> median=<m> reasons: <key " +
      "reasons>`. It lists the range, the median and the key reasons on each side, with no names " +
      "attached. Adding the same summary to the pool with `pool <name> add [delphi-summary] " +
      "<summary>` often helps later rounds and later projects recall it.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Delphi revision: after reading the summary, each member revises once (twice at most) — " +
      "privately first again, then by `tell <facilitator> <revision>`. A revision that moves can " +
      "say which reason moved it; one that stays put can restate the reason that holds. " +
      "Dissenting reasons tend to be the most valuable part of a round: rather than dropping " +
      "them, the facilitator can keep each as a pool note and link it to the round summary with " +
      "`note link <dissent-id> <summary-id> contradicts`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Delphi convergence & record: consider stopping when the range stops narrowing between " +
      "rounds, or after the second revision. A spread that collapses in the first revision with " +
      "no new reasons is a warning sign — it often means anchoring rather than agreement; asking " +
      "one member to argue the strongest outlying reason before closing helps. Record the outcome " +
      "in the pool tagged [delphi-ruling]: the final range and median, the dissents that survived " +
      "(linked with `note link`), and what moved the estimates, so future rounds can cite it.",
    importance: 7,
    type: "skill",
  },
];

const TOURNAMENT_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Tournament entries: consider one task per entrant — `task create Candidate: <goal> | " +
      "<spec>` — or a single bounty task (`task create <goal> | <spec> bounty`) so several members " +
      "can claim and submit against the same spec. Each entrant works alone and posts the finished " +
      "candidate with `board post project:<name> [candidate] <title> | <summary and where the work " +
      "lives>`. Candidates tend to be most comparable when every entrant works to the same spec.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Tournament bracket: the coordinator pairs the candidates (an odd one out gets a bye) and " +
      "posts each match: `board post project:<name> [match] Round 1: <a> vs <b> | <criteria>`. " +
      "Judges who authored neither candidate score both candidate posts with `board vote " +
      "<postId> up [score 1-10]` and compare with `board scores <postId>`; where a decision " +
      "backend is configured, `decision choose <question> | <candidate a> | <candidate b>` is one " +
      "more advisory input. The winner of each match advances to the next round.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Tournament rulings: consider recording each match result as a reply on the match post — " +
      "`board reply <postId> [ruling] <winner> over <loser> because <reason>` — and in the pool " +
      "with `pool <name> add [ruling] <match and reason>`, so the bracket stays auditable. A close " +
      "match tends to deserve a second judge rather than a coin flip. Each ruling can also name " +
      "the strongest idea in the losing candidate; that list feeds the graft step.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Tournament final & graft: once one candidate remains, its owner considers grafting the " +
      "named best ideas from the losers, linking each graft to its source with `note link " +
      "<winner-note> <loser-note> supports`. The coordinator approves the winning submission " +
      "(`task approve <id> <claimant>`) and records a [tournament-result] pool note: the bracket, " +
      "each ruling, what was grafted, and which criteria decided close matches. Future " +
      "tournaments can recall it to judge faster.",
    importance: 7,
    type: "skill",
  },
];

const VERIFICATION_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Verification generation: authors produce candidates as ordinary tasks (`task claim <id>`, " +
      "then `task submit <id> <candidate and where it lives>`) and register each one with `board " +
      "post project:<name> [candidate] <title> | <summary>`. Consider stating up front which " +
      "requirements the candidate claims to meet — that list becomes the verifiers' checklist. " +
      "Authors usually leave the verification of their own candidates to others.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Verification aspects: the coordinator creates one verification task per aspect per " +
      "candidate, e.g. `task create Verify <candidate>: correctness | <what to check>`. Each " +
      "verifier checks only its aspect. Verifiers from a different role lineage than the author " +
      "tend to catch more — `role view <name>` shows a role's traits. Where a decision backend is " +
      "configured, a verifier can self-check a draft verdict with `decision check <what was " +
      "checked> | <draft verdict>`; the score stays advisory.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Verification by execution: a claim that can be checked by running something is run " +
      "rather than argued. For code, consider `code run <check>` (tests, typecheck, lint) and " +
      "quoting the output in the verdict; for data, re-run the calculation; for a citation, " +
      "fetch the source (`web fetch <url>`) and confirm the quoted line. A verdict posts as a " +
      "reply on the candidate: `board reply <postId> [verdict] <aspect>: pass|fail | <evidence>`.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Verification gate: consider treating a candidate as passed only when every aspect " +
      "verifier has posted a pass. Each failed aspect becomes a rework task for the author — " +
      "`task create Rework <candidate>: <aspect> | <the failing evidence>` — and only that aspect " +
      "is re-verified afterwards. Link each verdict to the candidate with `note link <verdict-id> " +
      "<candidate-id> supports|contradicts`, and record the gate outcome in the pool tagged " +
      "[verification-ruling] so aspects that fail repeatedly become visible across candidates.",
    importance: 7,
    type: "skill",
  },
];

const AUCTION_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Auction lots: the coordinator creates the tasks (`task create <title> | <spec> " +
      "standing:N`, placed in the project bundle with `task assign <id> <bundle_id>`) and opens " +
      "bidding with one board post per lot: `board post project:<name> [lot] Task <id> | <spec " +
      "and deadline>`. A lot tends to attract useful bids when its spec says what done looks " +
      "like. Members usually hold off on `task claim` until the award is posted.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Auction bids: bid by replying on the lot — `board reply <postId> [bid] fit: <relevant " +
      "past results, with note or task ids> | cost: <expected effort or time>`. Evidence tends to " +
      "count for more than self-description: cite finished tasks or pool notes. A bidder's " +
      "standing is visible with `standing show <name>`. Consider bidding only on lots you could " +
      "start soon; an award that sits idle tends to cost more than a lower-fit one that moves.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Auction award: once bidding closes, the coordinator weighs fit against cost and posts the " +
      "award as a reply: `board reply <postId> [award] <winner> — <why this bid>`. The winner " +
      "claims with `task claim <id>` and renews the lease with `task heartbeat <id>` while " +
      "working. If the lease lapses (`task recover` releases expired claims), the coordinator can " +
      "award the lot to the runner-up rather than reopen bidding.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Auction follow-up: after approval (`task approve <id> <claimant>`), the coordinator " +
      "records whether the winner's claimed fit held up — `pool <name> add [award-check] task " +
      "<id> winner=<name> claimed=<fit> held=yes|no | <what differed>`. Before the next award, " +
      "`pool <name> recall award-check <name>` surfaces a bidder's track record, so fit claims " +
      "that held up tend to count for more over time.",
    importance: 7,
    type: "skill",
  },
];

const LEDGER_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Ledger task ledger: the orchestrator writes it at the start — `pool <name> add " +
      "[task-ledger] facts: <verified> | guesses: <to check> | plan: <steps> | assignments: <task " +
      "ids and members> importance:9` — and adds a new version whenever the plan changes, linking " +
      "it to the previous one with `note link <new-id> <old-id> part_of`. Keeping verified facts " +
      "apart from guesses tends to show which step to check first.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Ledger progress ledger: after each step, the orchestrator updates it — `pool <name> add " +
      "[progress-ledger] done: <ids> | in flight: <ids and claimants> | stuck: <ids and why> | " +
      "next: <step>`. Members help by keeping claims live (`task heartbeat <id>`) and submitting " +
      "promptly (`task submit <id> <report>`). `task list` and `task info <id>` show each claim " +
      "and its lease, which is the progress ledger's ground truth.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Ledger stall signal: a claim whose lease expired, or one that shows no progress between " +
      "two ledger updates, is the stall signal. `task recover` releases expired leases back to " +
      "open. A member who is stuck can say so rather than go quiet: `tell <orchestrator> [stuck] " +
      "<task id> | <what blocks it>`. On a first stall the orchestrator can nudge the claimant or " +
      "reassign the task. Each stall goes into the progress ledger with its cause, so repeated " +
      "stalls on the same step stay visible.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Ledger replanning: when a member reports being stuck twice on the same step, or the same " +
      "step stalls twice, the orchestrator replans rather than retries — revisit the task " +
      "ledger's facts and guesses, write a new plan version, and cancel tasks only the old plan " +
      "needed (`task cancel <id>`). The debrief is a [ledger-lesson] pool note: which guess failed, what the replan " +
      "changed and how many stalls it took, so future orchestrators can recall it.",
    importance: 7,
    type: "skill",
  },
];

const SHARDING_CONVENTIONS: TemplateNote[] = [
  {
    content:
      "Sharding setup: the coordinator runs the oracle once (for code, `code run <check>`) and " +
      "records the failing set as the baseline — `pool <name> add [oracle-baseline] <oracle " +
      "command> | failing: <cases>`. Each failing case, or a small group sharing one cause, " +
      "becomes a task in the project bundle: `task create Shard: <case> | <oracle command and " +
      "expected result>`. Shards tend to parallelize well when each maps to its own files or cases.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Sharding work: claim a shard with `task claim <id>`, fix it, then re-run the oracle for " +
      "that shard and for the whole target before `task submit <id> <oracle output>`. Quoting the " +
      "oracle output tends to beat describing it. If a fix breaks another shard, consider saying " +
      "so on the project channel — `channel send <channel> [shard-conflict] <ids>` — rather than " +
      "working around it silently.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Sharding oracle convention: the member fixing a shard leaves the oracle alone — the tests, " +
      "the reference implementation, the checker. A case that looks wrong in the oracle itself " +
      "becomes a separate question for someone else to review: `board post project:<name> " +
      "[oracle-question] <case> | <why it looks wrong>`. Keeping the oracle fixed is what lets " +
      "each pass mean something. If the checker cannot run at all, post an [oracle-question], " +
      "verify by hand and deliver with the limitation stated.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Sharding done: consider a shard done when the oracle passes it and nothing that passed " +
      "before regresses; the coordinator approves with `task approve <id> <claimant>`. The target " +
      "is done when the full oracle run passes. Record the closing run as a [sharding-result] pool " +
      "note — the baseline, the final run, and any oracle questions and how they were settled — " +
      "linked to the baseline with `note link <result-id> <baseline-id> supports`.",
    importance: 7,
    type: "skill",
  },
];

/**
 * Each pattern's project-only opening move, appended to its generated opening
 * note: how the catalogue protocol starts on a project's board and pool.
 */
const PROJECT_START: Readonly<Record<TemplatePattern, string>> = {
  deliberation: "Use the project board for proposals.",
  chorus:
    "The group channel is the wall: post what you take and what you finish so siblings don't duplicate.",
  foundry:
    "The overseer is the single interface for outside requests; distribute decisions downward.",
  swarm:
    "There is no fixed leader: declare expertise with `memory set expertise <domain>` and hand work on with `tell`.",
  pipeline:
    "Use the project board as a conveyor belt: post stage outputs for the next stage to consume.",
  debate: "Agents argue with evidence and score each other's arguments before the judge decides.",
  mapreduce: "Workers process their chunks with no cross-talk until the merge.",
  blackboard: "The project pool IS the shared blackboard where every agent reads and writes.",
  symbiosis:
    "The pool tracks the team's collective knowledge frontier; each member profiles its own exploration style.",
  research: "The pool accumulates all findings; the board is the shared results log.",
  delphi:
    "Name one facilitator (not an estimator) before the first round. Start with: `board post project:<name> [delphi] facilitator: <name> | question: <the question>`.",
  tournament:
    "Start with: `board post project:<name> [tournament] <goal> | entrants: <names> | criteria: <criteria>`.",
  verification:
    "Start with: `board post project:<name> [aspects] <candidate> | correctness, requirements, evidence, safety`.",
  auction:
    "The auction is a convention over ordinary tasks and claims. Start with: `pool <name> recall award-check` to see how past bidders' fit claims held up.",
  ledger:
    "Both ledgers live in the pool as notes any member can recall. Start with: `pool <name> recall task-ledger` to find the current plan, if one exists.",
  sharding:
    "The oracle, not opinion, decides when a shard is done. Start with: `pool <name> recall oracle-baseline` to see whether a baseline run already exists.",
};

const PROJECT_CONVENTIONS: Readonly<Record<TemplatePattern, TemplateNote[]>> = {
  deliberation: DELIBERATION_CONVENTIONS,
  chorus: CHORUS_CONVENTIONS,
  foundry: FOUNDRY_CONVENTIONS,
  swarm: SWARM_CONVENTIONS,
  pipeline: PIPELINE_CONVENTIONS,
  debate: DEBATE_CONVENTIONS,
  mapreduce: MAPREDUCE_CONVENTIONS,
  blackboard: BLACKBOARD_CONVENTIONS,
  symbiosis: SYMBIOSIS_CONVENTIONS,
  research: RESEARCH_CONVENTIONS,
  delphi: DELPHI_CONVENTIONS,
  tournament: TOURNAMENT_CONVENTIONS,
  verification: VERIFICATION_CONVENTIONS,
  auction: AUCTION_CONVENTIONS,
  ledger: LEDGER_CONVENTIONS,
  sharding: SHARDING_CONVENTIONS,
};

/**
 * A pattern's opening note, generated from its catalogue entry: title,
 * summary, roles and protocol, then the project's opening move.
 */
export function projectOpeningNote(pattern: TemplatePattern): TemplateNote {
  const entry = FORMATIONS[pattern];
  const roles = entry.roles.length ? ` Roles: ${entry.roles.join(", ")}.` : "";
  return {
    content:
      `This project uses ${entry.title} orchestration (${entry.summary}).${roles} ` +
      `Protocol: ${protocolText(entry)}. ${PROJECT_START[pattern]}`,
    importance: 9,
    type: "skill",
  };
}

/** A pattern's project template: the generated opening note, then its project conventions. */
export function projectTemplate(pattern: TemplatePattern): TemplateNote[] {
  return [projectOpeningNote(pattern), ...PROJECT_CONVENTIONS[pattern]];
}

/**
 * The project pool-note template per pattern (`project <name> orchestrate
 * <pattern>`), by catalogue name (`freeform` has none).
 */
export const ORCHESTRATION_TEMPLATES: Readonly<Record<TemplatePattern, TemplateNote[]>> =
  Object.fromEntries(
    ORCHESTRATION_PATTERNS.filter((p): p is TemplatePattern => p !== "freeform").map((p) => [
      p,
      projectTemplate(p),
    ]),
  ) as Record<TemplatePattern, TemplateNote[]>;

export const DELIBERATION_TEMPLATE = ORCHESTRATION_TEMPLATES.deliberation;
export const CHORUS_TEMPLATE = ORCHESTRATION_TEMPLATES.chorus;
export const FOUNDRY_TEMPLATE = ORCHESTRATION_TEMPLATES.foundry;
export const SWARM_TEMPLATE = ORCHESTRATION_TEMPLATES.swarm;
export const PIPELINE_TEMPLATE = ORCHESTRATION_TEMPLATES.pipeline;
export const DEBATE_TEMPLATE = ORCHESTRATION_TEMPLATES.debate;
export const MAPREDUCE_TEMPLATE = ORCHESTRATION_TEMPLATES.mapreduce;
export const BLACKBOARD_TEMPLATE = ORCHESTRATION_TEMPLATES.blackboard;
export const SYMBIOSIS_TEMPLATE = ORCHESTRATION_TEMPLATES.symbiosis;
export const RESEARCH_TEMPLATE = ORCHESTRATION_TEMPLATES.research;
export const DELPHI_TEMPLATE = ORCHESTRATION_TEMPLATES.delphi;
export const TOURNAMENT_TEMPLATE = ORCHESTRATION_TEMPLATES.tournament;
export const VERIFICATION_TEMPLATE = ORCHESTRATION_TEMPLATES.verification;
export const AUCTION_TEMPLATE = ORCHESTRATION_TEMPLATES.auction;
export const LEDGER_TEMPLATE = ORCHESTRATION_TEMPLATES.ledger;
export const SHARDING_TEMPLATE = ORCHESTRATION_TEMPLATES.sharding;
