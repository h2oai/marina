// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `research ask` — a cited answer to one question for any resident, through
 * the same research code the benchmark scripts use (no new pipeline):
 *
 *   agent          the web-research agent (`runResearch`, single formation):
 *                  search, open pages, answer in markdown with a URL after each
 *                  fact; the citation audit (`auditCitedUrls`) and one repair
 *                  pass check every cited URL was actually read.
 *   retrieve       one retriever pass (`retrieverFromSpec` + `researchRetriever`
 *                  with the operator's research settings): a dated, cited
 *                  research report, facts only.
 *   evidence-loop  the retriever pass with evidence capture and a second
 *                  reviewed round (`MARINA_RESEARCH_EVIDENCE=on`, two rounds).
 *   survey         the retriever pass with the operator's imported survey
 *                  tables (`MARINA_RESEARCH_SURVEY_FILE`; refused without one).
 *   authority      the retriever pass in research-authority mode
 *                  (`MARINA_RESEARCH_AUTHORITY=on`).
 *
 * Models stay operator-set: the lead is the operator's first available model,
 * and a resident may pick only retriever entries that name no model (`search`,
 * `asof`, `corpus:`, `tavily:`, `exa:`, `closed-book`) or a model entry the
 * operator already configured (`residentRetrieverSpec`). Every model and search
 * dollar goes through `src/model` / the retriever's own spend recording; the
 * run stops at its own budget and at the daily cap.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchBrief } from "../arena/research/briefs";
import { getErrorMessage } from "../engine/errors";
import { currentEvidenceCutoff, fenceRefusal } from "../engine/evidence-fence";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { forecastRetrieverSpec } from "../forecast/retriever-default";
import { strictDateFilter } from "./isolation";
import type { ModelTurns } from "./model-turn";

export const RESEARCH_ASK_MODES = [
  "agent",
  "retrieve",
  "evidence-loop",
  "survey",
  "authority",
] as const;
export type ResearchAskMode = (typeof RESEARCH_ASK_MODES)[number];

/** A run's own budget when the caller names none, and the most it may name. */
export const RESEARCH_ASK_DEFAULT_BUDGET_USD = 1;
export const RESEARCH_ASK_MAX_BUDGET_USD = 3;
/** Model turns the web agent may take (the repair pass adds its own few). */
export const RESEARCH_ASK_MAX_TURNS = 12;
/** Longest question accepted, in characters. */
export const RESEARCH_ASK_MAX_CHARS = 4_000;
/** Most retriever entries one call may combine. */
const MAX_RETRIEVER_PARTS = 3;

/** Retriever entries that name no model: a resident may pick these freely. */
const MODEL_FREE_ENTRY =
  /^(search(:[a-z0-9+_-]+)?|asof(:[a-z0-9+_-]+)?|corpus:[\w.-]+|closed-book|tavily:(basic|advanced)|exa:(auto|neural|keyword))$/i;

export function isResearchAskMode(v: string): v is ResearchAskMode {
  return (RESEARCH_ASK_MODES as readonly string[]).includes(v);
}

/**
 * The retriever spec a resident asked for, checked against the operator's
 * configuration: `default` (or nothing) is the operator's forecast retriever;
 * model-free entries pass; an entry naming a model passes only when the
 * operator already configured exactly that entry
 * (`MARINA_FORECAST_RETRIEVER`, `MARINA_ARENA_RESEARCH_RETRIEVER`, or the
 * built-in default). Never a silent substitute: anything else is an error.
 */
export function residentRetrieverSpec(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { spec: string } | { error: string } {
  const asked = raw?.trim();
  const operator = forecastRetrieverSpec(env);
  if (!asked || asked.toLowerCase() === "default") return { spec: operator };
  const configured = new Set(
    [operator, env.MARINA_ARENA_RESEARCH_RETRIEVER ?? ""]
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const parts = asked
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { spec: operator };
  if (parts.length > MAX_RETRIEVER_PARTS) {
    return { error: `retriever: combine at most ${MAX_RETRIEVER_PARTS} entries` };
  }
  for (const part of parts) {
    if (MODEL_FREE_ENTRY.test(part) || configured.has(part)) continue;
    return {
      error: `retriever: "${part}" is not available to residents — use default, search[:<backends>], asof[:<providers>], corpus:<name>, tavily:basic|advanced, exa:auto|neural|keyword, closed-book, or an entry the operator configured (${[...configured].join(", ") || "none"})`,
    };
  }
  return { spec: parts.join(",") };
}

/**
 * The environment a research mode runs under (operator settings plus the
 * mode's switch). `survey` needs the operator's survey tables.
 */
export function researchModeEnv(
  mode: ResearchAskMode,
  env: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv } | { error: string } {
  switch (mode) {
    case "agent":
    case "retrieve":
      return { env };
    case "evidence-loop": {
      const rounds = Number(env.MARINA_RESEARCH_LOOP_ROUNDS ?? 1);
      return {
        env: {
          ...env,
          MARINA_RESEARCH_EVIDENCE: "on",
          MARINA_RESEARCH_LOOP_ROUNDS: String(
            Number.isSafeInteger(rounds) && rounds > 1 ? rounds : 2,
          ),
        },
      };
    }
    case "survey":
      if (!env.MARINA_RESEARCH_SURVEY_FILE?.trim()) {
        return {
          error:
            "survey mode reads the operator's imported survey tables, and none are configured (MARINA_RESEARCH_SURVEY_FILE)",
        };
      }
      return { env };
    case "authority":
      return { env: { ...env, MARINA_RESEARCH_AUTHORITY: "on" } };
  }
}

export interface ResearchAskRequest {
  question: string;
  mode: ResearchAskMode;
  /** A resident-chosen retriever (validated by `residentRetrieverSpec`). */
  retriever?: string;
  /** Survey mode: the measure the survey tables are keyed by. */
  measure?: string;
  budgetUsd?: number;
}

export interface ResearchAskAnswer {
  mode: ResearchAskMode;
  /** The cited answer (agent) or the cited research report (retriever modes). */
  text: string;
  sources: string[];
  costUsd: number;
  /** One line on what the check found (citation audit, verified lines, warnings). */
  check: string;
  retriever?: string;
  budgetForced?: boolean;
}

export interface ResearchAskDeps {
  env?: NodeJS.ProcessEnv;
  /** The lead model id (default: the operator's first available model). */
  lead?: () => string | undefined;
  /** Tests: replace the web agent run. */
  runAgent?: (
    question: string,
    lead: string,
    o: { env: NodeJS.ProcessEnv; budgetUsd: number },
  ) => Promise<ResearchAskAnswer>;
  /** Tests: replace the retriever. */
  retrieve?: (
    brief: ResearchBrief,
    spec: string,
    o: { env: NodeJS.ProcessEnv; reviewer?: string },
  ) => Promise<{
    report: string;
    sources: Array<{ url: string }>;
    costUsd: number;
    warnings?: string[];
  }>;
  now?: () => Date;
}

class BudgetExhausted extends Error {
  override name = "BudgetExhausted";
}

async function defaultLead(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { availableModels } = await import("../agent/available-models");
  return availableModels(env)[0]?.spec;
}

/** The web agent over the configured search backends; one throwaway provenance cache. */
async function runAgentDefault(
  question: string,
  lead: string,
  o: { env: NodeJS.ProcessEnv; budgetUsd: number },
): Promise<ResearchAskAnswer> {
  const [{ modelTurns }, { ProvenanceCache }, { researchEnvironment, runResearch }] =
    await Promise.all([
      import("../model/turns"),
      import("./provenance-cache"),
      import("./web-agent"),
    ]);
  const dir = mkdtempSync(join(tmpdir(), "marina-research-ask-"));
  let spent = 0;
  const add = (usd: number) => {
    if (Number.isFinite(usd) && usd > 0) spent += usd;
  };
  try {
    const cache = new ProvenanceCache(dir);
    const env = researchEnvironment({ cache, env: o.env, onSearchSpend: add });
    const turns: ModelTurns = modelTurns(lead, o.env, {
      purpose: "research",
      trace: { caller: "research.ask" },
      onCost: add,
    });
    const result = await runResearch({
      task: question,
      env,
      lead: turns,
      formation: { kind: "single" },
      maxTurns: RESEARCH_ASK_MAX_TURNS,
      beforeTurn: () => {
        const capped = dailyCapRefusal(o.env);
        if (capped) throw new BudgetExhausted(capped);
        if (spent >= o.budgetUsd) {
          throw new BudgetExhausted(`research budget $${o.budgetUsd.toFixed(2)} reached`);
        }
      },
    });
    const a = result.audit;
    return {
      mode: "agent",
      text: result.answer,
      sources: a.read,
      costUsd: spent,
      check: `citations: ${a.read.length} read, ${a.unread.length} never opened, ${a.failed.length} failed of ${a.cited} cited${result.repaired ? " · repaired once" : ""}`,
      ...(result.budgetForced ? { budgetForced: true } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function retrieveDefault(
  brief: ResearchBrief,
  spec: string,
  o: { env: NodeJS.ProcessEnv; reviewer?: string },
) {
  const [{ retrieverFromSpec }, { researchRetriever }] = await Promise.all([
    import("./retrieve"),
    import("./retriever"),
  ]);
  const env = o.env;
  const base = retrieverFromSpec(
    spec,
    {
      ...(env.OPENROUTER_API_KEY?.trim() ? { openrouter: env.OPENROUTER_API_KEY.trim() } : {}),
      ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
      ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
    },
    { env },
  );
  return researchRetriever(base, env, o.reviewer)(brief);
}

/** Answer one research question (see the module comment). Never throws: failures come back as `{ error }`. */
export async function researchAsk(
  req: ResearchAskRequest,
  deps: ResearchAskDeps = {},
): Promise<ResearchAskAnswer | { error: string }> {
  const base = deps.env ?? process.env;
  const question = req.question.trim();
  if (!question) return { error: "no question given" };
  if (question.length > RESEARCH_ASK_MAX_CHARS) {
    return { error: `the question is over ${RESEARCH_ASK_MAX_CHARS} characters` };
  }
  const moded = researchModeEnv(req.mode, base);
  if ("error" in moded) return moded;
  const capped = dailyCapRefusal(base);
  if (capped) return { error: capped };
  const budgetUsd = Math.min(
    req.budgetUsd ?? RESEARCH_ASK_DEFAULT_BUDGET_USD,
    RESEARCH_ASK_MAX_BUDGET_USD,
  );
  // The as-of fence (src/engine/evidence-fence.ts): under a cutoff the web
  // agent (it reads the live web) is refused, and the retriever modes run on
  // the keyless date-strict `asof` retriever, bounded at the cutoff, behind the
  // strict pre-cutoff report filter.
  const fence = currentEvidenceCutoff();
  if (fence && req.mode === "agent") {
    return {
      error: `${fenceRefusal("research ask mode:agent", Date.parse(fence))} Use mode:retrieve (date-strict at the cutoff).`,
    };
  }
  if (fence && req.retriever && !/^asof(:|$)/.test(req.retriever.trim())) {
    return {
      error: `${fenceRefusal(`research ask retriever:${req.retriever.trim()}`, Date.parse(fence))} Only retriever:asof[:<providers>] is date-strict.`,
    };
  }
  const lead = deps.lead ? deps.lead() : await defaultLead(base);
  try {
    if (req.mode === "agent") {
      if (req.retriever) {
        return {
          error:
            "retriever: applies to the retriever modes (retrieve, evidence-loop, survey, authority); the agent searches the configured backends",
        };
      }
      if (!lead) return { error: "no model is available to run the research agent" };
      return await (deps.runAgent ?? runAgentDefault)(question, lead, {
        env: moded.env,
        budgetUsd,
      });
    }
    const picked = fence
      ? { spec: req.retriever?.trim() || "asof" }
      : residentRetrieverSpec(req.retriever, base);
    if ("error" in picked) return picked;
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const brief: ResearchBrief = {
      roundId: "research-ask",
      since: "1900-01-01",
      request: question,
      ...(req.measure ? { target: { measure: req.measure } } : {}),
      ...(fence
        ? { untilAt: fence, until: fence.slice(0, 10) }
        : { untilAt: `${today}T23:59:59Z` }),
    };
    const retrieve = (b: ResearchBrief) =>
      (deps.retrieve ?? retrieveDefault)(b, picked.spec, {
        env: moded.env,
        ...(lead ? { reviewer: lead } : {}),
      });
    const got = fence
      ? await strictDateFilter(retrieve as Parameters<typeof strictDateFilter>[0])(brief)
      : await retrieve(brief);
    return {
      mode: req.mode,
      text: got.report,
      sources: got.sources.map((s) => s.url),
      costUsd: got.costUsd,
      retriever: picked.spec,
      check: `${got.sources.length} source(s)${got.warnings?.length ? ` · warnings: ${got.warnings.slice(0, 2).join("; ")}` : ""}`,
    };
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
}
