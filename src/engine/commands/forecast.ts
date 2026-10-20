// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../auth/rate-limiter";
import type { AnswerSpec } from "../../forecast/answer-types";
import type { ForecastAnswer } from "../../forecast/question";
import { residentsMode } from "../../forecast/resident-mode";
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
  "       forecast [formation:<name>] [retriever:<spec>] … -- <question>",
  "                                         choose the formation (or verify / arbiter) and a retriever the operator allows",
  "       forecast list                     your saved forecasts and, once resolved, their scores",
  "       forecast track <id> <venue>/<ticker>   score forecast #id when that market/watch resolves",
  "       forecast competence [family]      what Marina's resolved record says each method is good at",
  "       forecast routes [family]          paired evidence per family and method, and which routes are earned",
  "       forecast <question> crew:<crew>|role:<role> [pattern:ensemble|delphi] [residents:N] [asof:<date>] [measure:yes]",
  "                                         residents answer with their own tools, as a task run as a Score",
  "                                         (MARINA_FORECAST_RESIDENTS=on; a past asof: or measure:yes fences their tools)",
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
      { syntax: "forecast <question> [resolves:<venue>/<ticker>]", effect: "execute" },
      {
        syntax:
          "forecast <question> type:<choice|multi|number|ranking|text> [options:<id,id,…>] [size:<n>] [ends:<iso>]",
        effect: "execute",
      },
      {
        syntax: "forecast [formation:<name>] [retriever:<spec>] [type:<t>] … -- <question>",
        effect: "execute",
      },
      { syntax: "forecast list", effect: "read" },
      { syntax: "forecast track <id> <venue>/<ticker>", effect: "write" },
      { syntax: "forecast competence [<family prefix>]", effect: "read" },
      { syntax: "forecast routes [<family prefix>]", effect: "read" },
      {
        syntax:
          "forecast <question> crew:<crew> [pattern:<ensemble|delphi>] [residents:<n>] [asof:<iso>] [measure:yes]",
        effect: "execute",
      },
      {
        syntax:
          "forecast <question> role:<role> [pattern:<ensemble|delphi>] [residents:<n>] [asof:<iso>] [measure:yes]",
        effect: "execute",
      },
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
      if (sub === "competence" && rest.length <= 1) {
        // Read-only: Marina's own record per (family, method), live from the outcome path.
        if (!deps.lessonsDb) return ctx.send(input.entity, "The competence map needs persistence.");
        const db = deps.lessonsDb;
        return (async () => {
          const { competenceMap, renderCompetence } = await import("../../forecast/competence");
          const family = rest[0]?.replace(/^family:/, "");
          ctx.send(input.entity, renderCompetence(competenceMap(db, family ? { family } : {})));
        })().catch((err) =>
          ctx.send(input.entity, `Competence map unavailable: ${getErrorMessage(err)}`),
        );
      }
      if (sub === "routes" && rest.length <= 1) {
        // Read-only: earned routing across forecast and arena evidence (src/forecast/route-view.ts).
        if (!deps.lessonsDb) return ctx.send(input.entity, "The route view needs persistence.");
        const db = deps.lessonsDb;
        return (async () => {
          const { loadRouteView, renderRouteView } = await import("../../forecast/route-view");
          const family = rest[0]?.replace(/^family:/, "");
          const view = await loadRouteView(db, family ? { family } : {});
          ctx.send(input.entity, renderRouteView(view.rows, view.notes));
        })().catch((err) =>
          ctx.send(input.entity, `Route view unavailable: ${getErrorMessage(err)}`),
        );
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
      const parsed = parseModifiers(args.split(/\s+/), forecastModifierSpec());
      const sampleId = parsed.values.resolves as string | undefined;
      if (sampleId !== undefined && !parseSampleId(sampleId)) {
        return ctx.send(input.entity, "resolves: takes a <venue>/<ticker> Sample id.");
      }
      const typed = typedSpec(parsed.values);
      if (typed && "error" in typed) return ctx.send(input.entity, typed.error);
      const chosen =
        typeof parsed.values.formation === "string" || typeof parsed.values.retriever === "string";
      // Resident forecasts (src/forecast/resident-forecast.ts): their modifiers
      // parse only under MARINA_FORECAST_RESIDENTS=on (`forecastModifierSpec`).
      const residentAsked = ["crew", "role", "pattern", "residents", "asof", "measure"].some(
        (k) => parsed.values[k] !== undefined,
      );
      const modified =
        sampleId !== undefined ||
        typed !== undefined ||
        chosen ||
        residentAsked ||
        /(^|\s)--(\s|$)/.test(args);
      const question = modified ? parsed.rest.join(" ").trim() : args;
      if (!question) return ctx.send(input.entity, USAGE);
      const residentReq = residentAsked ? residentRequest(parsed.values) : undefined;
      if (residentReq && "error" in residentReq) return ctx.send(input.entity, residentReq.error);
      const run = (env?: NodeJS.ProcessEnv): Promise<void> | void => {
        const surfaceOpts = {
          ...(deps.lessonsDb ? { db: deps.lessonsDb } : {}),
          ...(env ? { env } : {}),
        };
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
        if (residentReq) {
          ctx.send(
            input.entity,
            dim(`Asking residents (${residentReq.assignee}, ${residentReq.pattern}) as a task…`),
          );
          return (async () => {
            const { forecastAsTask } = await import("../../forecast/resident-forecast");
            const made = await forecastAsTask(
              {
                request: {
                  forecast: {
                    question,
                    answer: typed?.spec ?? { type: "choice", options: YES_NO, probabilities: true },
                    ...(typed?.endTime ? { endTime: typed.endTime } : {}),
                    ...(residentReq.asOf ? { asOf: residentReq.asOf } : {}),
                  },
                  pattern: residentReq.pattern,
                  assignee: residentReq.assignee,
                  ...(residentReq.k ? { k: residentReq.k } : {}),
                  measure: residentReq.measure,
                },
                filer: { id: input.entity, name: name ?? input.entity },
                ...(sampleId ? { sampleId } : {}),
              },
              { ...(deps.lessonsDb ? { db: deps.lessonsDb } : {}), ...(env ? { env } : {}) },
            );
            if ("error" in made) return ctx.send(input.entity, made.error);
            const r = made.answer.residents;
            ctx.send(
              input.entity,
              `${renderTyped(made.answer)}\n${dim(
                `residents (${r.pattern}${r.fence ? `, fenced at ${r.fence}` : ""}): ${
                  r.producers.join(", ") || "none answered"
                } · ${r.budget.attempted}/${r.budget.calls} calls${
                  made.taskId !== undefined ? ` · task #${made.taskId}` : ""
                }${made.answerId !== undefined ? ` · saved as forecast #${made.answerId}` : ""}${
                  made.residentAnswerIds.length
                    ? ` · ${made.residentAnswerIds.length} resident answer(s) filed`
                    : ""
                }`,
              )}`,
            );
          })().catch((err) => ctx.send(input.entity, `Forecast failed: ${getErrorMessage(err)}`));
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
              {
                question,
                answer: typed.spec,
                ...(typed.endTime ? { endTime: typed.endTime } : {}),
              },
              surfaceOpts,
            );
            if ("error" in made) return ctx.send(input.entity, made.error);
            const a = made.answer;
            const saved = name && deps.db ? saveTypedAnswer(deps.db, name, a, sampleId) : undefined;
            await startShadow(deps.lessonsDb, saved, a);
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
          const surface = await import("../../forecast/surface");
          let made: { answer: ForecastAnswer; scale: ForecastScale } | { error: string };
          if (surface.plainUsesLegacy(env)) {
            const [{ forecastQuestion }, { forecastDeps }] = await Promise.all([
              import("../../forecast/question"),
              import("../../forecast/service"),
            ]);
            const wired = forecastDeps(env);
            if ("error" in wired) made = wired;
            else {
              const answer = await forecastQuestion({ question }, wired.deps);
              answer.costUsd = wired.costUsd();
              made = { answer, scale: wired.scale };
            }
          } else {
            // The full pipeline (lessons, formations, routing) for a plain question too.
            made = await surface.plainForecastFor({ question }, surfaceOpts);
          }
          if ("error" in made) return ctx.send(input.entity, made.error);
          const a = made.answer;
          const saved = name && deps.db ? saveAnswer(deps.db, name, a, sampleId) : undefined;
          await startShadow(deps.lessonsDb, saved, a);
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
      };
      if (!chosen) return run();
      // A caller-chosen formation / retriever is validated before any budget is spent.
      return forecastSurfaceEnv(parsed.values).then((picked) =>
        "error" in picked ? ctx.send(input.entity, picked.error) : run(picked.env),
      );
    },
  };
}

/**
 * The env a caller-chosen `formation:` / `retriever:` runs under: the
 * formation through `formationEnv` (an unknown name is an error, never the
 * default), the retriever through `residentRetrieverSpec` (only entries that
 * name no model, or one the operator configured). Empty when neither is set.
 */
export async function forecastSurfaceEnv(
  values: Record<string, unknown>,
  base: NodeJS.ProcessEnv = process.env,
): Promise<{ env?: NodeJS.ProcessEnv } | { error: string }> {
  const formation = typeof values.formation === "string" ? values.formation : undefined;
  const retriever = typeof values.retriever === "string" ? values.retriever : undefined;
  if (formation === undefined && retriever === undefined) return {};
  let env = base;
  if (formation !== undefined) {
    const { formationEnv } = await import("../../forecast/surface");
    const formed = formationEnv(formation, env);
    if ("error" in formed) return { error: `formation: ${formed.error}` };
    env = formed.env;
  }
  if (retriever !== undefined) {
    const { residentRetrieverSpec } = await import("../../research/ask");
    const picked = residentRetrieverSpec(retriever, base);
    if ("error" in picked) return picked;
    env = { ...env, MARINA_FORECAST_RETRIEVER: picked.spec };
  }
  return { env };
}

const TYPED = ["choice", "multi", "number", "ranking", "text"] as const;
const YES_NO = [{ id: "yes" }, { id: "no" }];
const RESIDENT_MODIFIERS = {
  crew: { type: "string" },
  role: { type: "string" },
  pattern: { type: "string" },
  residents: { type: "string" },
  asof: { type: "string" },
  measure: { type: "string" },
} as const;

/**
 * The `forecast` modifiers. Resident forecasts add theirs only when they are
 * on (MARINA_FORECAST_RESIDENTS): off, every input parses exactly as before.
 */
export function forecastModifierSpec(env: NodeJS.ProcessEnv = process.env) {
  return {
    resolves: { type: "string" },
    type: { type: "string" },
    options: { type: "string" },
    size: { type: "string" },
    ends: { type: "string" },
    formation: { type: "string" },
    retriever: { type: "string" },
    ...(residentsMode(env) === "on" ? RESIDENT_MODIFIERS : {}),
  } as const;
}

/**
 * `crew:` / `role:` / `pattern:` / `residents:` / `asof:` / `measure:` → a
 * resident forecast (`src/forecast/resident-forecast.ts`).
 */
export function residentRequest(values: Record<string, unknown>):
  | {
      assignee: string;
      pattern: "ensemble" | "delphi";
      k?: number;
      asOf?: string;
      measure: boolean;
    }
  | { error: string } {
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string).trim() : "");
  if (str("crew") && str("role")) return { error: "Name a crew: or a role:, not both." };
  const slug = /^[A-Za-z0-9_.-]{1,64}$/;
  for (const k of ["crew", "role"])
    if (str(k) && !slug.test(str(k)))
      return { error: `${k}: takes a name (letters, digits, - _ .).` };
  const pattern = (str("pattern") || "ensemble").toLowerCase();
  if (pattern !== "ensemble" && pattern !== "delphi")
    return { error: "pattern: takes ensemble or delphi for a resident forecast." };
  const k = str("residents") ? Number(str("residents")) : undefined;
  if (k !== undefined && !(Number.isInteger(k) && k >= 1 && k <= 7))
    return { error: "residents: takes a whole number 1–7." };
  let asOf: string | undefined;
  if (str("asof")) {
    const raw = str("asof");
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
    if (!Number.isFinite(t)) return { error: "asof: takes an ISO time or YYYY-MM-DD." };
    asOf = new Date(t).toISOString();
  }
  const measure = ["yes", "on", "true", "1"].includes(str("measure").toLowerCase());
  return {
    assignee: str("crew") ? `marina:${str("crew")}` : `role:${str("role") || "forecaster"}`,
    pattern,
    ...(k !== undefined ? { k } : {}),
    ...(asOf ? { asOf } : {}),
    measure,
  };
}

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

/**
 * A filed live answer's shadow challenger (`src/forecast/shadow.ts`; only when
 * `MARINA_FORECAST_SHADOW` planned one). Runs in the background; the reply and
 * the filed answer are never touched.
 */
export async function startShadow(
  db: MarinaDB | undefined,
  answerId: number | undefined,
  answer: unknown,
): Promise<void> {
  if (!db || answerId === undefined || !process.env.MARINA_FORECAST_SHADOW?.trim()) return;
  const { startForecastShadow } = await import("../../forecast/shadow");
  startForecastShadow(db, answerId, answer);
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
