// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The playbook: Marina's use cases as executable steps. Each use case is a
 * short sequence of world commands a person would type, with what must hold —
 * the command succeeds or is refused, its reply carries certain words, and it
 * stays under a time and cost ceiling.
 *
 * Two runners read this one list:
 *  - `test/playbook.test.ts` runs every step that needs no model and no network
 *    in an in-process engine, on every test run.
 *  - `bun run playbook` boots an isolated server per world and runs every step
 *    it may (model, network, long), recording time and cost per step
 *    (`scripts/playbook/run.ts`).
 *
 * A step's text checks are deliberately loose (a word or two): a model's answer
 * changes run to run; the shape of the reply does not.
 */

export interface PlaybookStep {
  /** The world command, exactly as a person types it. `{dir}` = this run's scratch folder. */
  command: string;
  /** "ok" (default): the command succeeds. "refused": it must be refused. */
  expect?: "ok" | "refused";
  /** Each must appear in the reply (ANSI stripped, case-insensitive). */
  contains?: string[];
  /** None may appear in the reply. */
  excludes?: string[];
  /** Repeat the command until `contains` holds, up to this many seconds. */
  untilSeconds?: number;
  /** Seconds between `untilSeconds` attempts (default 15). */
  everySeconds?: number;
  /** Who types it (default: the use case's person). */
  as?: string;
  /** Ceilings checked by the live runner. */
  maxSeconds?: number;
  maxUsd?: number;
}

/** What a use case needs beyond an engine: the live runner may provide it, the in-process test never does. */
export type PlaybookNeed = "model" | "network" | "long" | "world";

export interface PlaybookUseCase {
  /** Stable id: `--only forecast,research`. */
  id: string;
  title: string;
  /** Needs every step shares; a step needing more marks itself through its use case. */
  needs: PlaybookNeed[];
  /** A world other than the default Workbench (implies need "world" in-process). */
  world?: string;
  /** Extra server environment for this use case's isolated server. */
  env?: Record<string, string>;
  /** Files written into the run's scratch folder before the steps run (`{dir}/<name>`). */
  files?: Record<string, string>;
  steps: PlaybookStep[];
}

const PHISHING_PLAYBOOK = `---
name: phishing-triage
description: Triage a reported phishing email and decide whether to open an incident.
---
1. Record the sender, subject, links and attachments without opening them.
2. Check whether the sender domain or links appear in the incidents pool.
3. If a user clicked a link or entered credentials, open an incident and notify the on-call lead.
4. Otherwise close as reported-only and add the indicators to the incidents pool.
`;

export const PLAYBOOK: readonly PlaybookUseCase[] = [
  // ── Model-free: run in-process on every test run ──────────────────────────
  {
    id: "memory",
    title: "Memory that carries across sessions",
    needs: [],
    steps: [
      {
        command:
          "memory note We chose Vendor B for the data platform because of EU data residency.",
        contains: ["saved"],
      },
      { command: "memory recall data platform vendor", contains: ["Vendor B"] },
      {
        command:
          "memory note We pin Postgres to 16.4 because 17 broke the logical replication slot",
      },
      { command: "memory recap postgres", contains: ["16.4"] },
      { command: "pool create incidents", contains: ["created"] },
      {
        command:
          "pool incidents add Phishing wave 2026-11-04 used lookalike domain acme-billing.co importance:7",
        contains: ["Added note"],
      },
    ],
  },
  {
    id: "stress-test-catalogue",
    title: "Stress-test formats are listed",
    needs: [],
    steps: [{ command: "pattern list", contains: ["debate", "verification", "delphi"] }],
  },
  {
    id: "schedules",
    title: "Scheduled briefings are set up and listed",
    needs: [],
    steps: [
      {
        command:
          "schedule add eu-ai-brief daily:07:00 -- research ask -- What changed in EU AI regulation in the last 24 hours? Cite sources.",
        contains: ["daily 07:00 UTC"],
      },
      { command: "schedule list", contains: ["eu-ai-brief"] },
      { command: "schedule show eu-ai-brief", contains: ["research ask"] },
      { command: "schedule add bad nonsense:1 -- look", expect: "refused" },
    ],
  },
  {
    id: "tabletop-room",
    title: "A tabletop room with a turn rule",
    needs: [],
    steps: [
      { command: "build room tabletop/war-room Incident War Room", contains: ["Created room"] },
      { command: "build formation tabletop/war-room debate", contains: ["debate"] },
      {
        command: "agent spawn Red-Actor role researcher budget 300 goal Play the attacker",
        expect: "refused",
        contains: ["try Red_Actor"],
      },
    ],
  },
  {
    id: "simulation-world",
    title: "Simulation building blocks",
    needs: [],
    steps: [
      { command: "build room market/square Town Square", contains: ["Created room"] },
      { command: "build room market/exchange The Exchange", contains: ["Created room"] },
      { command: "build link market/square east market/exchange", contains: ["Linked exit"] },
      { command: "recruit available" },
      { command: "standing top 20", contains: ["Standing"] },
    ],
  },
  {
    id: "governance",
    title: "Permissions, approvals and the ops inbox",
    needs: [],
    files: { "phishing-triage.md": PHISHING_PLAYBOOK },
    steps: [
      { command: "skill import {dir}/phishing-triage.md", contains: ["phishing-triage"] },
      { command: "skill list", contains: ["phishing-triage"] },
      { command: "gate list", contains: ["shell.exec", "trading.live"] },
      { command: "challenge summary 7", contains: ["held"] },
      { command: "ops inbox" },
      {
        command: "connect add internal http://127.0.0.1:3401/mcp",
        expect: "refused",
        contains: ["Blocked URL"],
      },
    ],
  },
  {
    id: "catalogues",
    title: "Benchmarks and code readiness are discoverable",
    needs: [],
    steps: [
      { command: "benchmark list", contains: ["Benchmarks", "hle-verified-gold"] },
      { command: "code doctor", contains: ["Code Doctor"] },
    ],
  },

  // ── Network, no model ─────────────────────────────────────────────────────
  {
    id: "outside-data",
    title: "Official data, market prices, web search and tools",
    needs: ["network"],
    steps: [
      { command: "data series CPIAUCSL", contains: ["CPIAUCSL"], maxSeconds: 30 },
      {
        command: "web multisearch SOC 2 Type II changes 2026 | ISO 42001 certification bodies",
        contains: ["Multi-Search"],
        maxSeconds: 60,
      },
      { command: "connect add deepwiki https://mcp.deepwiki.com/mcp", contains: ["added"] },
      { command: "connect tools deepwiki", contains: ["read_wiki_structure"], maxSeconds: 30 },
    ],
  },

  // ── Model-backed: the live runner only ────────────────────────────────────
  {
    id: "forecast",
    title: "Forecasting desk",
    needs: ["model", "network"],
    steps: [
      {
        command: "forecast Will Brent crude close above $90 on 2027-03-31?",
        contains: ["Forecast", "→", "% "],
        maxSeconds: 420,
        maxUsd: 3,
      },
      { command: "forecast list", contains: ["Brent"] },
    ],
  },
  {
    id: "research",
    title: "Cited research brief",
    needs: ["model", "network"],
    steps: [
      {
        command:
          "research ask -- What changed in EU AI Act obligations for general-purpose AI models in 2026?",
        contains: ["citations:"],
        maxSeconds: 240,
        maxUsd: 1.5,
      },
      {
        command:
          "memory note We chose Vendor B for the data platform because of EU data residency.",
      },
      {
        command: "ask What did we decide about the data platform vendor?",
        contains: ["Vendor B"],
        maxSeconds: 60,
        maxUsd: 0.1,
      },
    ],
  },
  {
    id: "stress-test",
    title: "Stress-test a plan",
    needs: ["model"],
    steps: [
      {
        command:
          "pattern run verification -- Check this claim against public sources: the EU AI Act general-purpose AI obligations started applying in August 2025.",
        contains: ["Pattern: verification"],
        maxSeconds: 180,
        maxUsd: 0.5,
      },
      {
        command:
          "pattern run debate budget:1 -- Pre-mortem: we launch self-serve pricing in EMEA on 1 March 2027 with no sales-assist tier. Find the ways this fails.",
        contains: ["Pattern: debate"],
        maxSeconds: 300,
        maxUsd: 1.1,
      },
    ],
  },
  {
    id: "tabletop",
    title: "Tabletop exercise with three AI players",
    needs: ["model"],
    steps: [
      { command: "build room tabletop/war-room Incident War Room" },
      { command: "build formation tabletop/war-room debate" },
      {
        command:
          "agent spawn Red_Actor role researcher budget 60 goal Play a ransomware crew that already holds domain admin, never help the defenders",
        contains: ["spawned"],
      },
      {
        command:
          "agent spawn Blue_Lead role general budget 60 goal Lead incident response for Acme, contain, preserve evidence, communicate",
        contains: ["spawned"],
      },
      {
        command:
          "agent spawn CFO_Sim role general budget 40 goal Play the CFO, weigh ransom, downtime cost and disclosure duties",
        contains: ["spawned"],
      },
      {
        command:
          "crew create ir-tabletop Red_Actor,Blue_Lead,CFO_Sim formation:debate -- 02:00 Saturday: billing cluster encrypted, ransom note demands 40 BTC",
        contains: ["created"],
      },
      {
        command:
          "crew dispatch ir-tabletop Inject 2: a journalist emails asking whether customer card data was taken",
        contains: ["Dispatched"],
      },
      {
        command: "crew info ir-tabletop",
        contains: ["Red_Actor", "Blue_Lead", "CFO_Sim"],
        untilSeconds: 180,
        everySeconds: 15,
        maxUsd: 1,
      },
    ],
  },
  {
    id: "schedule-run",
    title: "A scheduled briefing runs with its owner away",
    needs: ["model", "network", "long"],
    steps: [
      {
        command:
          "schedule add eu-ai-brief daily:07:00 -- research ask -- What changed in EU AI regulation in the last 24 hours? Cite sources.",
      },
      { command: "schedule run eu-ai-brief", contains: ["next pass"] },
      {
        command: "schedule show eu-ai-brief",
        contains: ["runs so far 1"],
        untilSeconds: 300,
        everySeconds: 20,
        maxUsd: 1.5,
      },
    ],
  },
  {
    id: "compare-models",
    title: "Comparing two models on hard questions",
    needs: ["model", "network", "long"],
    steps: [
      // A fresh install has no dataset yet: fetch it (a background download),
      // then retry the run until the download has landed.
      { command: "benchmark fetch hle-verified-gold" },
      {
        command: "benchmark run hle-verified-gold model:marina/cheap --limit 10",
        contains: ["Benchmark run started"],
        untilSeconds: 600,
        everySeconds: 20,
      },
      {
        command: "benchmark runs --limit 1",
        contains: ["%"],
        excludes: ["running"],
        untilSeconds: 900,
        everySeconds: 30,
        maxUsd: 1,
      },
    ],
  },
  {
    id: "due-diligence",
    title: "An analyst team assesses a company",
    needs: ["model", "network", "long", "world"],
    world: "due-diligence",
    env: { AGENT_AUTORESPAWN: "true" },
    steps: [
      { command: "who", contains: ["DiligenceLead"], untilSeconds: 120, everySeconds: 10 },
      {
        command:
          "tell Diligence-Lead Replace the example company with Datadog (NASDAQ: DDOG). Our thesis: Datadog keeps winning mid-market observability despite open-source pressure. Split the work across market, technical and business tasks, cite public sources, and draft the memo.",
        contains: ["DiligenceLead"],
      },
      {
        command: "task list",
        contains: ["submitted"],
        untilSeconds: 1500,
        everySeconds: 60,
        maxUsd: 3,
      },
    ],
  },
];

/** The steps of a use case the in-process runner may run: no model, network, long run or other world. */
export function inProcess(useCase: PlaybookUseCase): boolean {
  return useCase.needs.length === 0 && !useCase.world;
}
