// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TemplateNote } from "./orchestration";

export const HTDAG_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses HTDAG decomposition (Hierarchical Task DAG). Work is represented as " +
      "a tree of tasks with explicit dependency edges. The project bundle is the root. Each " +
      "child is either a leaf (executable) or an internal node (further decomposable). " +
      "Dependencies between siblings are recorded so execution can parallelize safely.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "HTDAG root: the project bundle IS the root task. To decompose a node, break it into " +
      "2-7 child subtasks using 'task create <title> | <desc>' then 'task assign <child_id> " +
      "<parent_id>'. Each child must satisfy three principles: solvability (achievable on its " +
      "own), completeness (together they cover the parent), non-redundancy (no overlap).",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "HTDAG dependencies: when a child task cannot begin until another sibling completes, " +
      "record the edge in the task description as 'depends on #<id>' or set a known property " +
      "via 'task set <id> dependsOn <id1>,<id2>'. Agents check 'task info <id>' before claiming " +
      "and skip tasks whose dependencies are still open. Independent siblings run in parallel.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "HTDAG expansion: internal nodes are not worked directly — only leaves are. When an " +
      "internal node is claimed, the claimant's first action is to decompose it further " +
      "(create children, assign, set dependencies) rather than execute. Mark internal nodes " +
      "with [bundle] in the title so workers know not to claim them as leaves.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "HTDAG traversal: 'task children <id>' walks one level, 'project <name> tasks' shows the " +
      "full flat list. To find ready-to-claim leaves: list children, filter to status=open, " +
      "skip any whose dependsOn references an open task. Progress rolls up automatically via " +
      "'task progress' — when all children of a bundle complete, the bundle closes.",
    importance: 7,
    type: "skill",
  },
  {
    content:
      "HTDAG node markers: title prefixes signal node type. [bundle] = container, never claim " +
      "directly. [action] = deterministic command/skill, no LLM judgment needed. [decide] = LLM " +
      "judgment or classification step. [gate] = approval before downstream work proceeds. " +
      "[agent] = open-loop, agent-driven exploration. Unmarked = leaf, executable as-is. Run " +
      "'task info <id>' to see the parsed type and its meaning.",
    importance: 8,
    type: "skill",
  },
];

export const PLAN_EXEC_VERIFY_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Plan-Execute-Verify decomposition (three-role coordinator pattern). " +
      "One agent plans (decomposes work into non-overlapping subtasks), others execute leaves, " +
      "a verifier gates completion before the bundle merges. Roles are claimed via trait, not " +
      "assigned — use 'role set planner' / 'role set executor' / 'role set verifier'.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Planner duties: the planner reads the bundle description, breaks it into 3-7 executable " +
      "subtasks using 'task create' + 'task assign <child> <bundle>'. Each subtask MUST have " +
      "(a) a clear done-criterion in its description, (b) no overlap with siblings, (c) a " +
      "dependency list. The planner does NOT execute — they re-plan if verifiers reject work.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Executor duties: executors claim leaf tasks with 'task claim <id>', work them, and " +
      "submit with 'task submit <id> <result>'. Never claim the planner's bundle directly. " +
      "Never expand a task further — if a leaf is too large, post to the project board " +
      "tagged [needs-replan] and let the planner re-decompose.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Verifier duties: verifiers review submitted tasks against the done-criterion in the " +
      "description. Approve with 'task approve <id>' or reject with 'task reject <id> <reason>'. " +
      "Verifiers are the merge gate — a bundle is not complete until every child is " +
      "verifier-approved, not just executor-submitted. Aim for fast review cycles.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Plan-Execute-Verify flow: (1) planner decomposes bundle, posts [plan] to board. " +
      "(2) executors claim leaves in parallel where dependencies allow. (3) as tasks submit, " +
      "verifier reviews + approves/rejects. (4) rejected tasks return to open or trigger " +
      "re-plan. (5) when all children verified, bundle auto-completes. Record failures in pool.",
    importance: 7,
    type: "skill",
  },
];

export const LAZY_EXPANSION_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Lazy Expansion decomposition (just-in-time planning). Do NOT plan the " +
      "full tree up front. Decompose only the immediate next layer. Further depth is expanded " +
      "when a node is actually claimed. Prevents premature over-planning when the problem is " +
      "still ambiguous.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Lazy Expansion initial plan: at project start, the planner decomposes ONLY the bundle's " +
      "immediate children (one level deep). Each child is either a leaf or marked [expand] in " +
      "its title. Do not create grandchildren yet — they will be created when the parent is " +
      "claimed and found to need further breakdown.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Lazy Expansion claim-then-expand: when claiming an [expand] task, the first action is " +
      "to decompose it into its own children using 'task create' + 'task assign <child> " +
      "<claimed_id>'. Then submit the [expand] task itself as 'expansion complete' and the " +
      "children become the new ready work. Do not execute and decompose in the same step.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Lazy Expansion depth control: if during execution you discover a leaf is larger than " +
      "expected, turn it into an [expand] node — edit its title, create children, update " +
      "description. This is preferable to silently doing 3x the work. Record the expansion " +
      "reason in a note so future plans budget correctly.",
    importance: 7,
    type: "skill",
  },
  {
    content:
      "Lazy Expansion memory: record actual vs. predicted breakdown after each bundle closes. " +
      "'reflect' after completion. Add a pool note: 'pool <name> add expansion-lesson: <what " +
      "we thought> vs <what we found> importance 7'. Future planners recall these before " +
      "deciding initial depth.",
    importance: 7,
    type: "skill",
  },
];

export const NON_OVERLAPPING_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Non-Overlapping Boundaries decomposition (conflict-free parallelism). " +
      "The central invariant: two sibling tasks must touch DISJOINT sets of files, entities, " +
      "or artifacts. Decomposition explicitly enumerates each subtask's scope so parallel " +
      "executors never collide at merge.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Boundary declaration: every subtask description MUST contain a 'Scope:' section listing " +
      "the exact files/rooms/notes/entities it will modify. Example: 'Scope: src/agent/*.ts, " +
      "notes tagged #memory'. The planner validates that no two siblings declare overlapping " +
      "scope before assigning.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Coupled work serializes: when two logical subtasks would need the same scope, DO NOT " +
      "parallelize — sequence them as a dependency chain using dependsOn. Better to serialize " +
      "correctly than parallelize and merge-conflict. Record this decision: 'pool <name> add " +
      "serialized <task A> before <task B>: shared scope <scope> importance 7'.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Pre-claim check: before 'task claim <id>', read the Scope section and verify no other " +
      "claimed/in-progress task touches the same scope. If conflict, post [scope-conflict] to " +
      "the board and wait — do not claim. The planner resolves by re-decomposing or adding a " +
      "dependsOn edge.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Merge gate: when submitting, re-list the actual scope touched (may differ from planned). " +
      "If it grew, flag it: '[scope-creep] actual: <new scope>'. The verifier checks that no " +
      "other in-flight task now overlaps. This is the conflict-detection gate — catch scope " +
      "drift before it corrupts the parallel structure.",
    importance: 7,
    type: "skill",
  },
];

export const WORKLOAD_TIERS_TEMPLATE: TemplateNote[] = [
  {
    content:
      "This project uses Workload Tiers decomposition (effort-stratified assignment). The " +
      "planner decomposes not just by topic but by effort tier: small (S), medium (M), large " +
      "(L). Agents self-profile their capacity and claim tiers that match. Ensures fair load " +
      "distribution and prevents one agent from grabbing all the easy work.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Tier tagging: every leaf task title starts with a tier marker: [S] = ~minutes of work, " +
      "[M] = ~tens of minutes, [L] = ~hours. The planner aims for a balanced mix — roughly " +
      "equal count of S/M/L — so the graph has a smooth workload gradient rather than all-or-" +
      "nothing tasks.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Agent self-profile: on joining the project, declare your tier appetite with 'memory set " +
      "tier_preference S|M|L|any'. High-standing agents can take L tasks; newer agents stick " +
      "to S/M. Check 'score' to gauge readiness. Stretching one tier up occasionally is fine; " +
      "two tiers up risks stalling.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Priority-first matching: when multiple tasks of your tier are ready, claim the one with " +
      "the highest priority/standing first (check 'task info <id>'). Within a tier, ties " +
      "break by dependency count — claim tasks that unblock the most downstream work. This " +
      "keeps the critical path moving.",
    importance: 7,
    type: "skill",
  },
  {
    content:
      "Workload Tiers rebalancing: if a tier is starving (many open S tasks, no claimers) or " +
      "choking (too many L tasks, no capacity), the planner re-tiers. Split an L into 2-3 Ms, " +
      "or combine trivial Ss. Record the calibration in the pool: 'pool <name> add " +
      "tier-adjust: <before> -> <after>: <reason> importance 6'.",
    importance: 7,
    type: "skill",
  },
];
