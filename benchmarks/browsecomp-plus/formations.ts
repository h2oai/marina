// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-agent research formations over the official tool loop. Each formation
 * is a team of researcher agents (the same `search` / `get_document` tools,
 * each its own conversation through Marina's `/v1`) plus a lead that weighs
 * their reports and answers in the official format, with tools of its own to
 * check claims. Every agent's steps land in one run record, so recall and
 * search calls count the whole team and cost is the team's.
 *
 *   single            one agent (the official loop)
 *   ensemble:N        N independent researchers → lead adjudicates
 *   mapreduce:N       lead plans N complementary angles (map) → N researchers
 *                     each pursue one → lead reduces
 *   sharding:N        N researchers, each searching one hash shard of the corpus
 *                     (together they read N× deeper into the ranking) → lead
 *   blackboard:NxR    N researchers over R rounds; between rounds each sees the
 *                     team's posted findings → lead
 *
 * The researcher model is the arm's `--model` (a passthru id or a
 * `marina/verify:` id, so verification composes with any formation); the lead
 * can be another model (`--lead-model`).
 */

import { BudgetExhausted } from "../call-spend-guard";
import { mostAgreedDraft } from "../../src/agent/budget-terminal";
import {
  type AgentOptions,
  type ChatEndpoint,
  type ChatMessage,
  emptyRun,
  failRun,
  finishRun,
  type QueryRun,
  toolLoop,
} from "./agent";
import { QUERY_TEMPLATE, queryPrompt } from "./official";

export type FormationKind = "single" | "ensemble" | "mapreduce" | "sharding" | "blackboard";

export interface FormationSpec {
  kind: FormationKind;
  /** Researchers (1 for single). */
  agents: number;
  /** Blackboard rounds. */
  rounds: number;
}

/** `single`, `ensemble:4`, `mapreduce:4`, `sharding:4`, `blackboard:4x2`. */
export function parseFormation(raw: string): FormationSpec {
  const m = /^(single|ensemble|mapreduce|sharding|blackboard)(?::(\d+)(?:x(\d+))?)?$/.exec(
    raw.trim(),
  );
  if (!m)
    throw new Error(
      `unknown formation "${raw}" (single | ensemble:N | mapreduce:N | sharding:N | blackboard:NxR)`,
    );
  const kind = m[1] as FormationKind;
  if (kind === "single") return { kind, agents: 1, rounds: 1 };
  const agents = Number(m[2] ?? 4);
  const rounds = kind === "blackboard" ? Number(m[3] ?? 2) : 1;
  if (agents < 2 || agents > 16) throw new Error("a formation needs 2–16 researchers");
  if (rounds < 1 || rounds > 4) throw new Error("blackboard rounds must be 1–4");
  return { kind, agents, rounds };
}

export function formationLabel(spec: FormationSpec): string {
  if (spec.kind === "single") return "single";
  return spec.kind === "blackboard"
    ? `blackboard:${spec.agents}x${spec.rounds}`
    : `${spec.kind}:${spec.agents}`;
}

export interface FormationOptions {
  /** Researcher model. */
  model: string;
  /** Lead model (planner and final answer); defaults to the researcher model. */
  leadModel?: string;
  /** The lead's own tool turns when checking reports before answering. */
  leadTurns: number;
}

const FORMAT = QUERY_TEMPLATE.slice(QUERY_TEMPLATE.indexOf("Your response should be"));

/** Researcher reports, each clipped so the lead's prompt stays bounded. */
function reportsBlock(reports: string[], clip = 3000): string {
  return reports
    .map((r, i) => `[Researcher ${i + 1}]\n${r.length > clip ? `${r.slice(0, clip)}…` : r}`)
    .join("\n\n");
}

export function leadPrompt(question: string, reports: string[]): string {
  return [
    "You lead a research team answering a hard question from a fixed document collection, using the search and get_document tools provided. Your researchers worked in parallel; their reports are below. Weigh the evidence they cite. Where reports disagree, or a claim matters and looks weak, check it yourself with the tools before answering. Do not trust a report without evidence.",
    "",
    `Question: ${question}`,
    "",
    "Researcher reports:",
    reportsBlock(reports.length ? reports : ["(no researcher produced a report)"]),
    "",
    FORMAT,
  ].join("\n");
}

export function plannerPrompt(question: string, n: number): string {
  return [
    `You plan a research team of ${n} researchers who will each search a fixed document collection for the answer to the question below. Split the work into ${n} complementary angles: each angle names which clues of the question to pursue first and what kind of document would confirm them. Together the angles should cover every clue.`,
    "",
    `Question: ${question}`,
    "",
    `Reply with ONLY a JSON array of ${n} strings, one angle each.`,
  ].join("\n");
}

/** The planner's angles; falls back to "start from clue i" when the reply is not a JSON array. */
export function parseAngles(text: string, n: number): string[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (m) {
    try {
      const arr = JSON.parse(m[0]) as unknown;
      if (Array.isArray(arr)) {
        const angles = arr.filter((a): a is string => typeof a === "string" && a.trim() !== "");
        if (angles.length > 0) {
          return Array.from({ length: n }, (_, i) => angles[i % angles.length]!.trim());
        }
      }
    } catch {
      // allow-empty-catch: an unparseable plan falls back to generic angles below
    }
  }
  return Array.from(
    { length: n },
    (_, i) =>
      `Start from the question's clue number ${i + 1} (counting clauses in order), then follow where it leads.`,
  );
}

function researcherPrompt(question: string, note?: string): string {
  return note ? `${queryPrompt(question)}\n\n${note}` : queryPrompt(question);
}

async function researchers(
  ep: ChatEndpoint,
  run: QueryRun,
  question: string,
  opts: AgentOptions,
  fo: FormationOptions,
  notes: (string | undefined)[],
  sharded: boolean,
): Promise<string[]> {
  const outs = await Promise.all(
    notes.map((note, i) =>
      toolLoop(
        ep,
        fo.model,
        [{ role: "user", content: researcherPrompt(question, note) }],
        opts,
        run,
        {
          agent: `researcher-${i + 1}`,
          ...(sharded ? { shard: { index: i, of: notes.length } } : {}),
        },
      ).catch((e: unknown) => {
        // A budget stop ends the whole query; any other failure is one researcher's.
        if (e instanceof BudgetExhausted) throw e;
        return {
          text: `(researcher failed: ${e instanceof Error ? e.message : String(e)})`,
          messages: [],
        };
      }),
    ),
  );
  return outs.map((o) => o.text ?? "(no answer before the turn limit)");
}

async function blackboard(
  ep: ChatEndpoint,
  run: QueryRun,
  question: string,
  opts: AgentOptions,
  fo: FormationOptions,
  spec: FormationSpec,
): Promise<string[]> {
  const perRound = Math.max(2, Math.floor(opts.maxTurns / spec.rounds));
  const convs: ChatMessage[][] = Array.from({ length: spec.agents }, () => [
    {
      role: "user",
      content: researcherPrompt(
        question,
        `You are one of ${spec.agents} researchers sharing a blackboard. After each round your answer is posted for the others and theirs for you.`,
      ),
    },
  ]);
  let posts: string[] = Array.from({ length: spec.agents }, () => "(nothing yet)");
  for (let round = 1; round <= spec.rounds; round++) {
    if (round > 1) {
      const board = posts.map((p, i) => `[Researcher ${i + 1}] ${p.slice(0, 1500)}`).join("\n\n");
      for (const conv of convs) {
        conv.push({
          role: "user",
          content: `Blackboard after round ${round - 1} (your teammates' current answers and evidence):\n\n${board}\n\nContinue researching: confirm, refute or improve the leading candidates, citing docids. Then answer again in the required format.`,
        });
      }
    }
    const outs = await Promise.all(
      convs.map((conv, i) =>
        toolLoop(ep, fo.model, conv, opts, run, {
          agent: `researcher-${i + 1}`,
          maxTurns: perRound,
        }).catch((e: unknown) => {
          if (e instanceof BudgetExhausted) throw e;
          return { messages: conv } as { text?: string; messages: ChatMessage[] };
        }),
      ),
    );
    posts = outs.map((o, i) => o.text ?? posts[i] ?? "(nothing yet)");
  }
  return posts;
}

/** Run one query through a formation; `single` is the official loop itself. */
export async function runFormation(
  ep: ChatEndpoint,
  spec: FormationSpec,
  queryId: string,
  question: string,
  opts: AgentOptions,
  fo: FormationOptions,
): Promise<QueryRun> {
  const started = Date.now();
  const lead = fo.leadModel ?? fo.model;
  const run = emptyRun(fo.model, queryId, {
    shape: "formation",
    formation: formationLabel(spec),
    lead_model: lead,
    corpus: opts.corpus,
    k: opts.k,
    snippet_chars: opts.snippetChars,
    doc_chars: opts.docChars,
    max_turns: opts.maxTurns,
    lead_turns: fo.leadTurns,
    ...(opts.finalAnswer ? { final_answer: true } : {}),
  });
  try {
    if (spec.kind === "single") {
      const out = await toolLoop(
        ep,
        fo.model,
        [{ role: "user", content: queryPrompt(question) }],
        opts,
        run,
      );
      run.record.status = out.text ? "completed" : "incomplete";
      if (out.budgetForced) run.budgetForced = out.budgetForced;
      return finishRun(run, started);
    }
    let reports: string[];
    if (spec.kind === "ensemble") {
      reports = await researchers(
        ep,
        run,
        question,
        opts,
        fo,
        Array(spec.agents).fill(undefined),
        false,
      );
    } else if (spec.kind === "sharding") {
      const notes = Array.from(
        { length: spec.agents },
        (_, i) =>
          `You are researcher ${i + 1} of ${spec.agents}. Your search tool covers only shard ${i + 1} of ${spec.agents} of the collection; teammates search the other shards. get_document can read any docid. Report your best candidate with the evidence you found, even if uncertain.`,
      );
      reports = await researchers(ep, run, question, opts, fo, notes, true);
    } else if (spec.kind === "mapreduce") {
      const plan = await toolLoop(
        ep,
        lead,
        [{ role: "user", content: plannerPrompt(question, spec.agents) }],
        opts,
        run,
        { agent: "lead-planner", maxTurns: 1, tools: false },
      );
      const angles = parseAngles(plan.text ?? "", spec.agents);
      const notes = angles.map(
        (a, i) =>
          `You are researcher ${i + 1} of ${spec.agents}, working in parallel. Your assigned angle: ${a}\nStart from that angle but answer the whole question. Report your best candidate with the evidence you found, even if uncertain.`,
      );
      reports = await researchers(ep, run, question, opts, fo, notes, false);
    } else {
      reports = await blackboard(ep, run, question, opts, fo, spec);
    }
    const final = await toolLoop(
      ep,
      lead,
      [{ role: "user", content: leadPrompt(question, reports) }],
      opts,
      run,
      { agent: "lead", maxTurns: fo.leadTurns },
    );
    if (final.budgetForced) run.budgetForced = final.budgetForced;
    if (!final.text && opts.finalAnswer) {
      // Budget-terminal: the lead produced nothing, so the team's most-agreed
      // report is the answer — labelled, never passed off as the lead's.
      const best = mostAgreedDraft(
        reports.filter((r) => !/^\((researcher failed|no answer)/.test(r)),
      );
      if (best) {
        run.record.result.push({
          type: "output_text",
          tool_name: null,
          arguments: null,
          output: best.text,
          agent: "team-plurality",
        });
        run.budgetForced = {
          reason: "turns",
          used: fo.leadTurns,
          cap: fo.leadTurns,
          source: "member-plurality",
        };
        run.record.status = "completed";
        return finishRun(run, started);
      }
    }
    run.record.status = final.text ? "completed" : "incomplete";
  } catch (e) {
    failRun(run, e);
  }
  return finishRun(run, started);
}
