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
 * the generational-memory patterns, then `custom` last.
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
  | "open-ended";

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
};

const SHAPE_PATTERNS: { shape: TaskShape; re: RegExp }[] = [
  {
    shape: "contested",
    re: /\b(debate|argue|disagree|pros and cons|which is better|decide between|trade-?off|controvers|for or against)\b/,
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
      "propose → evaluate → execute → debrief cycle. All decisions go through the structured " +
      "cycle: someone proposes, everyone evaluates, the group converges, then executes. " +
      "Use the project board for proposals.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Deliberation propose phase: post a proposal to the project board with a clear title and " +
      "body. Tag proposals with [proposal]. Others respond with numeric votes (1-10) using " +
      "`board vote <postId> up|down [score 1-10]`. A proposal needs majority support (avg >= 6) " +
      "to advance to execution.",
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
      "Deliberation debrief phase: debrief is not complete until a [lesson] pool note is posted " +
      "summarizing what worked, what failed, and what to do differently. Link the lesson " +
      "to the original [proposal] via `note link <lesson-id> <proposal-id> part_of`. " +
      "Only then does the next propose phase begin. The cycle only counts if the lesson " +
      "outlives the cycle — skip the artifact and the cycle was just meetings.",
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
      "Chorus broadcast wall: before claiming a task, post 'starting: <slice>' on the group " +
      "channel. While working, broadcast milestones. Before you pick a slice, read the " +
      "channel to confirm no sibling is already on it. Coordination is explicit via " +
      "broadcast, not handoff. If a sibling claims your target, pick something else — " +
      "parallelism is the invariant.",
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
      "Chorus crossfire review gate: a build task is not done until >=2 independent reviewers " +
      "(different roles) post scores on the board, average >=6, with at least one [critique] " +
      "reply. Reviewers link via `note link <review> <build> supports|contradicts` to build " +
      "the argument graph. Rework until crossfire passes. Record the ruling in the pool " +
      "tagged [crossfire-ruling]. Cite rulings in future chorus runs instead of re-arguing.",
    importance: 7,
    type: "skill",
  },
];

export const FOUNDRY_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Foundry orchestration — a hierarchy that compresses human attention " +
      "and a merge gate that is the sole path to landed work. Three load-bearing pieces: an " +
      "Overseer who is the single interface for outside requests, a Patrol that detects stuck " +
      "workers and nudges them, and a Gate through which all output must pass before it lands. " +
      "Distribute decisions downward; direct from the top; nothing merges without the Gate.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Foundry hierarchy: the project creator is the Overseer. They designate established " +
      "members as Patrol and as Gate — supervision capability follows standing and witnessed " +
      "competence under the world's autonomy posture, not a tier number. Workers (any rank) claim " +
      "tasks freely. The Overseer routes outside 'tell's and public requests — don't bother workers " +
      "directly. Patrol and Gate never claim worker tasks; their job is supervision, not " +
      "execution.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Foundry convoys: organize work into named convoys via `task bundle <name>`. Each " +
      "convoy has a landing target posted to the board. Workers claim from convoys; they " +
      "never claim loose tasks. A convoy lands as a unit — every task in it must pass the " +
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
      "Foundry Gate — merge queue invariant: no worker output becomes 'landed' by worker " +
      "action. When a worker submits, the Gate reviews against the task spec and either " +
      "accepts (posts [landed] on the board, adds a pool note, closes the task) or rejects " +
      "(task stays claimed, worker reworks with the Gate's feedback). The Gate can batch " +
      "landings. This invariant is non-negotiable — it's what keeps concurrent work safe.",
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
      "your expertise using `task claim <id>`. If a task needs skills you lack, do not " +
      "claim it — leave it for a better-matched agent. Maximize parallel work.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Swarm handoff payload: a handoff is not valid unless it carries three things in one " +
      "`tell <agent> ...` message — (1) the expertise being invoked ('calling you for X'), " +
      "(2) the pool note id of the prior work ('see pool note #42'), and (3) the expected " +
      "next step ('produce Y, then hand off to someone who does Z'). Handoffs without all " +
      "three are context loss. Add a matching pool note tagged [handoff] linking old work " +
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
      "Work flows through ordered stages. Each stage must complete before the next begins. " +
      "Use the project board as a conveyor belt - post stage outputs for the next stage " +
      "to consume.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Pipeline stages: the project leader defines stages as ordered child tasks in the " +
      "bundle (e.g., research → analysis → synthesis → review). Each stage task's " +
      "description specifies inputs it expects and outputs it must produce.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline stage contract: before any stage begins, the stage owner posts a contract " +
      "note to the pool tagged [stage-N-contract] specifying exact input shape, exact output " +
      "shape, and rejection criteria. Downstream stages read the contract, not the prose. " +
      "Contracts are the stage's API — change the contract and upstream/downstream must " +
      "re-agree. No contract, no stage.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline handoff: when a stage completes, the agent posts results to the board " +
      "with tag [stage-N-output] and sends a channel message signaling the next stage " +
      "can begin. The next stage's agent reads the [stage-N-contract] first, validates " +
      "the output against it, then starts work.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pipeline quality: each stage reviews the previous stage's output against the " +
      "contract before processing. If the input violates the contract, reject by replying " +
      "on the board and notifying via channel. The upstream agent reworks. Use `pool <name> " +
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
      "Debate independence invariant: draft your position in your own notes BEFORE reading " +
      "any board posts. Use `note <position> type decision` privately, then post to the " +
      "board only when the judge signals the sealed phase is over. Reading others' positions " +
      "before drafting collapses the debate into groupthink — independence is the quality " +
      "mechanism. Post positions tagged [position:sealed] until the judge opens them.",
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
      "MapReduce execution: work your chunk in isolation. Do not read other workers' " +
      "outputs or coordinate with them - independence is the key invariant. Add your " +
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
      "computes action entropy. Any Patrol agent runs this every 20 ticks and posts " +
      "[mediation] to the board when the mode shifts. Thresholds: entropy < 0.3 → Recovery " +
      "(coverage stalling, everyone broadens, drop current focus). 0.3–0.6 → Breadth " +
      "(generalists scan wide, deepening agents pause). 0.6–0.8 → Depth (specialists go " +
      "deep, entropy is healthy). > 0.8 → Synergy (both healthy, maximize discernment " +
      "overlap). Coverage must always grow; modes are mechanical, not aspirational.",
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
      "Research cycle — before each iteration, set your hypothesis: " +
      "`memory set hypothesis <what you expect to happen>`. " +
      "Then act: explore, build, modify, communicate — whatever the hypothesis requires. " +
      "After acting, measure: use `orient` for memory health, `score` for standing, " +
      "`novelty` for exploration coverage, `experiment record <project> <metric> <value>` " +
      "for structured data. Every iteration must produce a measurement.",
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
      "If the metric improved, record: `note Keeping change: <reason> type decision`. " +
      "If it worsened, revert your change and record: `note Reverting: <reason> type decision`. " +
      "Update your strategy: `memory set strategy <what to try next>`. " +
      "Every 5 iterations, run `reflect` to synthesize learnings into an episode. " +
      "Recall past results before starting a new hypothesis: `recall <topic>` or " +
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
      "Blackboard no-private-state invariant: for the duration of a blackboard project, " +
      "agents do not keep private notes on project topics — everything goes to the pool, " +
      "or it doesn't count as contribution. Reasoning you keep to yourself is reasoning " +
      "the team can't build on. Use private core memory only for cross-project identity, " +
      "never for project-specific thinking. If you catch yourself writing `note <text>` without " +
      "`pool <name> add`, you are off-pattern.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Blackboard reading: before contributing, always read the current state with " +
      "`pool <name> recall <topic>`. Understand what others have written. Use " +
      "`pool <name> list` to see all contributions. The blackboard is the single " +
      "source of truth.",
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
