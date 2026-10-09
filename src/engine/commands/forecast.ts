// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../auth/rate-limiter";
import type { AnswerSpec } from "../../forecast/answer-types";
import type { ForecastAnswer } from "../../forecast/question";
import type { ForecastScale } from "../../forecast/service";
import type { TypedForecastAnswer } from "../../forecast/typed";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { ForecastAnswerRow } from "../../persistence/db-markets";
import type { MarinaStores } from "../../persistence/interfaces";
import { parseSampleId } from "../../resolvers/calibration";
import type { CommandDef, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { parseModifiers } from "../parse-input";
import { dailyCapRefusal } from "../spend-ledger";

const logger = new Logger();

const USAGE = [
  "Usage: forecast <question> [resolves:<venue>/<ticker>]   e.g. forecast Will the Fed cut rates in October 2026?",
  "       forecast <question> type:choice|multi|number|ranking|text [options:A,B,C] [size:N] [ends:<ISO time>]",
  "                                         a typed answer: plan → research rounds → several runs → critique",
  "       forecast list                     your saved forecasts and, once resolved, their scores",
  "       forecast track <id> <venue>/<ticker>   score forecast #id when that market/watch resolves",
].join("\n");
/** Each forecast spends real money (web research + several models): a small per-entity budget. */
const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, refillInterval: 12 * 60_000 });

export interface ForecastCommandDeps {
  /** Persistence for the answer record (optional: without it, forecasts are not saved). */
  readonly db?: Pick<
    MarinaStores,
    "saveForecastAnswer" | "linkForecastToSample" | "listForecastAnswers"
  >;
  getEntity?: (id: string) => { name: string } | undefined;
  /** The world database, for the lesson pool typed forecasts recall (none: no lessons). */
  readonly lessonsDb?: MarinaDB;
}

/**
 * `forecast <question>` — a calibrated, evidence-backed answer to any question:
 * web research with cited sources, figures checked against those sources, one
 * analyst per model vendor, a judge that weights them by how well the evidence
 * supports them (src/forecast). Rank 0: any entity may ask; the budget caps spend.
 *
 * Every answer is saved (`forecast_answers`, migration 145) with its full audit
 * trail. Linked to a resolver Sample id (`resolves:` or `forecast track`), it is
 * scored by the `forecast-question` calibration finder when that Sample resolves.
 */
export function forecastCommand(deps: ForecastCommandDeps = {}): CommandDef {
  return {
    category: "Markets & Forecasting",
    usage: [
      "forecast <question> [resolves:<venue>/<ticker>]",
      "forecast <question> type:<choice|multi|number|ranking|text> [options:<id,id,…>] [size:<n>] [ends:<iso>]",
      "forecast list",
      "forecast track <id> <venue>/<ticker>",
    ],
    name: "forecast",
    aliases: ["predict"],
    help: `Forecast any question with cited, verified evidence and several models.\n${USAGE}`,
    minRank: 0,
    handler: (ctx: RoomContext, input) => {
      const args = input.args.trim();
      if (!args) return ctx.send(input.entity, USAGE);
      const name = deps.getEntity?.(input.entity)?.name;
      const [first, ...rest] = args.split(/\s+/);
      const sub = first?.toLowerCase();
      if (sub === "list" || sub === "ls") {
        if (!deps.db || !name) return ctx.send(input.entity, "Forecast history needs persistence.");
        return ctx.send(input.entity, renderHistory(deps.db.listForecastAnswers(name, 20)));
      }
      if (sub === "track") {
        const id = Number(rest[0]);
        const sampleId = rest[1];
        if (!Number.isInteger(id) || id <= 0 || !sampleId || !parseSampleId(sampleId)) {
          return ctx.send(input.entity, "Usage: forecast track <id> <venue>/<ticker>");
        }
        if (!deps.db || !name)
          return ctx.send(input.entity, "Forecast tracking needs persistence.");
        return ctx.send(
          input.entity,
          deps.db.linkForecastToSample(id, name, sampleId)
            ? `Forecast #${id} will be scored when ${sampleId} resolves.`
            : `No open forecast #${id} of yours to track.`,
        );
      }
      const parsed = parseModifiers(args.split(/\s+/), {
        resolves: { type: "string" },
        type: { type: "string" },
        options: { type: "string" },
        size: { type: "string" },
        ends: { type: "string" },
      });
      const sampleId = parsed.values.resolves as string | undefined;
      if (sampleId !== undefined && !parseSampleId(sampleId)) {
        return ctx.send(input.entity, "resolves: takes a <venue>/<ticker> Sample id.");
      }
      const typed = typedSpec(parsed.values);
      if (typed && "error" in typed) return ctx.send(input.entity, typed.error);
      const modified = sampleId !== undefined || typed !== undefined;
      const question = modified ? parsed.rest.join(" ").trim() : args;
      if (!question) return ctx.send(input.entity, USAGE);
      const capped = dailyCapRefusal();
      if (capped) {
        ctx.send(input.entity, `Not forecasting: ${capped}.`);
        return;
      }
      if (!limiter.consume(input.entity)) {
        return ctx.send(
          input.entity,
          "Forecast budget used up for now — try again in a few minutes.",
        );
      }
      ctx.send(
        input.entity,
        dim("Researching, checking sources, asking several models… (~20–60 s)"),
      );
      if (typed) {
        return (async () => {
          // The same builder as POST /v1/forecast: operator formation and
          // routing, the prior / recalibration stage, and the lesson pool.
          const { typedForecastFor } = await import("../../forecast/surface");
          const made = await typedForecastFor(
            { question, answer: typed.spec, ...(typed.endTime ? { endTime: typed.endTime } : {}) },
            deps.lessonsDb ? { db: deps.lessonsDb } : {},
          );
          if ("error" in made) return ctx.send(input.entity, made.error);
          const a = made.answer;
          const saved = name && deps.db ? saveTypedAnswer(deps.db, name, a, sampleId) : undefined;
          ctx.send(
            input.entity,
            renderTyped(a) +
              scaleNote(made.scale) +
              (saved === undefined ? "" : `\n${dim(`saved as forecast #${saved}`)}`),
          );
        })().catch((err) =>
          ctx.send(
            input.entity,
            `Forecast failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return (async () => {
        const [{ forecastQuestion }, { forecastDeps }] = await Promise.all([
          import("../../forecast/question"),
          import("../../forecast/service"),
        ]);
        const made = forecastDeps();
        if ("error" in made) return ctx.send(input.entity, made.error);
        const a = await forecastQuestion({ question }, made.deps);
        a.costUsd = made.costUsd();
        const saved = name && deps.db ? saveAnswer(deps.db, name, a, sampleId) : undefined;
        ctx.send(
          input.entity,
          render(a) +
            scaleNote(made.scale) +
            (saved === undefined
              ? ""
              : `\n${dim(`saved as forecast #${saved}${sampleId ? ` · scored when ${sampleId} resolves` : " · forecast track <id> <venue>/<ticker> to score it"}`)}`),
        );
      })().catch((err) =>
        ctx.send(
          input.entity,
          `Forecast failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    },
  };
}

const TYPED = ["choice", "multi", "number", "ranking", "text"] as const;

/** `type:` / `options:` / `size:` / `ends:` → a typed answer spec (undefined without `type:`). */
export function typedSpec(
  values: Record<string, unknown>,
): { spec: AnswerSpec; endTime?: string } | { error: string } | undefined {
  const type = typeof values.type === "string" ? values.type.toLowerCase() : undefined;
  if (type === undefined) return undefined;
  if (!(TYPED as readonly string[]).includes(type)) {
    return { error: `type: takes one of ${TYPED.join(", ")}.` };
  }
  const ends = typeof values.ends === "string" ? values.ends : undefined;
  if (ends !== undefined && !Number.isFinite(Date.parse(ends))) {
    return { error: "ends: takes an ISO time, e.g. ends:2026-10-07T16:00:00Z." };
  }
  const options =
    typeof values.options === "string"
      ? values.options
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : [];
  const size = Number(values.size);
  let spec: AnswerSpec;
  if (type === "choice" || type === "multi") {
    if (options.length < 2) return { error: `type:${type} needs options:<id,id,…> (2 or more).` };
    if (new Set(options.map((o) => o.toUpperCase())).size !== options.length) {
      return { error: "options: ids must be distinct." };
    }
    spec = { type, options: options.map((id) => ({ id })) };
  } else if (type === "ranking") {
    spec = {
      type,
      ...(Number.isInteger(size) && size > 0 && size <= 50 ? { size } : {}),
      ...(options.length ? { candidates: options } : {}),
    };
  } else {
    spec = { type: type as "number" | "text" };
  }
  return { spec, ...(ends ? { endTime: new Date(ends).toISOString() } : {}) };
}

/**
 * Where an answer was filed: the surface (`command`, `api`, a board), the
 * board's own id for the question, and the measurement context (`measure`
 * answers resolve and are scored, but never teach).
 */
export interface AnswerFiling {
  source: string;
  externalId?: string;
  evalMode?: "live" | "measure";
}

/** Persist a typed answer (best-effort, like `saveAnswer`). */
export function saveTypedAnswer(
  db: NonNullable<ForecastCommandDeps["db"]>,
  entityName: string,
  a: TypedForecastAnswer,
  sampleId?: string,
  filing: AnswerFiling = { source: "command" },
): number | undefined {
  try {
    return db.saveForecastAnswer({
      ...filing,
      entityName,
      question: a.question,
      kind: a.answer.type,
      ...(typeof a.prediction === "number" ? { mean: a.prediction } : {}),
      // A number's uncertainty: with it, the answer is scored by CRPS when it resolves.
      ...(typeof a.prediction === "number" && a.uncertainty?.sd ? { sd: a.uncertainty.sd } : {}),
      ...(a.formatted !== undefined ? { prediction: a.formatted } : {}),
      answerJson: JSON.stringify(a),
      ...(sampleId ? { sampleId } : {}),
    });
  } catch (err) {
    logger.warn("forecast", "Forecast answer not saved", { error: getErrorMessage(err) });
    return undefined;
  }
}

/** One honest line when the forecaster ran on less than its full multi-vendor setup. */
export function scaleNote(scale: ForecastScale): string {
  return scale.tier === "degraded" ? `\n${dim(`degraded: ${scale.notes.join("; ")}`)}` : "";
}

export function renderTyped(a: TypedForecastAnswer): string {
  const conf = a.confidence === undefined ? "" : dim(` · confidence ${a.confidence.toFixed(2)}`);
  return [
    header("Forecast"),
    separator(),
    a.question,
    `→ ${bold(a.formatted ?? "no answer")}${conf}`,
    ...(a.caveat ? [dim(`caveat: ${a.caveat}`)] : []),
    ...(a.plan?.resolutionSource ? [dim(`resolves from: ${a.plan.resolutionSource}`)] : []),
    "",
    ...a.runs.map(
      (r) =>
        `  ${bold(`run ${r.run}`)} ${r.model}: ${r.formatted ?? r.status}${r.grounded === undefined ? "" : dim(` · grounded ${r.grounded.toFixed(2)}`)}\n    ${dim(r.reason ?? "")}`,
    ),
    ...(a.critique
      ? [
          dim(
            `critique (${a.critique.model}): ${a.critique.verdict}${a.critique.proposed ? ` → ${a.critique.proposed}${a.critique.applied ? " (applied)" : " (not applied)"}` : ""}${a.critique.reason ? ` — ${a.critique.reason}` : ""}`,
          ),
        ]
      : []),
    ...(a.verification
      ? [
          dim(
            `evidence: ${a.verification.verified ?? 0} verified · ${a.verification.unverified ?? 0} unverified · ${a.verification.unreachable ?? 0} unreachable`,
          ),
        ]
      : []),
    ...a.sources.slice(0, 5).map((s) => dim(`  - ${s.url}`)),
    dim(
      `research rounds ${a.research.length} · cutoff ${a.cutoff.at} · cost $${a.costUsd.toFixed(3)} · ${(a.latencyMs / 1000).toFixed(0)} s`,
    ),
  ].join("\n");
}

/** Persist one answer (best-effort: a failed save never loses the reply). */
export function saveAnswer(
  db: NonNullable<ForecastCommandDeps["db"]>,
  entityName: string,
  a: ForecastAnswer,
  sampleId?: string,
  filing: AnswerFiling = { source: "command" },
): number | undefined {
  try {
    return db.saveForecastAnswer({
      ...filing,
      entityName,
      question: a.question,
      kind: a.kind,
      ...(a.probability === undefined ? {} : { probability: a.probability }),
      ...(a.mean === undefined ? {} : { mean: a.mean }),
      ...(a.sd === undefined ? {} : { sd: a.sd }),
      answerJson: JSON.stringify(a),
      ...(sampleId ? { sampleId } : {}),
    });
  } catch (err) {
    logger.warn("forecast", "Forecast answer not saved", { error: getErrorMessage(err) });
    return undefined;
  }
}

/** What a resolved row's score is, per kind (every score is a loss: lower is better). */
const SCORE_LABEL: Record<string, string> = {
  probability: "Brier",
  number: "CRPS",
  choice: "Brier",
  multi: "set Brier",
  ranking: "overlap loss",
  text: "mismatch",
};

export function renderHistory(rows: ForecastAnswerRow[]): string {
  if (rows.length === 0) return "No saved forecasts yet.";
  return [
    header("Forecasts"),
    separator(),
    ...rows.map((r) => {
      const value =
        r.kind === "probability"
          ? r.probability === null
            ? "no answer"
            : `${Math.round(r.probability * 100)}% yes`
          : r.kind === "number"
            ? r.mean === null
              ? "no answer"
              : `${r.mean} ± ${r.sd}`
            : (r.prediction ?? "no answer");
      const state =
        r.resolved_at === null
          ? r.sample_id
            ? `open · resolves on ${r.sample_id}`
            : "open · untracked"
          : `resolved${r.score === null ? "" : ` · ${SCORE_LABEL[r.kind] ?? "loss"} ${r.score.toFixed(3)}`}`;
      return `  #${r.id} ${bold(value)} ${r.question.slice(0, 80)}\n    ${dim(state)}`;
    }),
  ].join("\n");
}

export function render(a: ForecastAnswer): string {
  const headline =
    a.kind === "probability"
      ? a.probability === undefined
        ? "no answer"
        : `${Math.round(a.probability * 100)}% yes`
      : a.mean === undefined
        ? "no answer"
        : `${a.mean} (80%: ${a.interval?.[0]} – ${a.interval?.[1]})`;
  return [
    header("Forecast"),
    separator(),
    a.question,
    `→ ${bold(headline)}`,
    ...(a.caveat ? [dim(`caveat: ${a.caveat}`)] : []),
    "",
    ...a.analysts.map((x) => {
      const v =
        x.probability !== undefined
          ? `${Math.round(x.probability * 100)}%`
          : x.mean !== undefined
            ? `${x.mean} ± ${x.sd}`
            : x.status;
      return `  ${bold(x.name)} ${v}${x.grounded === undefined ? "" : dim(` · grounded ${x.grounded.toFixed(2)}`)}\n    ${dim(x.reason ?? "")}`;
    }),
    ...(a.verification
      ? [
          dim(
            `evidence: ${a.verification.verified ?? 0} verified · ${a.verification.unverified ?? 0} unverified · ${a.verification.unreachable ?? 0} unreachable`,
          ),
        ]
      : []),
    ...a.sources.slice(0, 5).map((s) => dim(`  - ${s.url}`)),
    dim(`cost $${a.costUsd.toFixed(3)} · ${(a.latencyMs / 1000).toFixed(0)} s`),
  ].join("\n");
}
