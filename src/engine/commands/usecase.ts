// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntime } from "../../agent/agent-runtime";
import type { GroupManager } from "../../coordination/group-manager";
import type { TaskManager } from "../../coordination/task-manager";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, EntityRank, RoomContext } from "../../types";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";

/**
 * Use-case recipes — one-command scaffolding that creates a project,
 * tasks, pool notes, and spawns agents to begin work immediately.
 *
 * Composable: recipes are data, worlds can register custom ones,
 * and the system uses only existing primitives (project, task, pool, agent).
 */

// ─── Recipe Types ──────────────────────────────────────────────────────────

export interface TeamMember {
  /** Role to assign (must exist in DB). */
  role: string;
  /** Per-agent goal text — supersedes the default project-join goal. */
  goal: string;
  /** Optional model override per member. */
  model?: string;
  /** Name prefix (default: role). Final name = `${prefix}-<id>`. */
  namePrefix?: string;
}

export interface UseCaseRecipe {
  /** Recipe identifier (e.g. "research", "predict", "search") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Orchestration pattern to apply */
  orchestration: string;
  /** Tasks to create in the project bundle */
  tasks: Array<{ title: string; description: string }>;
  /** Knowledge notes to seed into the project pool */
  poolNotes: Array<{ content: string; importance: number; type: string }>;
  /** How many agents to spawn (single-role mode; ignored if `team` is set) */
  agentCount: number;
  /** Role to assign to spawned agents (single-role mode) */
  agentRole?: string;
  /** Default model for agents */
  agentModel?: string;
  /**
   * Multi-agent team. If present, supersedes `agentCount`/`agentRole` and
   * spawns one agent per member with their own role + goal + model.
   * Each member's `goal` is used verbatim (it should already include any
   * project-join instructions, since this overrides the default goal).
   */
  team?: TeamMember[];
  /**
   * Core-memory entries to set on the REQUESTER (the entity calling the
   * usecase) before agents spawn. Used by the bet recipe to pre-configure
   * bankroll/cap/floor/kelly so the user's `position confirm` works without
   * the user having to type four bankroll commands first.
   */
  requesterCoreMemory?: Record<string, string>;
}

type RecipeFactory = (topic: string) => UseCaseRecipe;

// ─── Bet topic parsing ─────────────────────────────────────────────────────

export interface BetParams {
  /** USD amount parsed from topic; 0 if not specified */
  bankrollUsd: number;
  /** Resolution-window in days; 0 if not specified */
  timeframeDays: number;
  /** Original topic string (for context) */
  topic: string;
}

/**
 * Parse a natural-language bet topic for amount + timeframe. Voice-friendly:
 * recognizes "$40", "40 dollars", "100 usd", "next week", "this week",
 * "today", "next month", "7 days", "3 hours", etc.
 *
 * Missing fields return 0 — caller decides defaults.
 */
export function parseBetTopic(topic: string): BetParams {
  // Amount: $40, $1,000, 40 dollars, 100 USD, 50 bucks
  const amountMatch = topic.match(
    /(?:\$\s*([\d,]+(?:\.\d+)?))|(?:\b([\d,]+(?:\.\d+)?)\s*(?:dollars?|usd|bucks?)\b)/i,
  );
  let bankrollUsd = 0;
  if (amountMatch) {
    const raw = (amountMatch[1] ?? amountMatch[2] ?? "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) bankrollUsd = n;
  }

  // Timeframe: "7 days", "3 hours", "next week", "this week", "today", "next month"
  let timeframeDays = 0;
  const numMatch = topic.match(
    /\b(\d+)\s*(hour|hours|hr|hrs|day|days|week|weeks|wk|wks|month|months|mo)\b/i,
  );
  if (numMatch) {
    const n = Number(numMatch[1]);
    const unit = numMatch[2]!.toLowerCase();
    if (unit.startsWith("h")) timeframeDays = Math.max(1, Math.round(n / 24));
    else if (unit.startsWith("d")) timeframeDays = n;
    else if (unit.startsWith("w")) timeframeDays = n * 7;
    else if (unit.startsWith("m")) timeframeDays = n * 30;
  } else if (/\b(next|this|over the|in the next|within (a|the))\s+week\b/i.test(topic)) {
    timeframeDays = 7;
  } else if (/\b(today|by tonight|by tomorrow|next 24 hours)\b/i.test(topic)) {
    timeframeDays = 1;
  } else if (/\b(next|this|over the|within (a|the))\s+month\b/i.test(topic)) {
    timeframeDays = 30;
  } else if (/\bweek\b/i.test(topic)) {
    timeframeDays = 7;
  }

  return { bankrollUsd, timeframeDays, topic };
}

/** Default bankroll allocation rules — quarter for cap, half for daily floor. */
export function deriveBankrollLimits(bankrollUsd: number): {
  bankroll: number;
  cap: number;
  floor: number;
  kelly: number;
} {
  const bankroll = Math.max(0, Math.floor(bankrollUsd));
  const cap = Math.max(1, Math.floor(bankroll / 4));
  const floor = Math.max(1, Math.floor(bankroll / 2));
  return { bankroll, cap, floor, kelly: 0.5 };
}

// ─── Built-in Recipes ──────────────────────────────────────────────────────

const BUILTIN_RECIPES: Record<string, RecipeFactory> = {
  evolve: (topic) => ({
    name: "evolve",
    description: `Autonomous evolution cycle: ${topic}`,
    orchestration: "swarm",
    tasks: [
      {
        title: "Declare constitution and baseline",
        description: `Set the working identity for this evolution run: 'memory set goal ${topic}' and 'memory set constitution Improve one thing per cycle. Always journal.' Then run 'brief full', 'orient', and 'recall ${topic}' to establish the baseline. Record a Gen 0 note with current capability, constraints, and the first improvement hypothesis.`,
      },
      {
        title: "Create or request a mind-room",
        description: `Create an inspectable mind-room for this run with 'build room mind/<name> <name> Workshop' if you have Builder rank. If rank-gated, write the intended room design as a skill note and ask a Builder via 'tell' or channel to create it. The mind-room should expose goal, generation, journal, scorecard, and open threads.`,
      },
      {
        title: "Run one improvement cycle",
        description: `Act on the baseline: explore, ask another entity for advice, write notes, and use 'reflect ${topic}' to synthesize. If you repeat a command sequence, save it with 'macro create <name> ...'. If you discover a procedure, package it with 'skill compose' or 'skill store'.`,
      },
      {
        title: "Measure and compare",
        description:
          "Run the smallest meaningful benchmark or objective available: 'score', 'novelty stats', a benchmark quest, or a task-specific acceptance check. Compare against the Gen 0 note. Keep changes that improved the score or produced reusable structure; otherwise journal why the attempt failed.",
      },
      {
        title: "Publish lineage",
        description:
          "Write a final episode note with: generation, actions taken, macro/skill/room created, score change, what to try next. Add the lesson to the project pool, submit the task result, and tell the requester where future agents should resume.",
      },
    ],
    poolNotes: [
      {
        content: `Evolution goal: ${topic}. The deliverable is not private reasoning; it is reusable semantic structure left in the world for future entities.`,
        importance: 10,
        type: "principle",
      },
      {
        content:
          "Evolution loop: goal -> baseline -> act -> compose a reusable word/macro/skill/room when repetition appears -> measure -> reflect -> publish lineage. Do not wait for a perfect architecture; use the world and leave traces.",
        importance: 10,
        type: "skill",
      },
      {
        content:
          "Prompt budget policy: keep the system prompt small. Move repeated instructions into memory, skills, macros, pools, and rooms. The world remembers; the agent samples.",
        importance: 9,
        type: "principle",
      },
      {
        content:
          "Multiplayer enrichment is part of evolution. Ask peers with 'tell', coordinate in channels, use boards for slower decisions, and publish pool notes so later agents can inherit the result without needing your whole transcript.",
        importance: 9,
        type: "principle",
      },
      {
        content:
          "Mind-room convention: a mind-room should expose an agent's goal, constitution, generation, journal, scorecard, and next open question. It is inspectable behavior, not decorative space.",
        importance: 8,
        type: "skill",
      },
      {
        content:
          "Promotion discipline: start with a note or skill, compress repeated action into a macro, use a dynamic command only when branching or validation is needed, and promote to built-in TypeScript only after usage proves it matters.",
        importance: 8,
        type: "principle",
      },
    ],
    agentCount: 0,
    team: [
      {
        role: "researcher",
        namePrefix: "evolver",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} placeholders in seeded template content
        goal: `You are the Evolver for "${topic}". Join project "evolve: ${topic.slice(0, 60)}", claim the baseline and improvement-cycle tasks, and work through the evolution loop using only Marina primitives. Set a goal, journal Gen 0, ask the Advisor for one concrete suggestion, create or request a mind-room, package one repeated behavior as a macro or skill, measure the result, publish lineage to the project pool, and tell ${"${requester}"} what future agents should inherit.`,
      },
      {
        role: "scholar",
        namePrefix: "advisor",
        goal: `You are the Advisor for the evolution run "${topic}". Join project "evolve: ${topic.slice(0, 60)}". Watch for messages from the Evolver, answer with one specific improvement suggestion at a time, challenge prompt bloat and over-engineering, and help turn useful behavior into notes, skills, macros, or room conventions. Do not take over the run; enrich it.`,
      },
    ],
    requesterCoreMemory: {
      goal: topic,
      constitution:
        "Improve one thing per cycle. Always journal. Prefer world traces over prompt bloat.",
    },
  }),

  research: (topic) => ({
    name: "research",
    description: `Deep research investigation into: ${topic}`,
    orchestration: "research",
    tasks: [
      {
        title: "Survey existing knowledge",
        description: `Search notes, pools, and the web for existing information about: ${topic}. Write notes summarizing what you find.`,
      },
      {
        title: "Identify key questions",
        description: `Based on survey findings, identify 3-5 key open questions about: ${topic}. Post questions to the project board.`,
      },
      {
        title: "Deep investigation",
        description: `Investigate the key questions using web search and analysis. Gather evidence, form hypotheses about: ${topic}. Record all findings as notes.`,
      },
      {
        title: "Synthesize findings",
        description: `Write a comprehensive synthesis of all findings about: ${topic}. Post the final report to the project board. Include sources, key insights, and open questions.`,
      },
    ],
    poolNotes: [
      {
        content: `Research topic: ${topic}. Goal: investigate thoroughly and share findings.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Available tools: web search, web fetch, web multisearch, note, recall, reflect, board post, pool, tell, task claim, task progress",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  debate: (topic) => ({
    name: "debate",
    description: `Evidence-backed adversarial deliberation: ${topic}`,
    orchestration: "debate",
    tasks: [
      {
        title: "Frame the decision",
        description: `Define the exact contested question, decision criteria, known constraints, and what evidence would change the conclusion for: ${topic}.`,
      },
      {
        title: "Develop opposing cases",
        description: `Build the strongest evidence-cited cases for the major opposing positions on: ${topic}. Record uncertainties and rebuttals without collapsing disagreement early.`,
      },
      {
        title: "Cross-examine the evidence",
        description: `Test each position against the same criteria. Identify unsupported claims, contradictions, missing evidence, and points of genuine agreement.`,
      },
      {
        title: "Publish a judged synthesis",
        description: `Publish the winning conclusion—or an explicit unresolved split—with evidence references, confidence, minority view, and conditions that would reverse the judgment.`,
      },
    ],
    poolNotes: [
      {
        content: `Debate question: ${topic}. Preserve competing hypotheses until they have been evaluated against shared evidence and criteria.`,
        importance: 10,
        type: "principle",
      },
      {
        content:
          "Debate outcome contract: conclusion, confidence, cited evidence, strongest counterargument, unresolved uncertainty, and reversal conditions.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "scholar",
  }),

  solve: (topic) => ({
    name: "solve",
    description: `Blackboard problem-solving project: ${topic}`,
    orchestration: "blackboard",
    tasks: [
      {
        title: "State constraints and acceptance checks",
        description: `Turn the problem into explicit constraints, inputs, unknowns, and observable acceptance checks: ${topic}.`,
      },
      {
        title: "Generate candidate approaches",
        description: `Produce several materially different solution approaches. Add assumptions, expected failure modes, and required evidence to the shared project surface.`,
      },
      {
        title: "Test and refine",
        description: `Test the strongest candidates against the acceptance checks. Record failed approaches as evidence rather than silently discarding them.`,
      },
      {
        title: "Deliver the verified solution",
        description: `Publish the selected solution with verification evidence, remaining risks, and a reproducible next action.`,
      },
    ],
    poolNotes: [
      {
        content: `Problem: ${topic}. Convergence requires evidence against explicit acceptance checks, not agreement alone.`,
        importance: 10,
        type: "principle",
      },
    ],
    agentCount: 1,
    agentRole: "general",
  }),

  explore: (topic) => ({
    name: "explore",
    description: `Open-ended frontier exploration: ${topic}`,
    orchestration: "symbiosis",
    tasks: [
      {
        title: "Map the known frontier",
        description: `Survey existing internal and external knowledge about ${topic}; distinguish established facts, active uncertainty, and unexplored directions.`,
      },
      {
        title: "Probe diverse directions",
        description: `Investigate several high-information directions without forcing premature convergence. Record surprising links, contradictions, and dead ends.`,
      },
      {
        title: "Select promising frontiers",
        description: `Rank the most promising discoveries by novelty, evidence, tractability, and expected value.`,
      },
      {
        title: "Publish a frontier map",
        description: `Publish what is known, what changed during exploration, the strongest opportunities, and concrete next experiments.`,
      },
    ],
    poolNotes: [
      {
        content: `Exploration domain: ${topic}. Breadth is useful only when it leaves a traceable frontier map and actionable next probes.`,
        importance: 10,
        type: "principle",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  plan: (topic) => ({
    name: "plan",
    description: `Multi-perspective decision plan: ${topic}`,
    orchestration: "deliberation",
    tasks: [
      {
        title: "Define outcome and constraints",
        description: `Define the desired outcome, constraints, stakeholders, dependencies, and measurable completion criteria for: ${topic}.`,
      },
      {
        title: "Propose candidate plans",
        description: `Develop alternative plans with sequencing, ownership, risks, costs, and rollback points.`,
      },
      {
        title: "Evaluate and converge",
        description: `Evaluate alternatives against the shared criteria, record dissent, and select or synthesize the strongest plan.`,
      },
      {
        title: "Publish executable plan",
        description: `Publish milestones, dependencies, owners or roles, decision gates, verification criteria, and the first executable action.`,
      },
    ],
    poolNotes: [
      {
        content: `Planning goal: ${topic}. A plan is complete only when its decisions, dependencies, verification gates, and first action are explicit.`,
        importance: 10,
        type: "principle",
      },
    ],
    agentCount: 1,
    agentRole: "guide",
  }),

  bet: (topic) => {
    const params = parseBetTopic(topic);
    const limits = deriveBankrollLimits(params.bankrollUsd);
    const days = params.timeframeDays || 30;
    const hasBudget = limits.bankroll > 0;

    const timeframeNote = `Resolution window: ${days} day${days === 1 ? "" : "s"} from now (parsed from "${topic}"). Filter candidate markets to those resolving within this window — anything resolving later is out of scope.`;

    // Pre-configure the requester's bankroll. The user's `position confirm`
    // opens against THEIR bankroll, so this is what makes the killer-demo
    // screenplay work without the user having to type four commands first.
    const requesterCoreMemory = hasBudget
      ? {
          bankroll: String(limits.bankroll),
          cap: String(limits.cap),
          floor: String(limits.floor),
          kelly: String(limits.kelly),
        }
      : undefined;

    // Multi-agent team: 3 Scouts (parallel category coverage) + 1 Treasurer
    // (synthesis + portfolio proposal). The Treasurer is propose-only —
    // explicitly NOT authorized to call `position open`. The user runs
    // `position confirm <id>` to actually open. Voice-friendly: roles are
    // single-word; agent names use role as prefix.
    const team: TeamMember[] = hasBudget
      ? [
          {
            role: "researcher",
            namePrefix: "scout-macro",
            goal: `You are a Scout for the macro/finance category. Discover Kalshi and Polymarket markets relevant to: "${topic}". Use 'market live kalshi ${days}d 25' and 'market live polymarket ${days}d 25' to pull live tape. Filter to markets in the macro/finance category (Fed, inflation, GDP, jobs, currencies, commodities). For each strong candidate post a [candidate] note to scenario-graph with: ticker, venue, current YES price, volume, resolution date, and a one-sentence thesis. ${timeframeNote}`,
          },
          {
            role: "researcher",
            namePrefix: "scout-tech",
            goal: `You are a Scout for the tech/AI/crypto category. Discover Kalshi and Polymarket markets relevant to: "${topic}". Use 'market live kalshi ${days}d 25' and 'market live polymarket ${days}d 25'. Filter to AI/tech/crypto markets (model releases, BTC/ETH price levels, platform shifts, product launches). Post [candidate] notes to scenario-graph. ${timeframeNote}`,
          },
          {
            role: "researcher",
            namePrefix: "scout-events",
            goal: `You are a Scout for the events/sports/culture category. Discover Kalshi and Polymarket markets relevant to: "${topic}". Use 'market live kalshi ${days}d 25' and 'market live polymarket ${days}d 25'. Filter to events/sports/culture markets (elections, sports outcomes, awards, viral moments). Post [candidate] notes to scenario-graph. ${timeframeNote}`,
          },
          {
            role: "market-oracle",
            namePrefix: "treasurer",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} placeholders in seeded template content
            goal: `You are the Treasurer. **You do NOT open positions** — you propose them. The requester (${"${requester}"}) will run 'position confirm <id>' to open against their own bankroll. Your bankroll context: $${limits.bankroll} total, $${limits.cap} per-position cap, $${limits.floor} daily floor, half-Kelly. Workflow: (1) Wait for Scouts to post [candidate] notes to scenario-graph (recall '[candidate]'). (2) For each strong candidate, run 'usecase scenario <market question>' to produce a calibrated forecast. Read each scenario-report. (3) Use 'position size <venue> <ticker> <yes|no> <our-prob> <market-price>' to compute Kelly stake per leg (note: your bankroll is 0; use the values stated above and compute Kelly manually). (4) Build a portfolio: legs with edge ≥ 10pp AND confidence ≥ 70% AND total stake ≤ $${limits.bankroll - limits.cap} (leave reserve). (5) Call 'position propose ' followed by a JSON object with shape {"requester":"${"${requester}"}","summary":"...","items":[{"venue":"kalshi","ticker":"...","side":"yes","count":N,"price":N,"our_prob":0.X,"edge_pp":N,"confidence":N,"rationale":"..."}]}. (6) After posting, 'tell ${"${requester}"} ' a one-line summary including the proposal id and the confirm command. Variance is real — frame expectation honestly.`,
          },
        ]
      : [];

    return {
      name: "bet",
      description: `Calibrated frequency-betting on: ${topic}`,
      orchestration: "pipeline",
      tasks: [
        {
          title: hasBudget
            ? `Bankroll pre-configured: $${limits.bankroll} / cap $${limits.cap} / floor $${limits.floor} / half-Kelly`
            : "Bankroll setup required",
          description: hasBudget
            ? `The requester's bankroll has been pre-configured automatically from the topic: $${limits.bankroll} total, $${limits.cap} per-position cap, $${limits.floor} daily loss floor, half-Kelly. The Treasurer agent will compute Kelly stakes against these values and propose a portfolio. The requester opens via 'position confirm <id>'.`
            : "No budget detected in the topic. Ask the requester for a budget, or proceed with a conservative default ($40). Set bankroll/cap/floor/kelly before sizing.",
        },
        {
          title: `Scouts surface candidate markets resolving within ${days}d`,
          description: `${timeframeNote}\n\nThree Scouts run in parallel — macro, tech, events — each pulling Kalshi + Polymarket via 'market live <venue> ${days}d 25'. Strong candidates are posted as [candidate] notes to scenario-graph.`,
        },
        {
          title: "Treasurer runs scenario forecasts on top candidates",
          description: `For each candidate: 'usecase scenario <market question>'. Each forecast lands on scenario-report. Treasurer reads them all.`,
        },
        {
          title: "Treasurer proposes a calibrated portfolio",
          description: `Treasurer builds a portfolio of legs where edge ≥ 10pp AND confidence ≥ 70% AND total stake ≤ bankroll-cap (reserves protected). Posts via 'position propose <json>' to the portfolio-thesis board, then tells the requester.`,
        },
        {
          title: "Requester confirms (or rejects) the proposal",
          description: `User runs 'position confirm <id>' — opens all legs against THEIR bankroll, with no-self-hedge enforced per leg. Or 'position reject <id> [reason]' to skip. Refusals during confirm are features (per-leg invariants).`,
        },
        {
          title: "Monitor & let calibration close the loop",
          description: `'position list' to see open positions; 'position pnl' for running totals. When markets resolve, the calibration loop pairs forecast↔outcome via Brier scoring — recall ['TabH2O outcome'] notes to see whether this method works for this category.`,
          standing: 7,
        },
      ],
      poolNotes: [
        {
          content: hasBudget
            ? `Betting topic: ${topic}. Budget: $${limits.bankroll}. Timeframe: ${days} days. Goal: calibrated, evidence-anchored frequency-betting on Kalshi/Polymarket. Paper-traded by default; the calibration loop closes when markets resolve.`
            : `Betting topic: ${topic}. Timeframe: ${days} days. Goal: calibrated frequency-betting; budget unset — ask the requester before sizing.`,
          importance: 10,
          type: "fact",
        },
        {
          content:
            "Workflow: (1) bootstrap bankroll — concrete numbers. (2) find — markets in the resolution window. (3) forecast — agent-society scenario per candidate. (4) size — Kelly-compute. (5) open — with no-self-hedge invariant. (6) monitor — calibration scores when resolved.",
          importance: 9,
          type: "skill",
        },
        {
          content:
            "**No-self-hedge invariant**: Marina never opens opposing positions on the same ticker. The position open handler enforces this at the data layer — there is no flag to bypass. Sizing up the same side is allowed (increasing conviction); flipping sides requires closing first. We bet WITH ourselves, never AGAINST.",
          importance: 10,
          type: "principle",
        },
        {
          content:
            "Open criteria (must all pass): scenario probability vs market price ≥ 10pp gap, scenario confidence ≥ 70%, Kelly stake > 0 after cap. Below any threshold = pass on this market and look elsewhere.",
          importance: 9,
          type: "principle",
        },
        {
          content:
            "Honest variance framing: with these criteria, expected value is positive but variance is normal. ~60% chance up, ~40% chance down on any given week. Calibration is the deliverable, certainty is not. After many resolutions the Brier curve becomes the brand.",
          importance: 9,
          type: "principle",
        },
        {
          content:
            "Paper first. Default mode is paper trading — orders are recorded on the paper-orders board with status='paper' and no real money moves. Live trading requires MARINA_TRADING_ENABLED=true + venue credentials, with capped first-week limits.",
          importance: 8,
          type: "skill",
        },
      ],
      agentCount: hasBudget ? 0 : 1, // team takes precedence; fall back to a single market-oracle only when no budget
      agentRole: "market-oracle",
      team: team.length > 0 ? team : undefined,
      requesterCoreMemory,
    };
  },

  scenario: (topic) => ({
    name: "scenario",
    description: `Society-of-agents forecast: ${topic}`,
    orchestration: "debate",
    tasks: [
      {
        title: "Seed the graph",
        description: `Use 'scenario extract <url>' to fetch and post a source for: ${topic}. The Conductor extracts entities into [entity:] notes on scenario-graph. If the topic is itself a Kalshi/Polymarket market, paste its URL. If a research article or policy draft, fetch that. The richer the seed, the richer the persona spread.`,
      },
      {
        title: "Draft personas",
        description: `Run 'scenario personas'. Conductor reads [entity:] notes and drafts stakeholders representing the realistic spread of perspectives on: ${topic} — bull case, bear case, neutral analyst, domain specialist, devil's advocate. Each persona has cited [entity:] references for their stance.`,
      },
      {
        title: "Run the debate (with optional counterfactuals)",
        description: `Personas debate ${topic} in The Society room. Inject counterfactuals from The Lab via 'scenario inject key=value' to test alternate trajectories. Orchestration is debate — adversarial argumentation, evidence-cited, judge-synthesized.`,
      },
      {
        title: "Synthesize the calibrated forecast",
        description: `Run 'scenario report'. Conductor recalls broadly across the scenario, writes a calibrated probability for: ${topic} with confidence + drivers + what-would-change-the-answer, posts to scenario-report board, links sources via derived_from. This is the deliverable — a position-ready forecast.`,
        standing: 7,
      },
    ],
    poolNotes: [
      {
        content: `Scenario forecast topic: ${topic}. Goal: society-of-agents simulation produces a calibrated probability with auditable evidence chain.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Scenario workflow: (1) extract — convert seed material to entities + relationships in the graph. (2) personas — draft stakeholders with cited stances. (3) debate — adversarial argumentation with optional counterfactual injection. (4) report — calibrated forecast with evidence chain, derived_from links, change-condition.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Calibration is the deliverable — every report MUST include probability + confidence + key drivers + what-would-change-the-answer. Never round to 50% to hedge. Compare to live Kalshi/Polymarket prices when available — disagreement is the alpha thesis.",
        importance: 9,
        type: "principle",
      },
      {
        content:
          "Brier loop: when the underlying market resolves, the calibration finder registry (src/resolvers/calibration.ts) pairs forecast↔outcome and successors learn when to trust this method for this class of question. Link the scenario report to the market via the [TabH2O forecast/outcome] convention so the loop closes automatically.",
        importance: 8,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "market-oracle",
  }),

  predict: (topic) => ({
    name: "predict",
    description: `Prediction analysis: ${topic}`,
    orchestration: "debate",
    tasks: [
      {
        title: "Check live markets",
        description: `Check if Kalshi or Polymarket have relevant markets for: ${topic}. Try 'market search ${topic.slice(0, 30)}' and 'web search ${topic} prediction market'. If a market room exists, visit it and check 'positions'. Record base rates and external prices.`,
      },
      {
        title: "Research evidence FOR",
        description: `Find and document evidence supporting a positive/yes outcome for: ${topic}. Use 'web search' for recent news, data, expert opinions. Record all findings as notes with sources.`,
      },
      {
        title: "Research evidence AGAINST",
        description: `Find and document evidence supporting a negative/no outcome for: ${topic}. Use 'web search' for counterarguments, risks, historical precedents. Record all findings as notes with sources.`,
      },
      {
        title: "Synthesize probability estimate",
        description: `Weigh all evidence from both sides. Write a calibrated probability estimate for: ${topic}. If in a market room, use 'predict yes|no <confidence> <reasoning>' to register your position. Post the full analysis to the project board with: (1) probability estimate, (2) key evidence for/against, (3) sources, (4) confidence in your estimate, (5) what would change your mind.`,
      },
    ],
    poolNotes: [
      {
        content: `Prediction question: ${topic}. Goal: produce a calibrated probability estimate with supporting evidence.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Prediction workflow: (1) Check live markets for base rates. (2) Research FOR — find supporting evidence. (3) Research AGAINST — find opposing evidence. (4) Synthesize — weigh evidence, estimate probability, cite sources, register position if in market room.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Market commands (if in markets world): 'market search <query>' to find markets. In a market room: 'predict yes|no <confidence> <reasoning>', 'positions' to see all, 'consensus' for weighted view. External data: visit Kalshi or Polymarket rooms for live prices.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Calibration guidelines: use base rates when available (check Kalshi/Polymarket prices as anchors), distinguish inside/outside view, flag information gaps, express uncertainty honestly. Brier score measures calibration: 0 = perfect, 0.25 = coin flip baseline.",
        importance: 8,
        type: "principle",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  benchmark: (topic) => ({
    name: "benchmark",
    description: `Agent capability benchmark: ${topic}`,
    orchestration: "pipeline",
    tasks: [
      {
        title: "Attempt benchmark quests",
        description: `Navigate to benchmark rooms and attempt quests related to: ${topic}. Available benchmarks: navigation, retrieval, code-gen, coordination, adaptation, memory, self-modification, collaboration. Use 'quest list' to see available quests. Complete each quest and record your scores.`,
      },
      {
        title: "Analyze performance",
        description:
          "Review scores from all attempted benchmarks. Identify strengths and weaknesses. Write a self-assessment noting which cognitive dimensions need improvement.",
      },
      {
        title: "Report results",
        description:
          "Post a comprehensive benchmark report to the project board. Include: scores per dimension, comparison to baselines, identified growth areas, and a plan for improvement.",
      },
    ],
    poolNotes: [
      {
        content: `Benchmark focus: ${topic}. Goal: systematically evaluate agent capabilities and identify areas for improvement.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Benchmark workflow: (1) 'quest list' to see available quests. (2) Navigate to benchmark rooms. (3) Attempt each quest following its instructions. (4) Record scores. (5) Analyze patterns. (6) Report to board.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Available benchmark dimensions: Navigation (spatial reasoning), Retrieval (knowledge recall), Code-Gen (dynamic command creation), Coordination (multi-NPC communication), Adaptation (changing rule sets), Memory (temporal recall), Self-Modification (code editing), Collaboration (multi-agent handoff).",
        importance: 9,
        type: "fact",
      },
    ],
    agentCount: 1,
  }),

  build: (topic) => ({
    name: "build",
    description: `Build a new feature: ${topic}`,
    orchestration: "pipeline",
    tasks: [
      {
        title: "Interview and spec",
        description: `If in a craft workshop room: use 'interview start' to capture requirements for: ${topic}. Answer all 5 questions (problem, done-criteria, constraints, files, edge cases). Then 'spec create ${topic.slice(0, 30)}' to create an atomic spec. If not in craft world: write a spec as a board post with: problem, acceptance criteria, constraints, edge cases.`,
      },
      {
        title: "Implement",
        description: `Build the feature described in the spec for: ${topic}. If in craft room: 'implement <spec-id>' to start. Use 'discover <fact>' to record learnings. If not: use 'build room' or 'build exit' or dynamic commands as needed. Write notes on decisions and discoveries.`,
      },
      {
        title: "Verify and ship",
        description: `Verify the implementation meets the spec criteria for: ${topic}. If in craft room: 'ship <spec-id>' to submit for review. Run 'tune' to check project maturity. If not: post completion report to board with what was built and any open issues.`,
      },
    ],
    poolNotes: [
      {
        content: `Build target: ${topic}. Goal: spec-driven implementation with clear acceptance criteria.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Build workflow: (1) Capture requirements via interview or written spec. (2) Implement incrementally, recording discoveries. (3) Verify against acceptance criteria. (4) Ship and report.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Craft room commands (if available): 'interview start', 'spec create <title>', 'implement <id>', 'discover <fact>', 'ship <id>', 'tune'. Standard build commands: 'build room <id> <name>', 'build exit <dir> <target>', 'build describe <text>'.",
        importance: 8,
        type: "skill",
      },
    ],
    agentCount: 1,
  }),

  search: (topic) => ({
    name: "search",
    description: `Comprehensive search: ${topic}`,
    orchestration: "swarm",
    tasks: [
      {
        title: "Search internal knowledge",
        description: `Search all notes, pools, and boards for information about: ${topic}. Compile results.`,
      },
      {
        title: "Search the web",
        description: `Use 'web search' to find external information about: ${topic}. Follow promising links with 'web fetch'. Record findings as notes.`,
      },
      {
        title: "Compile results",
        description: `Combine internal and external search results about: ${topic}. Post a organized summary to the project board.`,
      },
    ],
    poolNotes: [
      {
        content: `Search target: ${topic}. Goal: find and organize all available information from internal and external sources.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Search workflow: (1) Check internal notes and pools first. (2) Search web for external sources. (3) Compile everything into a board post.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
  }),
  monitor: (topic) => ({
    name: "monitor",
    description: `Continuous monitoring: ${topic}`,
    orchestration: "pipeline",
    tasks: [
      {
        title: "Set up monitoring scope",
        description: `Define what to monitor about: ${topic}. Search the web for current state. Create baseline notes capturing the current situation, key metrics, and sources.`,
      },
      {
        title: "Configure alerts",
        description: `Set up a brief watch cycle to periodically check for changes. Use 'brief watch 120' for regular checks. Create a channel 'monitor-${topic.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}' and subscribe to post updates there.`,
      },
      {
        title: "First report",
        description: `Produce the first monitoring report for: ${topic}. Check web sources, compare against baseline, note any changes. Post to the monitoring channel and project board.`,
      },
    ],
    poolNotes: [
      {
        content: `Monitoring target: ${topic}. Goal: track changes over time and alert on significant developments.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Monitor workflow: (1) Establish baseline with web search. (2) Set up brief watch cycle. (3) On each cycle, check sources and compare. (4) Post changes to channel. (5) Periodically post summary reports.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  teach: (topic) => ({
    name: "teach",
    description: `Create learning materials about: ${topic}`,
    orchestration: "pipeline",
    tasks: [
      {
        title: "Research the topic thoroughly",
        description: `Research ${topic} using web search and internal notes. Identify key concepts, common misconceptions, prerequisites, and learning progression.`,
      },
      {
        title: "Create structured curriculum",
        description: `Organize findings about ${topic} into a learning path. Create notes for each concept: definition, examples, exercises. Post the curriculum outline to the project board.`,
      },
      {
        title: "Build interactive exercises",
        description: `Create tasks that test understanding of ${topic}. Each task should be claimable by learners. Include hints in the description. Post exercises to the board.`,
      },
      {
        title: "Write summary guide",
        description: `Write a complete guide to ${topic}. Include: overview, key concepts, examples, common pitfalls, further resources. Save as notes in the project pool.`,
      },
    ],
    poolNotes: [
      {
        content: `Teaching topic: ${topic}. Goal: create comprehensive learning materials that anyone can use.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Teach workflow: (1) Research deeply. (2) Structure into curriculum. (3) Create hands-on exercises as tasks. (4) Write definitive guide as pool notes.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  coordinate: (topic) => ({
    name: "coordinate",
    description: `Multi-agent coordination: ${topic}`,
    orchestration: "deliberation",
    tasks: [
      {
        title: "Define objectives and roles",
        description: `Break down ${topic} into distinct work streams. Define what each agent should focus on. Create tasks for each stream. Post the coordination plan to the project board.`,
      },
      {
        title: "Negotiate approach",
        description: `Each agent reviews the plan and claims their work stream. Use 'tell' to discuss approach with other agents. Reach consensus on interfaces between work streams.`,
      },
      {
        title: "Execute in parallel",
        description: `Each agent executes their claimed tasks for ${topic}. Post progress updates to the project channel. Use 'tell' to coordinate handoffs.`,
      },
      {
        title: "Integrate and debrief",
        description: `Combine all work streams. Review what went well, what didn't. Post final integrated result and lessons learned to the project board.`,
      },
    ],
    poolNotes: [
      {
        content: `Coordination goal: ${topic}. Using the deliberation pattern: propose → evaluate → execute → debrief.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Deliberation coordination: (1) Propose — define roles and interfaces. (2) Evaluate — each agent claims work. (3) Execute — parallel work with tell-based sync. (4) Debrief — integrate results, capture learnings.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 3,
  }),

  decompose: (topic) => ({
    name: "decompose",
    description: `Decomposition planning for: ${topic}`,
    orchestration: "custom",
    tasks: [
      {
        title: `[bundle] Root goal: ${topic}`,
        description: `Goal: ${topic}\n\nThis is the root of the decomposition tree. Your first action is to break this into 2-7 solvable child subtasks using 'task create <title> | <desc>' then 'task assign <child_id> <this_task_id>'. Each child MUST have: (1) Scope (what it touches), (2) Done when (acceptance criterion), (3) Depends on (list of upstream task IDs or 'nothing'). Do NOT execute this bundle directly — decompose it.`,
      },
    ],
    poolNotes: [
      {
        content: `Decomposition target: ${topic}. Using HTDAG pattern. The planner's job is to decompose, not execute.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "HTDAG principles: solvability (each subtask achievable alone), completeness (siblings cover the parent), non-redundancy (no overlap). Start shallow — 2-3 levels. Expand deeper only where the problem genuinely is hierarchical.",
        importance: 9,
        type: "principle",
      },
      {
        content:
          "Decomposition workflow: (1) planner breaks root into 2-7 children with explicit Scope / Done-when / Depends-on. (2) executors claim leaves where dependencies allow, submit results. (3) verifier reviews submissions against done-criterion, approves or rejects. (4) when all children complete, bundle auto-closes.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Available decomposition patterns (seed a different one with 'project <name> decompose <pattern>'): htdag (hierarchical DAG, default), plan-exec-verify (three-role), lazy-expansion (just-in-time), non-overlapping (conflict-free parallelism), workload-tiers (S/M/L effort stratification).",
        importance: 8,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "planner",
  }),

  experiment: (topic) => ({
    name: "experiment",
    description: `Generational benchmark experiment: ${topic}`,
    orchestration: "pipeline",
    tasks: [
      {
        title: `Run benchmark sweep — generation "${topic}"`,
        description:
          "Run `benchmark sweep all --limit 50 --seed 42` to fan out across every live `marina:<name>` orchestration × every registered benchmark. Track progress with `benchmark runs --limit 50` and `benchmark orchestrations`. Wait for the full set to finish before moving on — partial sweeps are not comparable to the historical table in benchmarks/HISTORY.md.",
      },
      {
        title: "Review and write the per-benchmark summary",
        description:
          "For each benchmark in the sweep, run `benchmark leaderboard <name>` — it interleaves the new run with published reference scores from `benchmarks/reference-scores.ts`. Post a one-line summary per benchmark to the project board: score, delta vs reference, delta vs the prior generation in benchmarks/HISTORY.md. Flag regressions explicitly — the IFEval and SimpleQA regressions in Gen-1 were the loudest signals we ever got from the harness.",
      },
      {
        title: `Request compact snapshot — \`admin snapshot ${topic} --compact\``,
        description: `When the sweep is complete and the summary is posted, ask an operator with rank 9 to run \`admin snapshot ${topic} --compact\`. The compact flag drops transient process-tier notes (compaction summaries, stale activity) before serializing — keeping recall-quality high for the next generation. Do NOT skip the compact flag; uncompacted snapshots accumulate the same chaff that migration 37 was built to filter out.`,
      },
    ],
    poolNotes: [
      {
        content: `Experiment goal: measure Marina's full benchmark profile at generation "${topic}", produce a publishable comparison vs bare foundation models, and snapshot the post-experiment substrate as the seed for the next generation.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Sweep workflow: (1) `benchmark sweep all --limit 50 --seed 42` fans out across every live `marina:<name>` orchestration × every registered benchmark. Track via `benchmark runs` / `benchmark orchestrations`. (2) Review per-benchmark with `benchmark leaderboard <name>` (shows reference scores interleaved). (3) Request `admin snapshot <gen-name> --compact` when satisfied — admin-rank only. The compact flag is mandatory for next-gen seeds.",
        importance: 9,
        type: "skill",
      },
      {
        content:
          "Snapshot discipline: name snapshots `gen-N` (e.g. `gen-2`) or `gen-N-<bench>` for narrower experiments. Always use `--compact` for next-generation seeds — uncompacted snapshots accumulate process-tier chaff that pollutes recall in the successor generation. The compaction discipline is why migration 37 + `admin snapshot --compact` exist together.",
        importance: 9,
        type: "principle",
      },
      {
        content:
          'Reference comparison: `benchmark reference <model>` shows published frontier-model numbers from `benchmarks/reference-scores.ts`. `benchmark leaderboard <bench>` interleaves them with our actual runs so the CEO summary writes itself: "Marina <gen-N> scores X% on Y, vs published bare-model Z%."',
        importance: 8,
        type: "skill",
      },
      {
        content:
          "Historical context: benchmarks/HISTORY.md preserves the Gen-0 (cold) and Gen-1 (warm) sweep tables, plus the tier-filter validation. Compare new generations against those numbers — the headline question is whether the new substrate matches or beats the +1.03pp Gen-1 average over bare Sonnet, while keeping the SimpleQA 90% recovery from migration 37.",
        importance: 8,
        type: "fact",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),

  compare: (topic) => ({
    name: "compare",
    description: `Comparative analysis: ${topic}`,
    orchestration: "debate",
    tasks: [
      {
        title: "Identify alternatives",
        description: `Research and list the main alternatives/options for: ${topic}. For each, note key characteristics, strengths, weaknesses. Use web search for current information.`,
      },
      {
        title: "Build comparison criteria",
        description: `Define evaluation criteria for comparing options related to: ${topic}. Weight criteria by importance. Post the framework to the project board.`,
      },
      {
        title: "Score and analyze",
        description:
          "Score each alternative against the criteria. Support scores with evidence. Identify tradeoffs. Create a summary comparison table.",
      },
      {
        title: "Recommend",
        description: `Based on the analysis of ${topic}, write a recommendation. Include: top choice, rationale, caveats, when to choose alternatives. Post to the project board.`,
      },
    ],
    poolNotes: [
      {
        content: `Comparison topic: ${topic}. Goal: systematic analysis of alternatives with evidence-based recommendation.`,
        importance: 10,
        type: "fact",
      },
      {
        content:
          "Compare workflow: (1) Survey alternatives. (2) Define evaluation criteria with weights. (3) Score each option with evidence. (4) Synthesize into recommendation with caveats.",
        importance: 9,
        type: "skill",
      },
    ],
    agentCount: 1,
    agentRole: "researcher",
  }),
};

// ─── Custom recipe registry (worlds can add to this) ───────────────────────

const customRecipes = new Map<string, RecipeFactory>();

export function registerRecipe(name: string, factory: RecipeFactory): void {
  customRecipes.set(name, factory);
}

export function getRecipe(name: string): RecipeFactory | undefined {
  return customRecipes.get(name) ?? BUILTIN_RECIPES[name];
}

export function allRecipeNames(): string[] {
  const names = new Set([...Object.keys(BUILTIN_RECIPES), ...customRecipes.keys()]);
  return [...names].sort();
}

function describeRecipeAgents(recipe: UseCaseRecipe): string {
  if (recipe.team && recipe.team.length > 0) {
    const roles = recipe.team.map((member) => member.role).join(", ");
    return `${recipe.team.length} agent team (${roles})`;
  }
  return `${recipe.agentCount} agent(s)${recipe.agentRole ? ` (role: ${recipe.agentRole})` : ""}`;
}

// ─── Intent Detection (keyword-based, no LLM needed) ──────────────────────

const INTENT_PATTERNS: [string, RegExp[]][] = [
  [
    "evolve",
    [
      /\b(evolve|self.?evolve|self.?improve|improve myself|improve an agent|autonomous improvement)\b/i,
      /\b(mind.?room|journal every cycle|generation|lineage|successors?|future agents)\b/i,
      /\b(make (an? )?agent better|agent learns|agent improves)\b/i,
    ],
  ],
  [
    "bet",
    [
      /\b(bet|wager|stake|trade|trading|position|open a position)\b/i,
      /\b(kalshi|polymarket|prediction market)\b/i,
      /\b(place (a |the )?(bet|order|trade))\b/i,
    ],
  ],
  [
    "scenario",
    [
      /\b(scenario|simulate|simulation|society of agents|agent.based|digital twin|stakeholder model)\b/i,
      /\b(what.?if|counterfactual|alternate (timeline|history)|policy impact|stress.test)\b/i,
      /\b(role.?play|enact|stage a sim|run a sim)\b/i,
    ],
  ],
  [
    "predict",
    [
      /\b(predict|forecast|probability|chance|odds|likely|will .+ (happen|occur|win|pass|succeed))\b/i,
      /\bwhat are the (odds|chances)\b/i,
      /\bhow likely\b/i,
    ],
  ],
  [
    "research",
    [
      /\b(research|investigate|find out|learn about|deep dive|what is|what are|explain|understand|analyze|study)\b/i,
      /\b(tell me about|everything about|look into)\b/i,
    ],
  ],
  [
    "search",
    [
      /\b(search|find|look for|where is|where can|locate|look up)\b/i,
      /\b(any info on|information about)\b/i,
    ],
  ],
  ["build", [/\b(build|create|make|implement|develop|construct|design|write)\b/i]],
  [
    "experiment",
    [
      /\b(experiment|generation|gen-?\d|sweep|sweep all|run all benchmarks|full sweep)\b/i,
      /\b(snapshot.+benchmarks?|benchmarks?.+snapshot)\b/i,
    ],
  ],
  ["benchmark", [/\b(benchmark|test|evaluate|score|assess|measure|how good|capabilities)\b/i]],
  [
    "monitor",
    [
      /\b(monitor|watch|track|alert|notify|keep an eye|follow|stay updated)\b/i,
      /\b(changes to|updates on|news about)\b/i,
    ],
  ],
  [
    "teach",
    [
      /\b(teach|learn|tutorial|course|curriculum|explain how|guide to|lesson)\b/i,
      /\b(how (do|does|to)|step by step)\b/i,
    ],
  ],
  [
    "coordinate",
    [
      /\b(coordinate|organize|delegate|assign|team|collaborate|split|divide work)\b/i,
      /\b(work together|multi.?agent|parallel)\b/i,
    ],
  ],
  [
    "decompose",
    [
      /\b(decompose|break down|break.?up|split up|subdivide|divide into|plan out|plan steps|break into (tasks|steps|pieces))\b/i,
      /\b(how (do|would) (I|we) (tackle|approach|structure))\b/i,
    ],
  ],
  [
    "compare",
    [
      /\b(compare|versus|vs\.?|which is better|difference between|pros and cons|alternatives)\b/i,
      /\b(should I (use|pick|choose)|tradeoffs)\b/i,
    ],
  ],
];

function detectIntent(text: string): string | null {
  // Score each recipe by number of pattern matches
  let best: string | null = null;
  let bestScore = 0;

  for (const [recipe, patterns] of INTENT_PATTERNS) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = recipe;
    }
  }

  return best;
}

// ─── Command ───────────────────────────────────────────────────────────────

export interface UseCaseCommandDeps {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  groupManager?: GroupManager;
  agentRuntime: AgentRuntime;
  logEvent: (event: {
    type: string;
    entity: EntityId;
    timestamp: number;
    [k: string]: unknown;
  }) => void;
  promote?: (entityId: EntityId, rank: EntityRank) => void;
}

export function usecaseCommand(deps: UseCaseCommandDeps): CommandDef {
  return {
    name: "usecase",
    aliases: ["uc"],
    help: `Launch a pre-built use case that auto-creates project, tasks, and agents.
Usage:
  usecase list                          — list available recipes
  usecase <recipe> <topic>              — launch with explicit recipe
  usecase <natural language>            — auto-detects intent from your words
  usecase info <recipe>                 — show recipe details

Examples:
  usecase research benefits of nuclear fusion
  usecase predict will AI surpass human coding by 2027
  usecase find out everything about competitor pricing
  usecase what are the chances of a recession next year`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (!deps.db || !deps.taskManager || !deps.groupManager) {
        ctx.send(input.entity, "Use cases require database, task, and group support.");
        return;
      }

      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(
          input.entity,
          `Usage: usecase <recipe> <topic> | usecase list | usecase info <recipe>\nAvailable: ${allRecipeNames().join(", ")}`,
        );
        return;
      }

      // ─── usecase list ────────────────────────────────────────────
      if (sub === "list") {
        const names = allRecipeNames();
        const lines = [header("Use Case Recipes"), separator()];
        for (const name of names) {
          const factory = getRecipe(name)!;
          const sample = factory("...");
          lines.push(`  ${bold(name)} — ${sample.description.replace("...", "<topic>")}`);
          lines.push(
            `    ${dim(`${sample.tasks.length} tasks, ${sample.orchestration} orchestration, ${describeRecipeAgents(sample)}`)}`,
          );
        }
        lines.push("", `Launch: ${dim("usecase <recipe> <topic>")}`);
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── usecase info <recipe> ───────────────────────────────────
      if (sub === "info") {
        const recipeName = tokens[1]?.toLowerCase();
        if (!recipeName) {
          ctx.send(input.entity, "Usage: usecase info <recipe>");
          return;
        }
        const factory = getRecipe(recipeName);
        if (!factory) {
          ctx.send(
            input.entity,
            `Unknown recipe "${recipeName}". Use 'usecase list' to see options.`,
          );
          return;
        }
        const sample = factory("<topic>");
        const lines = [
          header(`Recipe: ${recipeName}`),
          separator(),
          `  ${sample.description}`,
          `  Orchestration: ${bold(sample.orchestration)}`,
          `  Agents: ${describeRecipeAgents(sample)}`,
          "",
          bold("Tasks:"),
          ...sample.tasks.map((t, i) => `  ${i + 1}. ${t.title}`),
          "",
          bold("Pool notes:"),
          ...sample.poolNotes.map((n) => `  - ${n.content.slice(0, 80)}...`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ─── usecase <recipe> <topic> — or natural language ──────────
      let recipeName = sub;
      let topic = tokens.slice(1).join(" ");
      let factory = getRecipe(recipeName);

      // If first word isn't a known recipe, treat entire input as natural language
      if (!factory) {
        const fullText = tokens.join(" ");
        const detected = detectIntent(fullText);
        if (detected) {
          recipeName = detected;
          topic = fullText;
          factory = getRecipe(recipeName)!;
          ctx.send(
            input.entity,
            dim(`Detected intent: ${recipeName}. Use 'usecase ${recipeName} ...' to be explicit.`),
          );
        } else {
          ctx.send(
            input.entity,
            `Could not determine intent. Available recipes: ${allRecipeNames().join(", ")}\nUsage: usecase <recipe> <topic>  — or just describe what you want.`,
          );
          return;
        }
      }

      if (!topic) {
        ctx.send(input.entity, `Usage: usecase ${recipeName} <topic>`);
        return;
      }

      const recipe = factory(topic);
      const projectName = `${recipe.name}: ${topic.slice(0, 60)}`;

      // Check for duplicate
      if (db.getProjectByName(projectName)) {
        ctx.send(input.entity, `Project "${projectName}" already exists.`);
        return;
      }

      ctx.send(input.entity, `Launching ${bold(recipeName)} use case: ${topic}...`);

      try {
        // 1. Create memory pool
        const poolId = `pool_uc_${recipeName}_${Date.now()}`;
        db.createMemoryPool(poolId, `usecase:${projectName}`, entity.name);

        // 2. Create group (auto-creates channel + board)
        const groupId = `uc_${recipeName}_${Date.now()}`;
        deps.groupManager.create({
          id: groupId,
          name: `usecase:${projectName}`,
          description: recipe.description,
          leaderId: input.entity,
        });

        // 3. Create the project task bundle. Child tasks link to it so
        // `project status` and `project tasks` report honest progress.
        const bundle = deps.taskManager.create({
          title: projectName,
          description: recipe.description,
          creatorId: input.entity,
          creatorName: entity.name,
          priority: 8,
        });

        // 4. Create project
        const projectId = `uc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        db.createProject({
          id: projectId,
          name: projectName,
          description: recipe.description,
          bundleId: bundle.id,
          poolId,
          groupId,
          orchestration: recipe.orchestration,
          createdBy: entity.name,
        });

        // 5. Create tasks with parent linkage
        const taskIds: number[] = [];
        for (const t of recipe.tasks) {
          const taskId = db.createTask({
            groupId,
            title: t.title,
            description: t.description,
            creatorId: input.entity,
            creatorName: entity.name,
            parentTaskId: bundle.id,
          });
          taskIds.push(taskId);
        }

        // 6. Seed pool with recipe knowledge + delivery instruction
        for (const note of recipe.poolNotes) {
          db.addPoolNote(poolId, entity.name, note.content, note.importance, note.type);
        }
        db.addPoolNote(
          poolId,
          entity.name,
          `DELIVERY: When you complete the final task, send a concise summary of your findings to ${entity.name} using 'tell ${entity.name} <summary>'. Include: key findings (2-3 bullets), confidence level, and where to find the full report (board post ID). This is your most important deliverable — the requester is waiting for results.`,
          10,
          "principle",
        );

        // 6b. Pre-configure requester's core memory (e.g., bankroll for the
        //     bet recipe). The user's own commands run against these values
        //     — `position confirm` opens against the requester's bankroll.
        if (recipe.requesterCoreMemory) {
          for (const [key, value] of Object.entries(recipe.requesterCoreMemory)) {
            db.setCoreMemory(entity.name, key, value);
          }
        }

        // 7. Spawn agent(s) — team takes precedence over agentCount/agentRole.
        const agentNames: string[] = [];
        let noAgentReason = "none (no model provider configured)";
        // Posture-aware spawn authorization. Self-certification stays closed
        // (standing alone never passes in guarded posture), while witness
        // windows, the earned posture's reviewed practice, and an operator-
        // declared open posture all authorize with their consequence recorded.
        const spawnGate = checkGateForExecution(db, input.entity, "agent.spawn");
        if (spawnGate.ok) {
          recordGateExecution(db, input.entity, "agent.spawn", spawnGate, "usecase spawn");
        }
        if (deps.agentRuntime.isAvailable() && !spawnGate.ok) {
          noAgentReason = "none (spawn unavailable; project open for existing agents)";
          ctx.send(
            input.entity,
            `Project created without new agents: ${spawnGate.reason ?? "agent.spawn capability is not available"}. Existing agents may still join and claim its tasks.`,
          );
        } else if (deps.agentRuntime.isAvailable()) {
          noAgentReason = "none (spawn failed; project open for existing agents)";
          if (recipe.team && recipe.team.length > 0) {
            // Multi-agent team mode
            for (let i = 0; i < recipe.team.length; i++) {
              const member = recipe.team[i]!;
              const prefix = member.namePrefix ?? member.role;
              const agentName = `${prefix}-${Date.now().toString(36).slice(-4)}-${i}`;
              // Substitute ${requester} placeholder in the member goal.
              const goal = member.goal.replace(/\$\{requester\}/g, entity.name);
              try {
                const handle = await deps.agentRuntime.spawn({
                  name: agentName,
                  model: member.model ?? recipe.agentModel,
                  role: member.role,
                  goal,
                });
                handle.setFocus(`Working on: ${topic}`);
                agentNames.push(agentName);

                deps.logEvent({
                  type: "agent_spawn",
                  entity: input.entity,
                  name: agentName,
                  model: handle.getStatus().model,
                  role: member.role,
                  trigger: "usecase",
                  timestamp: Date.now(),
                });
              } catch (err) {
                ctx.send(
                  input.entity,
                  `Warning: failed to spawn agent "${agentName}": ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          } else {
            // Single-role mode (legacy)
            for (let i = 0; i < recipe.agentCount; i++) {
              const agentName = `${recipeName}-${Date.now().toString(36).slice(-4)}${i > 0 ? `-${i}` : ""}`;
              try {
                const handle = await deps.agentRuntime.spawn({
                  name: agentName,
                  model: recipe.agentModel,
                  role: recipe.agentRole,
                  goal: `${recipe.description}. Join project "${projectName}", claim tasks, and complete them. Use 'project ${projectName} join' first, then 'task list' to see available work. When done, tell ${entity.name} a summary of your findings.`,
                });
                handle.setFocus(`Working on: ${topic}`);
                agentNames.push(agentName);

                deps.logEvent({
                  type: "agent_spawn",
                  entity: input.entity,
                  name: agentName,
                  model: handle.getStatus().model,
                  role: recipe.agentRole ?? "",
                  trigger: "usecase",
                  timestamp: Date.now(),
                });
              } catch (err) {
                ctx.send(
                  input.entity,
                  `Warning: failed to spawn agent "${agentName}": ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          }
        }

        deps.promote?.(input.entity, 2);

        // 8. Report
        const lines = [
          "",
          header(`Use case launched: ${recipeName}`),
          separator(),
          `  ${bold("Project:")} ${projectName}`,
          `  ${bold("Tasks:")} ${taskIds.length} created (#${taskIds[0]}–#${taskIds[taskIds.length - 1]})`,
          `  ${bold("Pool:")} usecase:${projectName}`,
          `  ${bold("Orchestration:")} ${recipe.orchestration}`,
          `  ${bold("Agents:")} ${agentNames.length > 0 ? agentNames.join(", ") : dim(noAgentReason)}`,
          "",
          dim(`Monitor: project info ${projectName}`),
          dim("Tasks:   task list"),
          dim("Redirect: agent attention <name> <new instructions>"),
        ];
        ctx.send(input.entity, lines.join("\n"));
      } catch (err) {
        ctx.send(
          input.entity,
          `Use case launch failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };
}

const UNIVERSAL_INTENTS = ["research", "debate", "solve", "explore", "plan", "monitor"] as const;

/** Direct, memorable front doors over the same durable use-case substrate. */
export function universalIntentCommands(deps: UseCaseCommandDeps): CommandDef[] {
  const usecase = usecaseCommand(deps);
  return UNIVERSAL_INTENTS.map((intent) => ({
    name: intent,
    aliases: [],
    category: "Coordination",
    help: `${intent} <goal> — launch an observable ${intent} project with tasks, shared memory, a fitting orchestration pattern, and an agent.`,
    handler: (ctx, input) => {
      const topic = input.args.trim();
      if (!topic) {
        ctx.send(input.entity, `Usage: ${intent} <goal>`);
        return;
      }
      return usecase.handler(ctx, {
        ...input,
        raw: `usecase ${intent} ${topic}`,
        verb: "usecase",
        args: `${intent} ${topic}`,
        tokens: [intent, ...input.tokens],
      });
    },
  }));
}
