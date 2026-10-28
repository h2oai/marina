// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `research ask [mode:<m>] [retriever:<spec>] [measure:<m>] [budget:<usd>] -- <question>`
 * — a cited answer for any resident (`src/research/ask.ts`). `research <goal>`
 * without `ask` still launches a research project.
 *
 * Rank 0 like `forecast`: the guards are spend guards — the daily cap up
 * front and before every agent turn, a per-run budget, a per-entity token
 * bucket and one run per entity at a time.
 */

import { RateLimiter } from "../../auth/rate-limiter";
import { dim, header, separator } from "../../net/ansi";
import {
  isResearchAskMode,
  RESEARCH_ASK_MAX_BUDGET_USD,
  RESEARCH_ASK_MODES,
  type ResearchAskAnswer,
  type ResearchAskDeps,
  researchAsk,
  researchModeEnv,
  residentRetrieverSpec,
} from "../../research/ask";
import type { CommandInput, EntityId, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { parseModifiers, splitOnTerminator } from "../parse-input";

export const RESEARCH_ASK_SYNTAX =
  "research ask [mode:agent|retrieve|evidence-loop|survey|authority] [retriever:<spec>] [measure:<m>] [budget:<usd>] -- <question>";
export const RESEARCH_ASK_USAGE = `Usage: ${RESEARCH_ASK_SYNTAX}\n       modes: ${RESEARCH_ASK_MODES.join(", ")} (default agent: the web-research agent with a citation audit)`;

/** Longest answer text shown (the full answer is cited; the tail is clipped). */
const SHOWN_CHARS = 6_000;

export function renderResearchAnswer(a: ResearchAskAnswer): string {
  const text = a.text.length > SHOWN_CHARS ? `${a.text.slice(0, SHOWN_CHARS)}\n…` : a.text;
  return [
    header(`Research (${a.mode}${a.retriever ? ` · ${a.retriever}` : ""})`),
    separator(),
    text || "(no answer)",
    "",
    dim(a.check),
    ...(a.budgetForced
      ? [dim("budget reached: the answer was forced before research finished")]
      : []),
    ...a.sources.slice(0, 8).map((u) => dim(`  - ${u}`)),
    dim(`cost $${a.costUsd.toFixed(4)}`),
  ].join("\n");
}

/** The `research ask` handler, with its own budget state per registration. */
export function researchAskHandler(
  deps: ResearchAskDeps & {
    /** Called with each finished answer (e.g. to record it on the outcome path); never fails the ask. */
    onAnswer?: (answer: ResearchAskAnswer, entity: EntityId) => void;
  } = {},
) {
  const limiter = new RateLimiter({ maxTokens: 4, refillRate: 1, refillInterval: 10 * 60_000 });
  const running = new Set<string>();
  return (ctx: RoomContext, input: CommandInput): Promise<void> | void => {
    const eid = input.entity as EntityId;
    const args = input.args.replace(/^\s*ask\b/i, "");
    const [head, after] = splitOnTerminator(args);
    const words = head.split(/\s+/).filter(Boolean);
    const spec = {
      mode: { type: "string" as const },
      retriever: { type: "string" as const, aliases: ["engine"] },
      measure: { type: "string" as const },
      budget: { type: "number" as const },
    };
    const mods = parseModifiers(words, spec, after === undefined ? { leading: true } : {});
    const question = (after ?? mods.rest.join(" ")).trim();
    if (mods.errors.length || !question) {
      ctx.send(
        eid,
        `${mods.errors.length ? `${mods.errors.join("; ")}\n` : ""}${RESEARCH_ASK_USAGE}`,
      );
      return;
    }
    const mode = String(mods.values.mode ?? "agent").toLowerCase();
    if (!isResearchAskMode(mode)) {
      ctx.send(eid, `mode: takes one of ${RESEARCH_ASK_MODES.join(", ")}.`);
      return;
    }
    const budget = mods.values.budget as number | undefined;
    if (budget !== undefined && (!(budget > 0) || budget > RESEARCH_ASK_MAX_BUDGET_USD)) {
      ctx.send(eid, `budget: takes USD greater than 0 and at most ${RESEARCH_ASK_MAX_BUDGET_USD}.`);
      return;
    }
    // What the operator does not allow is refused before the budget is touched.
    const base = deps.env ?? process.env;
    const moded = researchModeEnv(mode, base);
    const picked =
      mode !== "agent" && typeof mods.values.retriever === "string"
        ? residentRetrieverSpec(mods.values.retriever, base)
        : undefined;
    const refused =
      "error" in moded ? moded.error : picked && "error" in picked ? picked.error : undefined;
    if (refused) {
      refuseCommand(ctx, eid, `Could not research: ${refused}`);
      return;
    }
    if (running.has(eid)) {
      ctx.send(eid, "A research run of yours is still going; wait for its answer.");
      return;
    }
    if (!limiter.consume(eid)) {
      ctx.send(eid, "Research budget used up for now — try again in a few minutes.");
      return;
    }
    running.add(eid);
    ctx.send(eid, dim(`Researching (${mode})… (~30–120 s)`));
    return (async () => {
      try {
        const got = await researchAsk(
          {
            question,
            mode,
            ...(typeof mods.values.retriever === "string"
              ? { retriever: mods.values.retriever }
              : {}),
            ...(typeof mods.values.measure === "string" ? { measure: mods.values.measure } : {}),
            ...(budget !== undefined ? { budgetUsd: budget } : {}),
          },
          deps,
        );
        ctx.send(
          eid,
          "error" in got ? `Could not research: ${got.error}` : renderResearchAnswer(got),
        );
        if (!("error" in got)) {
          try {
            deps.onAnswer?.(got, eid);
          } catch {
            // allow-empty-catch: recording an answer never fails the ask
          }
        }
      } finally {
        running.delete(eid);
      }
    })();
  };
}
