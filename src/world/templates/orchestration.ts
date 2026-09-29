// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface TemplateNote {
  content: string;
  importance: number;
  type: string;
}

/**
 * Canonical list of built-in orchestration pattern names. Single source
 * of truth — every site that validates, enumerates, or documents the
 * pattern set should import this. Adding a pattern means adding a line
 * here and a template export below, and nothing else.
 *
 * Order is intentional: Chorus + Foundry (Marina-native) first, then
 * the generational-memory patterns, then the estimation / selection /
 * allocation patterns added 2026-09, then `custom` last.
 */
export const ORCHESTRATION_PATTERNS = [
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
  "custom",
] as const;

export type OrchestrationPattern = (typeof ORCHESTRATION_PATTERNS)[number];

/**
 * Deprecated pattern names still accepted on input and possibly present in
 * persisted rows (project orchestration values, crew formations). Descriptive
 * names classify organization strategies better than acronyms long-term, so
 * the acronyms are normalized to their functional form everywhere and never
 * advertised. `nsed` (Negotiate/Select/Execute/Debrief) → `deliberation`.
 */
export const LEGACY_PATTERN_ALIASES: Record<string, OrchestrationPattern> = {
  nsed: "deliberation",
};

/** Map a possibly-legacy pattern name to its canonical form. */
export function normalizePatternName(name: string): string {
  return LEGACY_PATTERN_ALIASES[name] ?? name;
}

/** Human-facing help string listing patterns, pipe-separated. */
export const ORCHESTRATION_HELP = ORCHESTRATION_PATTERNS.join("|");

// ─── Pattern fit (the agent-facing recognition loop) ────────────────────────
// The templates below carry the *prose* of each pattern. This is the
// machine-readable counterpart: which coordination *shapes* a goal can take,
// and which patterns fit each. It powers `suggestPatterns()` — the bridge that
// lets an agent recognize "this goal looks like a debate" instead of waiting
// for an operator to seed a pattern.

/** Coordination shapes a goal can take. */
export type TaskShape =
  | "decomposable"
  | "contested"
  | "parallel"
  | "sequential"
  | "hierarchical"
  | "shared-artifact"
  | "open-ended"
  | "verifiable";

/** Which shapes each built-in pattern fits, with a one-line "why". */
export const PATTERN_FIT: Record<
  Exclude<OrchestrationPattern, "custom">,
  { shapes: TaskShape[]; why: string }
> = {
  deliberation: {
    shapes: ["contested", "open-ended"],
    why: "propose → cross-evaluate → converge",
  },
  chorus: { shapes: ["parallel", "shared-artifact"], why: "parallel phases + crossfire review" },
  foundry: { shapes: ["hierarchical", "decomposable"], why: "overseer → workers → merge gate" },
  swarm: { shapes: ["parallel", "open-ended"], why: "self-organizing expertise matching" },
  pipeline: { shapes: ["sequential"], why: "stage-by-stage with handoff gates" },
  debate: { shapes: ["contested"], why: "adversarial positions, judged" },
  mapreduce: { shapes: ["decomposable", "parallel"], why: "fan out independent chunks, merge" },
  blackboard: { shapes: ["shared-artifact"], why: "incremental refinement on one workspace" },
  symbiosis: { shapes: ["open-ended"], why: "mutual benefit, frontier scanning" },
  research: { shapes: ["open-ended"], why: "hypothesis → act → measure → record loop" },
  delphi: {
    shapes: ["contested", "open-ended"],
    why: "independent estimates → anonymized summary → revision",
  },
  tournament: { shapes: ["contested", "parallel"], why: "pairwise elimination among candidates" },
  verification: {
    shapes: ["decomposable", "shared-artifact", "verifiable"],
    why: "generate, then one verifier per aspect",
  },
  auction: { shapes: ["decomposable", "parallel"], why: "tasks awarded to the best-fit bid" },
  ledger: {
    shapes: ["hierarchical", "sequential"],
    why: "task + progress ledgers, replan on repeated stalls",
  },
  sharding: {
    shapes: ["decomposable", "parallel", "verifiable"],
    why: "an oracle splits a failing target into claimable shards",
  },
};

/**
 * Empirical validation status per pattern, from the 2026-09-02 orchestration
 * sweep (gpt-4o-mini crews, N=10 seed=42, request-serving context; report in
 * the private archive: marina-internal design/orchestration-pattern-sweep-2026-09.md).
 *
 * - `validated`: functioning under the full fix stack (protocol-priority
 *   briefs + coordinator envelope teaching + engine pending-request
 *   reminders + [crew-task] dispatch scoring). Post-fix, every formation
 *   answers 10/10 in request-serving; the six habitat-tested formations
 *   also completed 3/3 project-shaped tasks.
 * - `partial` / `unvalidated`: reserved for future patterns (or regressions)
 *   without passing evidence — they mean "no passing evidence yet", never
 *   "proven bad". Update this map when new sweeps land.
 */
export const PATTERN_VALIDATION: Record<
  Exclude<OrchestrationPattern, "custom">,
  { status: "validated" | "partial" | "unvalidated"; evidence: string }
> = {
  chorus: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 90% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  blackboard: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 100% 10/10 answered (habitat untested)",
  },
  foundry: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 100% 10/10 answered (habitat untested)",
  },
  deliberation: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 80% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  mapreduce: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 90% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  debate: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 70% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  symbiosis: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 80% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  research: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 80% 10/10 answered; habitat 3/3 tasks at 15s",
  },
  swarm: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 80% 10/10 answered (fixed-reminder rerun)",
  },
  pipeline: {
    status: "validated",
    evidence: "2026-09 post-fix sweep: gsm8k 70% 10/10 answered (habitat untested)",
  },
  delphi: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
  tournament: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
  verification: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
  auction: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
  ledger: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
  sharding: { status: "unvalidated", evidence: "added 2026-09; no sweep yet" },
};

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

export const DELIBERATION_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Deliberation orchestration: flat peer deliberation through a " +
      "propose → evaluate → execute → debrief cycle. Consider moving decisions through this " +
      "structured cycle: someone proposes, everyone evaluates, the group converges, then executes. " +
      "Use the project board for proposals.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Deliberation propose phase: post a proposal to the project board with a clear title and " +
      "body. Tag proposals with [proposal]. Others respond with numeric votes (1-10) using " +
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
      "Deliberation execute phase: once a proposal passes, create tasks from it. Assign tasks " +
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

export const CHORUS_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Chorus orchestration — research-first, parallel-by-default, with " +
      "adversarial cross-role review as the quality gate. Work moves through three phases " +
      "(Research, Build, Review), but within each phase multiple agents work in parallel. " +
      "The group channel is the wall: every agent broadcasts progress so siblings don't " +
      "duplicate. Quality comes from role diversity, not approval — reviewers from different " +
      "roles critique every output.",
    importance: 9,
    type: "skill",
  },
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
      "Chorus broadcast wall: before claiming a task, consider posting 'starting: <slice>' on the group " +
      "channel. While working, broadcast milestones. Before you pick a slice, reading the " +
      "channel to confirm no sibling is already on it often helps. Coordination is explicit via " +
      "broadcast, not handoff. If a sibling claims your target, picking something else tends to keep " +
      "parallelism alive.",
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

export const FOUNDRY_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Foundry orchestration — a hierarchy that compresses human attention " +
      "and a merge gate that serves as a useful checkpoint for landed work. Three load-bearing pieces: an " +
      "Overseer who is the single interface for outside requests, a Patrol that detects stuck " +
      "workers and nudges them, and a Gate through which output typically passes before it lands. " +
      "Distribute decisions downward; direct from the top; the Gate is a helpful merge checkpoint.",
    importance: 9,
    type: "skill",
  },
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
      "Foundry Patrol and nudges: Patrol runs `observe` and `novelty stats` each cycle " +
      "looking for stuck workers — no progress in 20 min, repeated identical actions, or " +
      "failure rate >60% on a task. On detection: `tell <worker> nudge: <specific " +
      "suggestion>`, or reassign the task and post [stall] on the board with reason. The " +
      "engine already tracks this in entity_activity — Patrol's job is to act on it, not " +
      "recompute it.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Foundry Gate — merge queue convention: one practice crews have found helpful is having " +
      "the Gate handle landings rather than workers merging directly. When a worker submits, the Gate " +
      "reviews against the task spec and either accepts (posts [landed] on the board, adds a pool note, " +
      "closes the task) or rejects (task stays claimed, worker reworks with the Gate's feedback). The Gate " +
      "can batch landings. This tends to keep concurrent work safer.",
    importance: 7,
    type: "skill",
  },
];

export const SWARM_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Swarm orchestration (self-organizing specialist handoffs). " +
      "There is no fixed leader. Each agent declares expertise via `memory set expertise <domain>`. " +
      "Tasks are self-claimed based on skill match. Work flows from specialist to specialist " +
      "through `tell` handoffs.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Swarm expertise: on joining, set your expertise with `memory set expertise <skills>`. " +
      "Before claiming a task, check if another agent's expertise is a better fit by using " +
      "`observe` to see who is active and `recall expertise` to find specialist knowledge.",
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
      "`tell <agent> ...` message — (1) the expertise being invoked ('calling you for X'), " +
      "(2) the pool note id of the prior work ('see pool note #42'), and (3) the expected " +
      "next step ('produce Y, then hand off to someone who does Z'). Handoffs missing these " +
      "often lose context. Consider adding a matching pool note tagged [handoff] linking old work " +
      "to new.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Swarm convergence: periodically check project status with `project <name> tasks`. " +
      "If tasks are stalling, post to the board to attract attention. Use `reflect` to " +
      "consolidate learnings across handoffs. The swarm self-organizes — no one waits " +
      "for permission.",
    importance: 7,
    type: "skill",
  },
];

export const PIPELINE_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Pipeline orchestration (sequential stage-by-stage processing). " +
      "Work typically flows through ordered stages. Each stage usually completes before the next begins. " +
      "Use the project board as a conveyor belt - post stage outputs for the next stage " +
      "to consume.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Pipeline stages: the project leader defines stages as ordered child tasks in the " +
      "bundle (e.g., research → analysis → synthesis → review). Each stage task's " +
      "description specifies inputs it expects and outputs it is expected to produce.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline stage contract: before any stage begins, the stage owner might post a contract " +
      "note to the pool tagged [stage-N-contract] specifying input shape, output " +
      "shape, and rejection criteria. Downstream stages can read the contract, not just the prose. " +
      "Contracts act as the stage's API — changing the contract means upstream/downstream " +
      "may need to re-align. Contracts help stages align; starting without one tends to cause mismatch.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline handoff: when a stage completes, the agent posts results to the board " +
      "with tag [stage-N-output] and sends a channel message signaling the next stage " +
      "can begin. The next stage's agent might read the [stage-N-contract] first, check " +
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

export const DEBATE_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Debate orchestration (adversarial argumentation with judge). " +
      "Decisions are made through structured argumentation. Agents take positions, " +
      "argue with evidence, score each other's arguments, and a judge synthesizes " +
      "the final decision.",
    importance: 9,
    type: "skill",
  },
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
      "tagged [ruling] that weighs arguments. The ruling becomes a task or action item.",
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

export const MAPREDUCE_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses MapReduce orchestration (parallel decomposition and synthesis). " +
      "A coordinator splits the problem into independent chunks. Workers process chunks " +
      "in parallel with no cross-talk. A reducer merges all results into the final output.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "MapReduce mapping: the coordinator creates one child task per chunk in the project " +
      "bundle. Each task description fully specifies the chunk boundaries so workers need " +
      "no coordination. Workers claim chunks freely — all chunks are independent.",
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

export const SYMBIOSIS_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Symbiosis orchestration — mutual epistemic benefit between all " +
      "participants. The pool tracks the team's collective knowledge frontier. Each entity " +
      "self-profiles their exploration style. Frontiers (knowledge gaps) are identified, " +
      "scored for both novelty and entity relevance, and assigned accordingly. The team " +
      "dynamically shifts between exploration modes based on collective coverage health.",
    importance: 9,
    type: "skill",
  },
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
      "the board tagged [discernment].",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Symbiosis mode triggers: measure coverage with `novelty stats` — the engine already " +
      "computes action entropy. Any Patrol agent can run this every 20 ticks and post " +
      "[mediation] to the board when the mode shifts. Thresholds: entropy < 0.3 suggests Recovery " +
      "(coverage stalling, everyone broadens, drop current focus). 0.3–0.6 suggests Breadth " +
      "(generalists scan wide, deepening agents pause). 0.6–0.8 suggests Depth (specialists go " +
      "deep, entropy is healthy). > 0.8 suggests Synergy (both healthy, maximize discernment " +
      "overlap). Coverage tends to improve when it keeps growing; these thresholds are heuristics, not rules.",
    importance: 7,
    type: "skill",
  },
];

export const RESEARCH_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Research orchestration (autonomous iterative experimentation). " +
      "Each agent runs a loop: hypothesize, act, measure, record, decide (keep or revert), " +
      "repeat. The pool accumulates all findings. The board is the shared results log. " +
      "No external tools needed — the world itself is the laboratory.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Research cycle — before each iteration, consider setting your hypothesis: " +
      "`memory set hypothesis <what you expect to happen>`. " +
      "Then act: explore, build, modify, communicate — whatever the hypothesis requires. " +
      "After acting, measure: use `orient` for memory health, `score` for standing, " +
      "`novelty` for exploration coverage, `experiment record <project> <metric> <value>` " +
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
      "Use the project channel to announce major findings or request help. " +
      "The pool is the collective memory — everything worth knowing should be there.",
    importance: 7,
    type: "skill",
  },
];

export const BLACKBOARD_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Blackboard orchestration (shared workspace with incremental " +
      "refinement). The project pool IS the primary workspace — a shared blackboard " +
      "where all agents read and write. Knowledge accumulates incrementally until the " +
      "group converges on a solution.",
    importance: 9,
    type: "skill",
  },
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

export const DELPHI_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Delphi orchestration — independent estimates first, then an " +
      "anonymized summary, then revision. Each member forms a view alone before seeing anyone " +
      "else's, a facilitator summarizes the spread without names, and members revise in light " +
      "of the summary. The mechanism is independence before influence: the first round tends to " +
      "be most useful when nobody has anchored on an earlier or louder voice. Consider naming one " +
      "facilitator (not an estimator) before the first round starts.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Delphi drafting: consider drafting your estimate privately first — `memory kv set " +
      "estimate <value> because <reasons>` — before reading the board or channel. Once drafted, send it to " +
      "the facilitator only: `tell <facilitator> [estimate] <value> | <reasons>`. Posting to the " +
      "board before everyone has drafted tends to anchor the others. The facilitator can confirm " +
      "on the project channel when every member has sent a draft, which opens the summary step.",
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

export const TOURNAMENT_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Tournament orchestration — pairwise elimination among candidate " +
      "solutions. Several members each produce a candidate independently, candidates meet in " +
      "pairs, the stronger of each pair advances, and rounds repeat until one remains. Comparing " +
      "two at a time tends to be easier to judge well than ranking many at once. The losing " +
      "candidates are not wasted: their best ideas can be grafted into the winner at the end.",
    importance: 9,
    type: "skill",
  },
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

export const VERIFICATION_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Verification orchestration — generate, then verify from several " +
      "angles. One or more members produce candidates; separate verifiers each check ONE aspect " +
      "of a candidate: correctness, constraints and requirements, evidence and citations, or " +
      "safety. A candidate passes when every aspect verifier passes it. Splitting verification by " +
      "aspect tends to catch what one generalist reviewer misses, and keeps each check small " +
      "enough to do thoroughly.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Verification generation: authors produce candidates as ordinary tasks (`task claim <id>`, " +
      "then `task submit <id> <candidate and where it lives>`) and announce each one with `board " +
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

export const AUCTION_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Auction orchestration — tasks are allocated by bids. The work is split " +
      "into tasks or bounties, members bid by stating their fit and an expected cost, and the " +
      "coordinator awards each task to the best fit for its cost. Afterwards the coordinator " +
      "records whether the winner's claimed fit held up, so later awards learn from it. The " +
      "auction is a convention over ordinary tasks and claims, not a separate mechanism.",
    importance: 9,
    type: "skill",
  },
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

export const LEDGER_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Ledger orchestration — one orchestrator keeps two ledgers. The task " +
      "ledger holds the facts, the plan and the assignments; the progress ledger holds what is " +
      "done, what is in flight and what is stuck. Both live in the pool as known notes the " +
      "orchestrator updates, so any member can recall where the work stands without asking. The " +
      "orchestrator steers from the ledgers rather than from its own recollection.",
    importance: 9,
    type: "skill",
  },
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
      "open. On a first stall the orchestrator can nudge the claimant (`tell <name> <message>`) " +
      "or reassign the task. Each stall goes into the progress ledger with its cause, so repeated " +
      "stalls on the same step stay visible.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Ledger replanning: after repeated stalls on the same step (two or three is a reasonable " +
      "bar), consider replanning instead of retrying — revisit the task ledger's facts and " +
      "guesses, write a new plan version, and cancel tasks only the old plan needed (`task cancel " +
      "<id>`). The debrief is a [ledger-lesson] pool note: which guess failed, what the replan " +
      "changed and how many stalls it took, so future orchestrators can recall it.",
    importance: 7,
    type: "skill",
  },
];

export const SHARDING_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Sharding orchestration — an oracle splits one big failing target into " +
      "independent, claimable pieces. The oracle is whatever decides pass or fail mechanically: a " +
      "test suite, a reference implementation, or a checker. Each failing case or shard becomes a " +
      "task; members fix shards in parallel and re-run the oracle to confirm. The oracle, not " +
      "opinion, decides when a shard or the whole target is done.",
    importance: 9,
    type: "skill",
  },
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
      "each pass mean something.",
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
