// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Typed ANALYSIS tools — Marina's general pipelines as typed, deferred agent
// tools: forecast, research (web agent or a research mode), the read swarm,
// quant, calc, data lookups, decision check, triage, the Arbiter and text
// patterns. Each builds ONE world command (`../analysis-commands`, shared with
// the tool policy) and runs it through `execCommand`, so the command's rank,
// safety gates, rate limits, spend caps, audit and any command-scope fence
// apply exactly as if typed through `marina_command`. They are not in the
// resident core set: in the `full` profile they load by name through
// `marina_tool_search`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  arbiterToolCommand,
  calcToolCommand,
  DATA_TOOL_SOURCES,
  dataToolCommand,
  decisionCheckToolCommand,
  forecastToolCommand,
  patternToolCommand,
  quantToolCommand,
  researchToolCommand,
  swarmToolCommand,
  triageToolCommand,
} from "../analysis-commands";
import { type ToolContext, wrap } from "./shared";

const lit = <T extends string>(values: readonly T[], description: string) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    { description },
  );

const ANSWER_TYPES = ["choice", "multi", "number", "ranking", "text"] as const;

const answerFields = {
  type: Type.Optional(
    lit(ANSWER_TYPES, "Typed answer: choice (one option), multi (several), number, ranking, text."),
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Option ids for choice/multi (2+), or ranking candidates; no spaces in an id.",
    }),
  ),
  size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Ranking length." })),
  ends: Type.Optional(Type.String({ description: "When the question closes (ISO time)." })),
};

const forecastSchema = Type.Object({
  action: Type.Optional(
    lit(["ask", "list", "competence"], "ask (default), list your saved forecasts, competence map."),
  ),
  question: Type.Optional(Type.String({ description: "The question to forecast (for ask)." })),
  ...answerFields,
  resolves: Type.Optional(
    Type.String({ description: "Resolver Sample <venue>/<ticker> that scores this forecast." }),
  ),
  formation: Type.Optional(
    Type.String({
      description:
        "Formation: ensemble, delphi, tournament, skeptic, verify (checks each run) or arbiter (adjudicates when runs disagree). Default: the operator's.",
    }),
  ),
  retriever: Type.Optional(
    Type.String({
      description:
        "Research retriever: default, search[:<backends>], asof[:<providers>], corpus:<name>, or an entry the operator configured.",
    }),
  ),
  family: Type.Optional(Type.String({ description: "Family prefix (for competence)." })),
});

const researchSchema = Type.Object({
  question: Type.String({ description: "What to find out; the answer cites a URL per fact." }),
  mode: Type.Optional(
    lit(
      ["agent", "retrieve", "evidence-loop", "survey", "authority"],
      "agent (default): web-research agent + citation audit; retrieve: one cited retriever report; evidence-loop: two reviewed rounds; survey: operator survey tables; authority: favour the resolving publisher.",
    ),
  ),
  retriever: Type.Optional(
    Type.String({
      description:
        "Retriever for the non-agent modes: default, search[:<backends>], asof[:<providers>], corpus:<name>, or an operator-configured entry.",
    }),
  ),
  measure: Type.Optional(Type.String({ description: "Survey mode: the measure to match." })),
  budgetUsd: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, maximum: 3, description: "This run's budget (default 1)." }),
  ),
});

const swarmSchema = Type.Object({
  question: Type.String({
    description: "A focused question; readers read the best pages in full.",
  }),
  engines: Type.Optional(
    Type.Array(Type.String(), {
      description: "Search engines (as for web search), or corpus:<name>.",
    }),
  ),
  docs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 60, description: "Pages to read (16)." }),
  ),
});

const quantSchema = Type.Object({
  action: lit(["fit", "buckets"], "fit a series to a horizon, or bucket a distribution."),
  values: Type.Optional(
    Type.Array(Type.Union([Type.Number(), Type.String()]), {
      description: "fit: values oldest first — numbers, or date=value strings (all dated or none).",
    }),
  ),
  steps: Type.Optional(Type.Integer({ minimum: 1, description: "fit: releases ahead." })),
  to: Type.Optional(Type.String({ description: "fit: target date instead of steps." })),
  method: Type.Optional(
    lit(
      ["auto", "persistence", "ewma", "blend", "trend", "damped", "combo"],
      "fit method (auto picks by rolling-origin error).",
    ),
  ),
  mean: Type.Optional(Type.Number({ description: "buckets: normal mean." })),
  sd: Type.Optional(Type.Number({ minimum: 0, description: "buckets: normal sd." })),
  quantiles: Type.Optional(
    Type.Array(
      Type.Object({ level: Type.Number({ minimum: 0, maximum: 1 }), value: Type.Number() }),
      { description: "buckets: quantiles instead of mean/sd." },
    ),
  ),
  cuts: Type.Optional(
    Type.Array(Type.Number(), { description: "buckets: thresholds instead of buckets text." }),
  ),
  buckets: Type.Optional(
    Type.String({ description: 'Ranges, comma-separated: "<10, 10-20, >=20" (labels "A: <10").' }),
  ),
});

const calcSchema = Type.Object({
  expression: Type.String({ description: "Arithmetic or short statements, e.g. 0.3*1.2 + 4." }),
});

const dataSchema = Type.Object({
  source: lit(
    DATA_TOOL_SOURCES,
    "markets (Polymarket/Kalshi), odds (sports), series (FRED/BLS), polls (VoteHub), crowd (Manifold), sources.",
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Search phrase; odds: <sport_key> [teams]; series: id or phrase; polls: the subject (e.g. Donald Trump, 2026).",
    }),
  ),
  pollType: Type.Optional(lit(["approval", "generic-ballot"], "polls: which poll quantity.")),
  exclude: Type.Optional(Type.Array(Type.String(), { description: "polls: pollsters to drop." })),
  asOf: Type.Optional(Type.String({ description: "Read as of this past date (YYYY-MM-DD)." })),
});

const decisionCheckSchema = Type.Object({
  draft: Type.String({ description: "Your draft answer or action to score before using it." }),
  request: Type.Optional(Type.String({ description: "What was asked (improves the check)." })),
});

const triageSchema = Type.Object({
  question: Type.String({ description: "A question or task to classify." }),
  ...answerFields,
  resolves: Type.Optional(Type.String({ description: "When it resolves (ISO time)." })),
  asOf: Type.Optional(Type.String({ description: "Classify as of this instant (ISO)." })),
});

const arbiterSchema = Type.Object({
  action: lit(
    ["contested", "check", "policy"],
    "contested: do these answers disagree enough to adjudicate? check: apply the overrule bar to a verdict; policy: the settings.",
  ),
  type: Type.Optional(lit(ANSWER_TYPES, "Answer type of the answers.")),
  answers: Type.Optional(
    Type.Array(Type.String(), { description: "contested: the answers (2+)." }),
  ),
  verdict: Type.Optional(Type.String({ description: "check: the Arbiter's JSON verdict." })),
  majority: Type.Optional(Type.String({ description: "check: the majority answer." })),
  agreement: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1, description: "check: run agreement 0-1." }),
  ),
});

const patternSchema = Type.Object({
  action: Type.Optional(lit(["run", "list"], "run (default) or list the patterns.")),
  pattern: Type.Optional(
    Type.String({
      description:
        "ensemble, debate, delphi, tournament, verification, deliberation, chorus or pipeline.",
    }),
  ),
  task: Type.Optional(Type.String({ description: "The task the panel answers (for run)." })),
  budgetUsd: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, maximum: 2, description: "This run's budget (0.5)." }),
  ),
});

export function createAnalysisTools(ctx: ToolContext): AgentTool[] {
  return [
    wrap(
      "marina_forecast",
      "Forecast",
      "Forecast any question with cited, checked evidence and several models (the `forecast` command; costs money). Typed answers, optional formation and retriever.",
      forecastSchema,
      forecastToolCommand,
      ctx,
    ),
    wrap(
      "marina_research",
      "Research",
      "Get a cited answer: the web-research agent with a citation audit, or one retriever pass in a research mode (evidence-loop, survey, authority). Costs money.",
      researchSchema,
      researchToolCommand,
      ctx,
    ),
    wrap(
      "marina_swarm",
      "Read Swarm",
      "Read swarm (`web swarm`): split a question into clues, read the best pages in full, return candidates with verbatim-verified quotes.",
      swarmSchema,
      swarmToolCommand,
      ctx,
    ),
    wrap(
      "marina_quant",
      "Quant",
      "Numeric helpers, no model call: fit a series to a horizon (mean, sd, quantiles) or turn a distribution into bucket probabilities.",
      quantSchema,
      quantToolCommand,
      ctx,
    ),
    wrap(
      "marina_calc",
      "Calc",
      "Exact arithmetic and short statements (the `calc` command), no model call.",
      calcSchema,
      calcToolCommand,
      ctx,
    ),
    wrap(
      "marina_data",
      "Data",
      "Structured data lookups: market prices, sports odds, official series, polls and crowd forecasts, with an as-of date.",
      dataSchema,
      dataToolCommand,
      ctx,
    ),
    wrap(
      "marina_decision_check",
      "Decision Check",
      "Score your own draft before you use it (`decision check`); advisory only, cited note/task ids become evidence.",
      decisionCheckSchema,
      decisionCheckToolCommand,
      ctx,
    ),
    wrap(
      "marina_triage",
      "Triage",
      "Classify a question as lookup, anchor, list or forecast before answering it (`triage`), no model call.",
      triageSchema,
      triageToolCommand,
      ctx,
    ),
    wrap(
      "marina_arbiter",
      "Arbiter",
      "The Arbiter's rules (`arbiter`): whether answers are contested, and whether a verdict clears the overrule bar.",
      arbiterSchema,
      arbiterToolCommand,
      ctx,
    ),
    wrap(
      "marina_pattern",
      "Pattern",
      "Run one task under an orchestration pattern (debate, delphi, tournament, …) over the operator's models (`pattern run`); costs money.",
      patternSchema,
      patternToolCommand,
      ctx,
    ),
  ];
}
