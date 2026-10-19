// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place the command, the hourly autopilot and readiness read arena
 * state from. Config is re-read from the environment on every call (cheap), so
 * a key rotation or an autopilot switch takes effect without a restart.
 */

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { NotesStore } from "../persistence/interfaces/notes-store";
import { type ArenaConfig, arenaConfigFromEnv, loadArenaKey } from "./config";
import { ArenaData, DEFAULT_ARENA_DATA_URL } from "./data";
import type { Forecaster, Learner } from "./evaluate";
import {
  type FilingWatchResult,
  filingFindings,
  recordFilingWatch,
  WATCH_WINDOW_HOURS,
} from "./filing-watch";
import { forecastRound } from "./forecast";
import { forecastSettings } from "./forecast-config";
import { forecastCutoff, requireFreshForecast } from "./freshness";
import type { Usage } from "./model-backend";
import { publicKeyBase64 } from "./protocol";
import {
  baselineForecaster,
  dueRounds,
  type SubmitDeps,
  type SubmitOutcome,
  submitRound,
} from "./submit";

const logger = new Logger();
/** Days of the Civiqs daily tracker the model roles read (the quant input). */
const DAILY_POINTS = 21;

export interface ArenaStatus {
  configured: boolean;
  entrant?: string;
  keyId?: string;
  keyFile?: string;
  /** Base64 raw public key — what the registration publishes. */
  publicKey?: string;
  keyError?: string;
  autopilot: boolean;
  origin?: string;
  configError?: string;
}

let dataCache: { url: string; data: ArenaData } | undefined;

function dataFor(config: ArenaConfig): ArenaData {
  if (dataCache?.url !== config.dataUrl) {
    dataCache = { url: config.dataUrl, data: new ArenaData(config.dataUrl) };
  }
  return dataCache.data;
}

export function arenaStatus(env: NodeJS.ProcessEnv = process.env): ArenaStatus {
  let config: ArenaConfig | undefined;
  try {
    config = arenaConfigFromEnv(env);
  } catch (err) {
    return { configured: false, autopilot: false, configError: (err as Error).message };
  }
  if (!config) return { configured: false, autopilot: false };
  const base: ArenaStatus = {
    configured: true,
    entrant: config.entrant,
    keyId: config.keyId,
    autopilot: config.autopilot,
    origin: config.origin,
    ...(config.keyFile ? { keyFile: config.keyFile } : {}),
  };
  if (!config.keyFile) return { ...base, keyError: "MARINA_ARENA_KEY_FILE is not set" };
  try {
    return { ...base, publicKey: publicKeyBase64(loadArenaKey(config.keyFile)) };
  } catch (err) {
    return { ...base, keyError: (err as Error).message };
  }
}

/**
 * Does the arena's published registration accept the local signing key? Reads
 * entrants/<id>.json and checks that MARINA_ARENA_KEY_ID is listed, unrevoked,
 * with the SAME public key the local key file derives — so a key-id / key-file
 * mix-up is caught here rather than as a rejected filing at lock time.
 */
export async function arenaRegistrationCheck(
  env: NodeJS.ProcessEnv = process.env,
  data: ArenaData = arenaData(env),
): Promise<{ ok: boolean; message: string; registeredKeys?: string[] }> {
  const status = arenaStatus(env);
  if (!status.configured || !status.entrant) {
    return { ok: false, message: "MARINA_ARENA_ENTRANT is not set" };
  }
  if (!status.publicKey) return { ok: false, message: `local key not usable: ${status.keyError}` };
  const reg = await data.entrant(status.entrant);
  if (!reg) {
    return {
      ok: false,
      message: `${status.entrant} is not registered yet (no entrants/${status.entrant}.json on the arena's main branch)`,
    };
  }
  const keys = reg.keys ?? [];
  const registeredKeys = keys.map((k) => `${k.id}${k.revoked ? " (revoked)" : ""}: ${k.public}`);
  const byId = keys.find((k) => k.id === status.keyId);
  const byPublic = keys.find((k) => k.public === status.publicKey);
  if (reg.status === "revoked")
    return { ok: false, message: "the entrant is revoked", registeredKeys };
  if (byId && !byId.revoked && byId.public === status.publicKey) {
    return { ok: true, message: `key ${status.keyId} matches the registration`, registeredKeys };
  }
  if (byPublic && !byPublic.revoked) {
    return {
      ok: false,
      message: `the local key is registered as "${byPublic.id}", but MARINA_ARENA_KEY_ID is "${status.keyId}" — set MARINA_ARENA_KEY_ID=${byPublic.id}`,
      registeredKeys,
    };
  }
  if (byId) {
    return {
      ok: false,
      message: byId.revoked
        ? `key ${status.keyId} is revoked`
        : `key ${status.keyId} is registered with a different public key (${byId.public}) than MARINA_ARENA_KEY_FILE derives (${status.publicKey}) — point MARINA_ARENA_KEY_FILE at that key's private half`,
      registeredKeys,
    };
  }
  return {
    ok: false,
    message: `neither key id ${status.keyId} nor the local public key ${status.publicKey} is registered for ${status.entrant}`,
    registeredKeys,
  };
}

/**
 * The forecaster a spec names: the calibrated baseline, or a model shrunk toward
 * it. The model stack is imported only when a model is actually asked for.
 * `raw: true` returns the model's own answer (for shadow scoring), not the blend.
 */
/**
 * The lock as model roles read it: refresh all Trends cells from one newer
 * eligible snapshot, matching the nowcast start without mixing vintages.
 */
export async function lockForModels(
  data: ArenaData,
  round: import("./types").ArenaRound,
  lock: import("./types").ArenaLock,
): Promise<import("./types").ArenaLock> {
  if (round.tracker !== "google_trends" || round.target_type !== "profile_energy") {
    return lock;
  }
  const { trendsForecastLock } = await import("./research/civiqs-nowcast");
  return trendsForecastLock(data, round, lock);
}

/** Live Civiqs reads for open rounds (on unless MARINA_ARENA_CIVIQS_LIVE=off). */
async function liveCiviqs(env: NodeJS.ProcessEnv = process.env, strictFreshness = false) {
  const { civiqsLiveEnabled, fetchCiviqsLive } = await import("./research/civiqs-live");
  const { horizonOptionsFromEnv } = await import("./research/civiqs-horizon");
  return {
    strictFreshness,
    horizon: horizonOptionsFromEnv(env),
    ...(civiqsLiveEnabled(env)
      ? { live: (n: string, f?: Record<string, string>) => fetchCiviqsLive(n, f) }
      : {}),
  };
}

/**
 * `route:` / `routed`: each tracker family answered by its own forecaster
 * (src/arena/routing.ts), built lazily on first use so an unused expensive
 * route costs nothing; a `skip` family throws {@link SkippedRound}, which
 * submit, shadow and evaluate all treat as "not answered".
 */
async function routedForecasterFor(
  spec: string,
  opts: Parameters<typeof forecasterFor>[1],
): Promise<{ forecaster: Forecaster; usage?: Usage }> {
  const { isPinned, parseRoutes, routeFor, SKIP, SkippedRound } = await import("./routing");
  const env = opts?.env ?? process.env;
  const routes = parseRoutes(spec, env);
  const earned = await import("./earned-routes");
  const mode = earned.arenaRoutingModeFromEnv(env);
  const minN = earned.arenaRouteMinN(env);
  // Read once per forecaster build: every family decides from the same evidence.
  let evidence: Promise<import("./earned-routes").RouteEvidence[]> | undefined;
  const decide = async (
    tracker: string,
    target: string,
  ): Promise<import("./earned-routes").ArenaRouteDecision | undefined> => {
    if (mode === "off" || target === SKIP) return undefined;
    const pinned = isPinned(routes, tracker);
    let records: import("./earned-routes").RouteEvidence[] = [];
    let unreadable: string | undefined;
    if (!pinned && opts?.routeEvidence) {
      evidence ??= opts.routeEvidence();
      records = await evidence.catch((err) => {
        unreadable = getErrorMessage(err);
        return [];
      });
    }
    const decision = earned.chooseArenaRoute({
      family: tracker.toLowerCase(),
      defaultSpec: target,
      evidence: records,
      now: Date.now(),
      mode,
      minN,
      pinned,
    });
    // Unreadable evidence falls open to the default, and says so.
    return unreadable
      ? { ...decision, reason: `evidence unreadable (${unreadable}): the default stands` }
      : decision;
  };
  const built = new Map<string, Promise<{ forecaster: Forecaster; usage?: Usage }>>();
  const get = (target: string) => {
    if (!built.has(target)) built.set(target, forecasterFor(target, opts));
    return built.get(target)!;
  };
  const usages: Usage[] = [];
  const usage: Usage = {
    get calls() {
      return usages.reduce((s, u) => s + u.calls, 0);
    },
    get inputTokens() {
      return usages.reduce((s, u) => s + u.inputTokens, 0);
    },
    get outputTokens() {
      return usages.reduce((s, u) => s + u.outputTokens, 0);
    },
    get costUsd() {
      return usages.reduce((s, u) => s + u.costUsd, 0);
    },
  };
  return {
    usage,
    forecaster: async (round, lock) => {
      const fallback = routeFor(routes, round.tracker);
      if (fallback === SKIP) throw new SkippedRound(round.tracker);
      const routing = await decide(round.tracker, fallback);
      const target = routing?.chosen ?? fallback;
      const fresh = !built.has(target);
      const made = await get(target);
      if (fresh && made.usage) usages.push(made.usage);
      const f = await made.forecaster(round, lock);
      return {
        ...f,
        note: `route ${round.tracker} → ${target}; ${f.note}`.slice(0, 500),
        ...(routing ? { routing } : {}),
      };
    },
  };
}

/** Immutable caller-supplied experiment inputs; no archive or research rereads. */
export interface FormationInputs {
  roundId: string;
  start: import("./forecast").RoundForecast;
  lock: import("./types").ArenaLock;
  dossier?: import("./formations").ResearchDossier;
}

export async function forecasterFor(
  spec: string,
  opts: {
    weight?: number;
    raw?: boolean;
    env?: NodeJS.ProcessEnv;
    notes?: NotesStore;
    formationInputs?: FormationInputs;
    strictFreshness?: boolean;
    previous?: (roundId: string) => import("./formations").ComposedForecast | undefined;
    /** Scored evidence for earned routes (`earned-routes.ts`); without it routes are the defaults. */
    routeEvidence?: () => Promise<import("./earned-routes").RouteEvidence[]>;
  } = {},
): Promise<{ forecaster: Forecaster; usage?: Usage; learner?: Learner }> {
  if (spec === "baseline")
    return {
      forecaster: opts.strictFreshness
        ? async (round, lock) => requireFreshForecast(round, lock, forecastRound(round, lock))
        : baselineForecaster,
    };
  if (spec === "routed" || spec.startsWith("route:")) return routedForecasterFor(spec, opts);
  if (spec === "discovered") {
    // Each family's best PROMOTED signal (arena discover), else the nowcast.
    const [{ nowcastForecaster }, loop, signals] = await Promise.all([
      import("./research/civiqs-nowcast"),
      import("./discovery/loop"),
      import("./discovery/signals"),
    ]);
    const data = arenaData(opts.env ?? process.env);
    const fallback = nowcastForecaster(
      data,
      forecastRound,
      await liveCiviqs(opts.env, opts.strictFreshness),
    );
    const promoted = opts.notes ? loop.promotedSignals(opts.notes) : new Map();
    return {
      forecaster: async (round, lock) => {
        const hit = promoted.get(round.tracker);
        if (!hit || round.target_type !== "continuous_normal") return fallback(round, lock);
        const f = forecastRound(round, lock);
        const topline = await signals.applySignal(hit.spec, round, lock, data);
        return {
          ...f,
          topline,
          note: `marina discovered signal ${hit.key} (holdout ${hit.holdout?.skill.toFixed(3)})`,
        };
      },
    };
  }
  if (spec === "nowcast") {
    const { nowcastForecaster } = await import("./research/civiqs-nowcast");
    return {
      forecaster: nowcastForecaster(
        arenaData(opts.env ?? process.env),
        forecastRound,
        await liveCiviqs(opts.env, opts.strictFreshness),
      ),
    };
  }
  if (spec === "spike-decay") {
    // The nowcast, except that a Trends basket's spiking cells move part of
    // the way back toward their recent level (spike-decay.ts). Free; shadow
    // challenger only — it answers a family only once earned-routes.ts says so.
    const [{ nowcastForecaster, trendsForecastLock }, { spikeDecay }] = await Promise.all([
      import("./research/civiqs-nowcast"),
      import("./spike-decay"),
    ]);
    const data = arenaData(opts.env ?? process.env);
    const nowcast = nowcastForecaster(
      data,
      forecastRound,
      await liveCiviqs(opts.env, opts.strictFreshness),
    );
    return {
      forecaster: async (round, lock) => {
        const f = await nowcast(round, lock);
        if (round.tracker !== "google_trends" || !f.profile) return f;
        const inputs = await trendsForecastLock(data, round, lock);
        const history = inputs.answer_history_by_cell;
        if (!history) return f;
        const { profile, decayed } = spikeDecay(f.profile, history);
        const moved = Object.keys(decayed);
        return {
          ...f,
          profile,
          note: `${f.note}; spike decay: ${moved.length ? moved.map((c) => `${c} ${decayed[c]!.from.toFixed(1)}→${decayed[c]!.mean.toFixed(1)}`).join(", ") : "no spiking cell"}`,
        };
      },
    };
  }
  if (spec.startsWith("tabh2o")) return tabh2oForecasterFor(spec, opts);
  if (spec.startsWith(`${WIKI_EVENTS}:`)) {
    return wikiEventsForecasterFor(spec, opts.env ?? process.env, opts.strictFreshness);
  }
  if (spec.startsWith("research:")) {
    return researchForecasterFor(spec, opts.env ?? process.env, opts.strictFreshness, opts.notes);
  }
  if (spec.startsWith("formation:")) {
    return formationForecasterFor(
      spec,
      opts.env ?? process.env,
      opts.formationInputs,
      opts.strictFreshness,
      opts.notes,
      opts.previous,
    );
  }
  if (spec.startsWith("crew:")) {
    const specs = spec.slice("crew:".length).split(",");
    const [stat, analyst = stat, skeptic = analyst] = specs as [string, string?, string?];
    const [{ modelComplete }, crew] = await Promise.all([
      import("./model-backend"),
      import("./crew"),
    ]);
    const env = opts.env ?? process.env;
    const made = [stat, analyst!, skeptic!].map((m) => modelComplete(m, env));
    const usage: Usage = {
      get calls() {
        return made.reduce((s, m) => s + m.usage.calls, 0);
      },
      get inputTokens() {
        return made.reduce((s, m) => s + m.usage.inputTokens, 0);
      },
      get outputTokens() {
        return made.reduce((s, m) => s + m.usage.outputTokens, 0);
      },
      get costUsd() {
        return made.reduce((s, m) => s + m.usage.costUsd, 0);
      },
    };
    const members = {
      statistician: made[0]!.complete,
      analyst: made[1]!.complete,
      skeptic: made[2]!.complete,
    };
    const notes = opts.notes;
    // The judged lesson pool (forecast, arena and cross-board meta lessons),
    // read at each round's lock, when the notes store is a Marina database.
    const lessonStore =
      notes && "getBenchmarkRun" in notes
        ? (await import("../learning/forecast-bridge")).forecastLessonsFor(
            notes as unknown as import("../persistence/database").MarinaDB,
            { env },
          )
        : undefined;
    // Start from the nowcast (fresher than the weekly history for Civiqs; the
    // baseline elsewhere), exactly as the research agent does.
    const { nowcastForecaster } = await import("./research/civiqs-nowcast");
    const start = nowcastForecaster(arenaData(env), forecastRound, {
      ...(await liveCiviqs(env, opts?.strictFreshness)),
      daily: DAILY_POINTS,
    });
    return {
      usage,
      forecaster: async (round, lock) =>
        crew.crewForecastRound(round, lock, members, notes, await start(round, lock), lessonStore),
      ...(notes
        ? {
            learner: (round, lock, filed, outcome) => {
              const summary = crew.learn(notes, round, lock, filed, outcome);
              // The judged loop too (a no-op unless learning is armed for this
              // store). The number was public from the round's release.
              if (summary)
                void import("../learning/service").then(({ noteOutcome }) =>
                  noteOutcome(
                    notes,
                    crew.crewLessonOutcome(round, round.round_id, summary, round.release_at),
                  ),
                );
            },
          }
        : {}),
    };
  }
  const modelSpec = spec.replace(/^model:/, "");
  const [{ modelComplete }, { DEFAULT_MODEL_OPTIONS, modelForecastRound }] = await Promise.all([
    import("./model-backend"),
    import("./model-forecaster"),
  ]);
  const env = opts.env ?? process.env;
  const { complete, usage } = modelComplete(modelSpec, env);
  const options = { ...DEFAULT_MODEL_OPTIONS, weight: opts.raw ? 1 : (opts.weight ?? 0.5) };
  if (opts.raw) options.maxSdMove = Number.POSITIVE_INFINITY;
  const { nowcastForecaster } = await import("./research/civiqs-nowcast");
  const start = nowcastForecaster(arenaData(env), forecastRound, {
    ...(await liveCiviqs(env, opts?.strictFreshness)),
    daily: DAILY_POINTS,
  });
  return {
    usage,
    forecaster: async (round, lock) =>
      modelForecastRound(round, lock, await start(round, lock), complete, options, modelSpec),
  };
}

/**
 * `tabh2o[:forecast][@nowcast]` — TabH2O on a table built from the lock's own
 * history (src/arena/tabh2o-forecaster.ts), shrunk toward the baseline, or with
 * `@nowcast` toward the nowcast, learning a Civiqs round from the daily series
 * of the snapshot the nowcast reads (fetched by the lock). Experimental: no key
 * or an error files the start forecast with a recorded `fallback`.
 */
async function tabh2oForecasterFor(
  spec: string,
  opts: Parameters<typeof forecasterFor>[1],
): Promise<{ forecaster: Forecaster; usage: Usage }> {
  const [
    tab,
    { nowcastForecaster, civiqsDailySeries, trendsBasketHistory, TRENDS_INCLUDE_PARTIAL },
  ] = await Promise.all([import("./tabh2o-forecaster"), import("./research/civiqs-nowcast")]);
  const parsed = tab.parseTabH2OSpec(spec);
  if (!parsed) throw new Error(`not a tabh2o spec: ${spec}`);
  const env = opts?.env ?? process.env;
  const data = arenaData(env);
  const options = {
    ...tab.DEFAULT_TABH2O_OPTIONS,
    weight: opts?.raw ? 1 : (opts?.weight ?? tab.DEFAULT_TABH2O_OPTIONS.weight),
    ...(opts?.raw ? { maxSdMove: Number.POSITIVE_INFINITY } : {}),
  };
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const live = await liveCiviqs(env, opts?.strictFreshness);
  const start: Forecaster = parsed.nowcast
    ? nowcastForecaster(data, forecastRound, live)
    : async (round, lock) => {
        const f = forecastRound(round, lock);
        return opts?.strictFreshness ? requireFreshForecast(round, lock, f) : f;
      };
  const { horizonSteps } = await import("./forecast");
  /** `@nowcast`: a Civiqs series learns from its daily snapshot; a bare Trends lock from the archive. */
  const seriesFor = async (
    round: import("./types").ArenaRound,
    lock: import("./types").ArenaLock,
  ) => {
    if (!parsed.nowcast) return undefined;
    if (round.tracker === "google_trends" && !lock.answer_history_by_cell) {
      const byCell = await trendsBasketHistory(data, round, TRENDS_INCLUDE_PARTIAL);
      return byCell
        ? tab.lockSeries(round, { ...lock, answer_history_by_cell: byCell })
        : undefined;
    }
    if (round.tracker !== "civiqs") return undefined;
    const ids =
      round.target_type === "profile_energy"
        ? (round.cells ?? [])
        : round.series
          ? [round.series]
          : [];
    const out: import("./tabh2o-forecaster").SeriesInput[] = [];
    for (const id of ids) {
      const daily = await civiqsDailySeries(
        data,
        { ...round, series: id },
        { days: tab.MAX_POINTS, ...live },
      );
      // No archived snapshot for a series: the whole round learns from the lock.
      if (!daily || daily.points.length < 10) return undefined;
      out.push({
        key: id,
        points: daily.points,
        steps: horizonSteps(daily.points, round.release_at),
      });
    }
    return out.length ? out : undefined;
  };
  const predict = tab.sharedTabPredict(env);
  return {
    usage,
    forecaster: async (round, lock) =>
      tab.tabh2oForecastRound(
        round,
        lock,
        await start(round, lock),
        parsed,
        {
          predict,
          seriesFor,
          usage,
        },
        options,
      ),
  };
}

/**
 * `formation:<pattern>:<model>[,<model>…][+then:<pattern>:<model>[,…]][+research@<retriever>[,…]]`
 * — an orchestration pattern as a forecasting protocol (src/arena/formations.ts),
 * started from the nowcast like the crew; optionally judged by a second
 * formation (`+then:`) and fed a verified dossier built once per round by a
 * research crew (`+research@`, retrievers as in `research:`). Each round gets
 * its own metered completions, so its cost lands in its record; `usage` is the
 * running total. A `+research` composition reads today's web: shadow only.
 */
async function formationForecasterFor(
  spec: string,
  env: NodeJS.ProcessEnv,
  inputs?: FormationInputs,
  strictFreshness = false,
  notes?: NotesStore,
  previous?: (roundId: string) => import("./formations").ComposedForecast | undefined,
): Promise<{ forecaster: Forecaster; usage: Usage }> {
  const [head = "", ...parts] = spec.split(/\+(?=then:|research@)/);
  const [{ modelComplete }, formations, { nowcastForecaster }] = await Promise.all([
    import("./model-backend"),
    import("./formations"),
    import("./research/civiqs-nowcast"),
  ]);
  const stageOf = (text: string) => {
    const [, name = "", variant, list = ""] =
      text.match(/^(?:formation|then):([a-z]+)(~unanchored)?:(.+)$/i) ?? [];
    const pattern = formations.formationPattern(name);
    if (!pattern) throw new Error(`unknown formation ${name}`);
    const models = list.split(",");
    // Fail fast on a missing provider key, before any round runs.
    for (const m of models) modelComplete(m, env);
    return { pattern, models, unanchored: Boolean(variant) };
  };
  const stages = [stageOf(head)];
  const then = parts.find((p) => p.startsWith("then:"));
  if (then) stages.push(stageOf(then));
  const researchPart = parts.find((p) => p.startsWith("research@"));
  let research:
    | {
        retriever: import("./research/retrieve").Retriever;
        pageText: import("./research/verify").PageText;
      }
    | undefined;
  if (researchPart && !inputs) {
    const [retrieve, { defaultPageText }] = await Promise.all([
      import("./research/retrieve"),
      import("./research/verify"),
    ]);
    const orKey = env.OPENROUTER_API_KEY;
    const { arenaResearchLookups, arenaSignalHints, withDataLookups } = await import(
      "./research/data-evidence"
    );
    const { researchRetriever } = await import("../research/retriever");
    research = retrieve.withProvidedText(
      researchRetriever(
        withDataLookups(
          retrieve.retrieverFromSpec(
            researchPart.slice("research@".length),
            {
              ...(orKey ? { openrouter: orKey } : {}),
              ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
              ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
            },
            { env },
          ),
          arenaResearchLookups(env),
          { hints: arenaSignalHints(env) },
        ),
        env,
        stages[0]!.models[0],
      ),
      defaultPageText(),
    );
  }
  const lessonStore =
    notes && "getBenchmarkRun" in notes
      ? (await import("../learning/forecast-bridge")).forecastLessonsFor(
          notes as unknown as import("../persistence/database").MarinaDB,
          { env },
        )
      : undefined;
  const { recallForecastLessons } = await import("../forecast/lessons");
  const lessonMode =
    env.MARINA_ARENA_FORMATION_LESSONS === "on"
      ? "on"
      : env.MARINA_ARENA_FORMATION_LESSONS === "off"
        ? "off"
        : "observe";
  // Verification's model-judged aspect uses the research judge (same env, same default).
  const judge = stages.some((st) => st.pattern === "verification")
    ? (await import("../decisions/config")).researchJudge(
        // `jev` falls back to the world's decision backend without OpenRouter.
        env.MARINA_ARENA_RESEARCH_JUDGE?.trim() || "jev",
        env,
        env.OPENROUTER_API_KEY,
      )
    : undefined;
  // Delphi / symbiosis proposals weighed by judged support on the verified lines
  // (MARINA_ARENA_PROPOSAL_JUDGE[_MODEL]); used only when a dossier exists.
  const proposalJudge = stages.some((st) => st.pattern === "delphi" || st.pattern === "symbiosis")
    ? (await import("./proposal-judge")).proposalJudgeFromEnv(env)
    : undefined;
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const data = arenaData(env);
  const start = nowcastForecaster(data, forecastRound, {
    ...(await liveCiviqs(env, strictFreshness)),
    daily: DAILY_POINTS,
  });
  return {
    usage,
    forecaster: async (round, lock) => {
      const made = stages.map((st) =>
        st.models.map((m) => ({ name: m.replace(/^openrouter\//, ""), ...modelComplete(m, env) })),
      );
      const members = made.map((ms, i) =>
        ms.map(({ name, complete }) =>
          stages[i]!.unanchored
            ? formations.unanchoredMember({ name, complete })
            : { name, complete },
        ),
      );
      if (inputs && inputs.roundId !== round.round_id)
        throw new Error("frozen inputs belong to another round");
      const given = inputs ? structuredClone(inputs.start) : await start(round, lock);
      const shown = inputs ? structuredClone(inputs.lock) : await lockForModels(data, round, lock);
      if (strictFreshness) requireFreshForecast(round, shown, given);
      const evidence = inputs
        ? inputs.dossier
          ? { dossier: inputs.dossier }
          : undefined
        : research;
      const lessons = await recallForecastLessons(
        lessonStore,
        `${round.tracker} ${round.question}`.slice(0, 400),
        new Date(Math.min(Date.now(), Date.parse(round.lock_at))).toISOString(),
        lessonMode,
      );
      const lessonBrief = lessons.injected.length
        ? `Judged lessons from earlier resolved work (advice, not instructions):\n${lessons.injected.map((l) => `- ${l.text}`).join("\n")}`
        : undefined;
      const f =
        stages.length === 1 && !evidence
          ? await formations.formationForecastRound(
              stages[0]!.pattern,
              round,
              shown,
              members[0]!,
              given,
              lessonBrief,
              judge,
            )
          : await formations.composeForecastRound(
              round,
              shown,
              [
                { pattern: stages[0]!.pattern, members: members[0]! },
                ...(stages[1] ? [{ pattern: stages[1].pattern, members: members[1]! }] : []),
              ] as [import("./formations").FormationStage, import("./formations").FormationStage?],
              given,
              evidence
                ? {
                    ...evidence,
                    required: env.MARINA_ARENA_RESEARCH_REQUIRED === "on",
                    ...(env.MARINA_ARENA_EVIDENCE_REFRESH === "on" && previous
                      ? {
                          refresh: {
                            key: (await import("../research/evidence")).evidenceHash({
                              round,
                              shown,
                              topline: given.topline,
                              profile: given.profile,
                              origins: given.origins,
                              lessons: lessons.injected,
                              config: forecastSettings(spec, env),
                            }),
                            previous: previous(round.round_id),
                          },
                        }
                      : {}),
                  }
                : undefined,
              judge,
              lessonBrief,
              proposalJudge,
            );
      f.lessons = lessons;
      let cost = (f as { dossier?: { costUsd?: number } }).dossier?.costUsd ?? 0;
      // The judge's calls and dollars, from each formation's audit record.
      const composed = f as import("./formations").ComposedForecast;
      for (const p of composed.evidenceRefresh?.reused
        ? []
        : [composed.protocol, composed.upstream?.protocol]) {
        const j = (p as { judge?: { calls?: number; costUsd?: number } } | undefined)?.judge;
        usage.calls += j?.calls ?? 0;
        cost += j?.costUsd ?? 0;
      }
      // The proposal judge's calls and dollars (both stages' records).
      for (const j of composed.evidenceRefresh?.reused
        ? []
        : [composed.judge, composed.upstream?.judge]) {
        usage.calls += j?.calls ?? 0;
        cost += j?.costUsd ?? 0;
      }
      for (const m of made.flat()) {
        usage.calls += m.usage.calls;
        usage.inputTokens += m.usage.inputTokens;
        usage.outputTokens += m.usage.outputTokens;
        cost += m.usage.costUsd;
      }
      usage.costUsd += cost;
      return composed.evidenceRefresh?.reused ||
        cost > 0 ||
        made.flat().some((m) => m.usage.calls > 0)
        ? { ...f, costUsd: cost }
        : f;
    },
  };
}

/** Everything a submission needs, or the reason it can't happen. */
export function arenaDeps(
  store: ArenaStore,
  env: NodeJS.ProcessEnv = process.env,
): SubmitDeps | { error: string } {
  let config: ArenaConfig | undefined;
  try {
    config = arenaConfigFromEnv(env);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!config) return { error: "Arena participation is off (MARINA_ARENA_ENTRANT unset)." };
  if (!config.keyFile) return { error: "MARINA_ARENA_KEY_FILE is not set." };
  try {
    return { config, data: dataFor(config), store, key: loadArenaKey(config.keyFile) };
  } catch (err) {
    return { error: `Signing key: ${(err as Error).message}` };
  }
}

/** `arenaDeps` plus the configured forecaster (baseline unless MARINA_ARENA_FORECASTER names a model). */
export async function arenaDepsWithForecaster(
  store: ArenaStore,
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
  weightOverride?: number,
): Promise<SubmitDeps | { error: string }> {
  const deps = arenaDeps(store, env);
  if ("error" in deps) return deps;
  try {
    const spec = override ?? deps.config.forecaster;
    const weight = weightOverride ?? deps.config.modelWeight;
    // The world's notes are the crew's memory when the store carries them.
    const notes = "getNotesByType" in store ? (store as unknown as NotesStore) : undefined;
    const settings = forecastSettings(spec, env, weight);
    const { forecaster } = await forecasterFor(spec, {
      weight,
      env,
      strictFreshness: true,
      ...(notes ? { notes } : {}),
      routeEvidence: async () => {
        const { loadRouteEvidence } = await import("./earned-routes");
        return loadRouteEvidence(store, deps.data, deps.config.entrant);
      },
      previous: (roundId) => {
        const row = store.acceptedArenaSubmission(deps.config.entrant, roundId);
        if (!row) return undefined;
        try {
          const detail = JSON.parse(row.detail);
          return detail.config?.fingerprint === settings.fingerprint ? detail.forecast : undefined;
        } catch {
          return undefined;
        }
      },
    });
    return {
      ...deps,
      forecaster,
      strictFreshness: true,
      forecasterConfig: { ...settings, inputFreshness: "required-v1" },
    };
  } catch (err) {
    return { error: `Forecaster: ${(err as Error).message}` };
  }
}

/** Read-only data access (works without a key: browsing and dry runs need none). */
export function arenaData(env: NodeJS.ProcessEnv = process.env): ArenaData {
  let url = env.MARINA_ARENA_DATA_URL?.trim() || DEFAULT_ARENA_DATA_URL;
  try {
    url = arenaConfigFromEnv(env)?.dataUrl ?? url;
  } catch {
    // A bad entrant id doesn't stop reading public data.
  }
  return dataFor({ dataUrl: url } as ArenaConfig);
}

let running = false;

/**
 * Hourly: file every round inside the window that has no accepted forecast.
 * Serial and non-reentrant; a failure on one round never stops the others.
 */
/** The alert surface the filing watch writes to (a slice of the world DB). */
export interface FilingWatchAlerts {
  upsertOperationalAlert: MarinaDB["upsertOperationalAlert"];
  resolveOperationalAlertsExcept: MarinaDB["resolveOperationalAlertsExcept"];
}

/**
 * One pass of the arena filing watch (`arena-filing-watch` tick job): read the
 * open rounds, check the filings of those locking within 24 h
 * (`filingFindings`), and keep one operational alert per round in trouble
 * (category `arena-filing`; the rest are resolved). Read-only toward the
 * arena: it never files. Off when no entrant is configured.
 */
export async function runArenaFilingWatch(
  store: ArenaStore & FilingWatchAlerts,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<FilingWatchResult | undefined> {
  const status = arenaStatus(env);
  let config: ArenaConfig | undefined;
  try {
    config = arenaConfigFromEnv(env);
  } catch {
    config = undefined;
  }
  if (!status.configured || !status.entrant || !config) {
    store.resolveOperationalAlertsExcept(FILING_ALERT_CATEGORY, []);
    return undefined;
  }
  const entrant = status.entrant;
  let result: FilingWatchResult;
  try {
    const rounds = await dataFor(config).openRounds(now);
    const watched = rounds.filter((r) => {
      const h = (Date.parse(r.lock_at) - now) / 3_600_000;
      return h > 0 && h <= WATCH_WINDOW_HOURS;
    }).length;
    result = { checkedAt: now, watched, findings: filingFindings(rounds, store, entrant, now) };
  } catch (err) {
    result = { checkedAt: now, watched: 0, findings: [], error: getErrorMessage(err) };
  }
  recordFilingWatch(result);
  const keys: string[] = [];
  for (const f of result.findings) {
    const key = `${FILING_ALERT_CATEGORY}:${f.roundId}`;
    keys.push(key);
    store.upsertOperationalAlert({
      key,
      severity: f.severity,
      category: FILING_ALERT_CATEGORY,
      title: `Arena round ${f.roundId}: ${f.problem.replace(/-/g, " ")}`,
      detail: f.detail,
      remedy: `Check the operator's arena runner, then refile: bun run arena submit ${f.roundId} --replace`,
      deadlineAt: Date.parse(f.lockAt),
      metadata: { roundId: f.roundId, problem: f.problem, entrant },
    });
  }
  if (result.error) {
    const key = `${FILING_ALERT_CATEGORY}:rounds-unreadable`;
    keys.push(key);
    store.upsertOperationalAlert({
      key,
      severity: "warning",
      category: FILING_ALERT_CATEGORY,
      title: "Arena filing watch could not read the open rounds",
      detail: result.error.slice(0, 300),
      remedy: "Check network access to the arena data source (MARINA_ARENA_DATA_URL).",
    });
  }
  store.resolveOperationalAlertsExcept(FILING_ALERT_CATEGORY, keys);
  return result;
}

/** Operational-alert category of the filing watch. */
export const FILING_ALERT_CATEGORY = "arena-filing";
/**
 * A round's lock time (epoch ms) from the public arena data, for schedule
 * deadline references (`before:arena:<round> lead:1h`). Needs no entrant.
 */
export async function arenaRoundLockAt(
  roundId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  const url = env.MARINA_ARENA_DATA_URL?.trim() || DEFAULT_ARENA_DATA_URL;
  if (roundDataCache?.url !== url) roundDataCache = { url, data: new ArenaData(url) };
  const round = await roundDataCache.data.round(roundId);
  return round ? Date.parse(round.lock_at) : undefined;
}
let roundDataCache: { url: string; data: ArenaData } | undefined;

export async function runArenaAutopilot(
  store: ArenaStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubmitOutcome[]> {
  const status = arenaStatus(env);
  if (!status.autopilot || running) return [];
  // Claimed BEFORE the first await: two overlapping calls must never both
  // pass the check while the first is still resolving its dependencies.
  running = true;
  const outcomes: SubmitOutcome[] = [];
  try {
    const deps = await arenaDepsWithForecaster(store, env);
    if ("error" in deps) {
      logger.warn("arena", "autopilot skipped", { error: deps.error });
      return [];
    }
    // Every accepted filing resolves on the one outcome path, whatever the
    // forecaster: scored, learned and added to the forecast history.
    if ("getForecastAnswerByExternalId" in store) {
      await resolveArenaFilings(store as unknown as MarinaDB, deps).catch((err) =>
        logger.warn("arena", "resolving filings failed", { error: getErrorMessage(err) }),
      );
    }
    if (deps.config.forecaster.startsWith("crew:") && "getNotesByType" in store) {
      await learnFromResolutions(store as unknown as ArenaStore & NotesStore, deps);
    }
    for (const round of await dueRounds(deps)) {
      const outcome = await submitRound(deps, round.round_id);
      outcomes.push(outcome);
      const detail = "reason" in outcome ? outcome.reason : undefined;
      if (outcome.kind === "accepted") {
        logger.info("arena", `filed ${round.round_id}`, { entrant: deps.config.entrant });
      } else {
        logger.warn("arena", `did not file ${round.round_id}: ${outcome.kind}`, { detail });
      }
    }
  } finally {
    running = false;
  }
  return outcomes;
}

/**
 * File every accepted submission on the outcome path (`src/outcomes/`) and
 * resolve it once the arena publishes its value — numbers by CRPS, profiles
 * and rankings by the arena's own scorers (`settle.ts`), each naming its
 * family and method. Idempotent: a filed answer is filed once and settled
 * once. Returns how many resolved now.
 */
export async function resolveArenaFilings(
  db: MarinaDB,
  deps: Pick<SubmitDeps, "config" | "data">,
): Promise<number> {
  const { settleArenaFilings } = await import("./settle");
  const owner = `marina:arena/${deps.config.entrant}`;
  const report = await settleArenaFilings(db, deps, {
    onSettled: ({ roundId, answerId }) => {
      const row = answerId ? db.acceptedArenaSubmission(deps.config.entrant, roundId) : undefined;
      if (row && answerId) linkArenaAdvice(db, owner, row, answerId);
    },
  });
  return report.settled;
}

/** Attribute only the exact filed version. An advisory opinion is not an outcome. */
function linkArenaAdvice(
  db: MarinaDB,
  owner: string,
  row: import("../persistence/db-arena").ArenaSubmissionRow,
  answerId: number,
): void {
  try {
    const answer = db.getForecastAnswer(answerId);
    if (!answer || JSON.parse(answer.answer_json).submissionId !== row.id) return;
    const outcome = db.getOutcomeBySubject(`forecast:${answerId}`);
    if (!outcome) return;
    const detail = JSON.parse(row.detail);
    const rounds = detail.forecast?.dossier?.researchLoop?.rounds ?? [];
    for (const round of rounds) {
      const receipt = round.advice as import("../sdk/decision-receipt").DecisionReceipt | undefined;
      if (!receipt?.id || receipt.family !== "research") continue;
      db.recordDecisionReceipt(owner, `forecast:${answerId}`, receipt);
      db.linkDecisionOutcome(owner, receipt.id, outcome.id);
    }
  } catch (error) {
    logger.warn("arena", "advisory outcome attribution unavailable", {
      error: getErrorMessage(error),
    });
  }
}

/**
 * Close the crew's loop live: for every round Marina filed that the arena has
 * since resolved, write the lesson once (a lesson names its round, so a second
 * pass finds it and skips).
 */
export async function learnFromResolutions(
  store: ArenaStore & NotesStore,
  deps: Pick<SubmitDeps, "config" | "data">,
): Promise<number> {
  const { learn, crewLessonOutcome, CREW_ENTITY } = await import("./crew");
  const resolved = await deps.data.resolutions();
  const known = new Set(
    store
      .getNotesByType(CREW_ENTITY, "lesson", 1000)
      .map((n) => n.content.split(" ")[1]?.replace(/:$/, "")),
  );
  let written = 0;
  for (const row of store.listArenaSubmissions({ entrant: deps.config.entrant, limit: 500 })) {
    const value = resolved[row.round_id]?.value;
    if (row.status !== "accepted" || typeof value !== "number" || known.has(row.round_id)) continue;
    const body = JSON.parse(row.body) as { topline?: { mean: number; sd: number } };
    const round = await deps.data.round(row.round_id);
    if (!body.topline || !round) continue;
    const summary = learn(store, round, await deps.data.lock(row.round_id), body.topline, value);
    if (summary) {
      const { noteOutcome } = await import("../learning/service");
      // resolvedAt = now: conservative, the resolution is seen live.
      noteOutcome(store, crewLessonOutcome(round, row.round_id, summary, new Date().toISOString()));
    }
    known.add(row.round_id);
    written++;
  }
  return written;
}

// ─── Wikipedia scheduled events ──────────────────────────────────────────────

/** The method key of the Wikipedia event-research card (src/arena/research/wiki-events.ts). */
export const WIKI_EVENTS = "research:wiki-events";

/**
 * `research:wiki-events:<model>[@<retriever>[,<retriever>…]]`: the recency
 * list plus mechanically verified scheduled events (one extraction call to
 * `<model>`; retrievers as in `research:`, else MARINA_ARENA_RESEARCH_RETRIEVER).
 * Any other round shape gets the nowcast, so the spec is safe on a route.
 */
async function wikiEventsForecasterFor(
  spec: string,
  env: NodeJS.ProcessEnv,
  strictFreshness = false,
): Promise<{ forecaster: Forecaster; usage?: Usage }> {
  const [{ modelComplete }, retrieve, events, nowcast, { guardedFetch }] = await Promise.all([
    import("./model-backend"),
    import("./research/retrieve"),
    import("./research/wiki-events"),
    import("./research/civiqs-nowcast"),
    import("../net/url-guard"),
  ]);
  const rest = spec.slice(`${WIKI_EVENTS}:`.length);
  const at = rest.indexOf("@");
  const model = at < 0 ? rest : rest.slice(0, at);
  const orKey = env.OPENROUTER_API_KEY;
  const retrieverSpec =
    (at < 0 ? "" : rest.slice(at + 1)).trim() ||
    env.MARINA_ARENA_RESEARCH_RETRIEVER?.trim() ||
    (env.TAVILY_API_KEY?.trim() ? "tavily:basic" : "search:duckduckgo");
  const retriever = retrieve.retrieverFromSpec(
    retrieverSpec,
    {
      ...(orKey ? { openrouter: orKey } : {}),
      ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
      ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
    },
    { env },
  );
  const made = modelComplete(model, env);
  let retrievalUsd = 0;
  const usage: Usage = {
    get calls() {
      return made.usage.calls;
    },
    get inputTokens() {
      return made.usage.inputTokens;
    },
    get outputTokens() {
      return made.usage.outputTokens;
    },
    get costUsd() {
      return made.usage.costUsd + retrievalUsd;
    },
  };
  const wiki = events.wikimediaApi(async (url) => {
    const res = await guardedFetch(url, {
      headers: { "User-Agent": "Marina-arena/1.0 (https://github.com/h2oai/marina)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
    return res.json();
  });
  const raw = Number.parseInt(env.MARINA_ARENA_WIKI_EVENTS_MAX_INSERT ?? "", 10);
  const maxInsert = Number.isFinite(raw) && raw >= 0 ? raw : events.DEFAULT_MAX_INSERT;
  const data = arenaData(env);
  const fallback = nowcast.nowcastForecaster(data, forecastRound, {
    ...(await liveCiviqs(env, strictFreshness)),
  });
  return {
    usage,
    forecaster: async (round, lock) => {
      if (round.target_type !== "ranking_list" || round.tracker !== "wikipedia")
        return fallback(round, lock);
      const obs = await nowcast.wikitopObservations(data, round);
      const inputs = obs.length ? { ...lock, answer_obs: obs } : lock;
      const result = await events.wikiEventsRanking(round, inputs, {
        retriever,
        complete: made.complete,
        wiki,
        maxInsert,
      });
      retrievalUsd += result.costUsd;
      const verified = result.events.filter((e) => e.verified);
      const moved = verified.filter((e) => e.action && e.action !== "none").length;
      const f = {
        ranking: result.ranking,
        rules: {},
        note: `marina wiki-events research (${model.replace(/^openrouter\//, "")}): recency-weighted pageviews (half-life 3 d) + ${moved} verified scheduled event(s) of ${result.events.length} proposed from ${result.sources} source(s)`,
        wikiEvents: {
          base: result.base,
          events: result.events,
          read: result.read,
          retriever: retrieverSpec,
          retrievalUsd: result.costUsd,
        },
      };
      return strictFreshness
        ? requireFreshForecast(round, inputs, f, forecastCutoff(round.lock_at))
        : f;
    },
  };
}

// ─── Research agent + shadow mode ────────────────────────────────────────────

/**
 * `research:<analyst>[,<analyst>…][@<retriever>[,<retriever>…]]` (up to eight
 * analysts, one vendor each). Retrieval is the spec's `@` list, else
 * `MARINA_ARENA_RESEARCH_RETRIEVER` (default `openrouter-web:google/gemini-3.1-pro-preview`;
 * `sonar:<perplexity model>` and `tavily:<basic|advanced>` too, several
 * comma-separated and merged; page text a retriever fetched is used for the
 * citation check instead of re-fetching),
 * the judge `MARINA_ARENA_RESEARCH_JUDGE` (`jev` — jev-1.13 through OpenRouter's
 * Decisions API — by default when an OpenRouter key is set; `decisions` for the
 * world's configured backend, falling back to `jev`; `none` for equal weights), the cap on the move taken `MARINA_ARENA_RESEARCH_TRUST` (0.5).
 */
async function researchForecasterFor(
  spec: string,
  env: NodeJS.ProcessEnv,
  strictFreshness = false,
  notes?: NotesStore,
): Promise<{ forecaster: Forecaster; usage?: Usage }> {
  const [{ modelComplete }, research, retrieve, decisions] = await Promise.all([
    import("./model-backend"),
    import("./research/forecaster"),
    import("./research/retrieve"),
    import("../decisions/config"),
  ]);
  const orKey = env.OPENROUTER_API_KEY;
  // `research:<analysts>[@<retrievers>]` — retrievers in the spec win over the env.
  const researchSpec = spec.slice("research:".length);
  const separator = researchSpec.indexOf("@");
  const analystsPart = separator < 0 ? researchSpec : researchSpec.slice(0, separator);
  const specRetrievers = separator < 0 ? undefined : researchSpec.slice(separator + 1);
  // Default: OpenRouter web search with a key, else Tavily, else keyless
  // date-bounded search — research never needs a vendor key.
  const retrieverSpec =
    specRetrievers?.trim() ||
    env.MARINA_ARENA_RESEARCH_RETRIEVER?.trim() ||
    (orKey
      ? "openrouter-web:google/gemini-3.1-pro-preview"
      : env.TAVILY_API_KEY?.trim()
        ? "tavily:basic"
        : "asof");
  const { defaultPageText } = await import("./research/verify");
  // Page text a retriever already fetched (Tavily) is checked in place of a fetch.
  const { arenaResearchLookups, arenaSignalHints, withDataLookups } = await import(
    "./research/data-evidence"
  );
  const { researchRetriever } = await import("../research/retriever");
  const { retriever, pageText } = retrieve.withProvidedText(
    researchRetriever(
      withDataLookups(
        retrieve.retrieverFromSpec(
          retrieverSpec,
          {
            ...(orKey ? { openrouter: orKey } : {}),
            ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
            ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
          },
          { env },
        ),
        arenaResearchLookups(env),
        { hints: arenaSignalHints(env) },
      ),
      env,
      analystsPart.split(",")[0],
    ),
    defaultPageText(),
  );
  const models = analystsPart.split(",");
  const made = models.map((m) => ({
    name: m.replace(/^openrouter\//, ""),
    ...modelComplete(m, env),
  }));
  const judge = decisions.researchJudge(
    // `jev` falls back to the world's decision backend without OpenRouter.
    env.MARINA_ARENA_RESEARCH_JUDGE?.trim() || "jev",
    env,
    orKey,
  );
  const trustCap = Number(env.MARINA_ARENA_RESEARCH_TRUST ?? 0.5);
  // Structured evidence first: the research agent starts from the Civiqs nowcast.
  const { nowcastForecaster } = await import("./research/civiqs-nowcast");
  const data = arenaData(env);
  const nowcast = nowcastForecaster(data, forecastRound, {
    ...(await liveCiviqs(env, strictFreshness)),
    daily: DAILY_POINTS,
  });
  // The judged lesson pool, read as the formation forecaster reads it:
  // MARINA_ARENA_RESEARCH_LESSONS=on injects, observe (default) records only, off skips.
  const lessonStore =
    notes && "getBenchmarkRun" in notes
      ? (await import("../learning/forecast-bridge")).forecastLessonsFor(
          notes as unknown as import("../persistence/database").MarinaDB,
          { env },
        )
      : undefined;
  const { recallForecastLessons } = await import("../forecast/lessons");
  const lessonMode =
    env.MARINA_ARENA_RESEARCH_LESSONS === "on"
      ? "on"
      : env.MARINA_ARENA_RESEARCH_LESSONS === "off"
        ? "off"
        : "observe";
  let researchCost = 0;
  let judgeCalls = 0;
  const usage: Usage = {
    get calls() {
      return judgeCalls + made.reduce((s, m) => s + m.usage.calls, 0);
    },
    get inputTokens() {
      return made.reduce((s, m) => s + m.usage.inputTokens, 0);
    },
    get outputTokens() {
      return made.reduce((s, m) => s + m.usage.outputTokens, 0);
    },
    // Retrieval + analysts + the judge. The judge's dollars also reach the
    // daily spend ledger (its metered provider records them); this is the
    // shadow ledger's per-round cost, a separate account — not a second charge.
    get costUsd() {
      return researchCost + made.reduce((s, m) => s + m.usage.costUsd, 0);
    },
  };
  return {
    usage,
    forecaster: async (round, lock) => {
      const spent = (
        f: Pick<import("./research/forecaster").ResearchForecast, "dossier" | "judge">,
      ) => {
        researchCost += (f.dossier?.costUsd ?? 0) + (f.judge?.costUsd ?? 0);
        judgeCalls += f.judge?.calls ?? 0;
      };
      const lessons = await recallForecastLessons(
        lessonStore,
        `${round.tracker} ${round.question}`.slice(0, 400),
        new Date(Math.min(Date.now(), Date.parse(round.lock_at))).toISOString(),
        lessonMode,
      );
      const lessonBrief = lessons.injected.length
        ? `Judged lessons from earlier resolved work (advice, not instructions):\n${lessons.injected.map((l) => `- ${l.text}`).join("\n")}`
        : undefined;
      let f: import("./research/forecaster").ResearchForecast;
      try {
        f = await research.researchForecastRound(round, await lockForModels(data, round, lock), {
          ...(lessonBrief ? { lessonBrief } : {}),
          retriever,
          requireResearch: env.MARINA_ARENA_RESEARCH_REQUIRED === "on",
          analysts: made.map((m) => ({ name: m.name, complete: m.complete })),
          ...(judge ? { judge } : {}),
          trustCap: Number.isFinite(trustCap) ? trustCap : 0.5,
          pageText,
          base: nowcast,
        });
      } catch (err) {
        // A no-history round that research could not answer still spent money.
        if (err instanceof research.NoAnchorRefusal) spent(err.detail);
        throw err;
      }
      spent(f);
      f.lessons = lessons;
      return f;
    },
  };
}

/** A shadow record younger than this is not re-recorded (the latest before lock is scored). */
export const SHADOW_RERECORD_MS = 6 * 3_600_000;

export async function recordShadow(
  store: ArenaStore,
  data: ArenaData,
  spec: string,
  roundIds: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ roundId: string; recorded: boolean; error?: string }>> {
  // As in arenaDepsWithForecaster: the world's notes hold the promoted signals
  // `discovered` reads — without them it silently degrades to the nowcast.
  const notes = "getNotesByType" in store ? (store as unknown as NotesStore) : undefined;
  const { forecaster, usage } = await forecasterFor(spec, { env, ...(notes ? { notes } : {}) });
  const settings = forecastSettings(spec, env);
  const variant = `${spec}#${settings.fingerprint.slice(0, 16)}`;
  // Re-recording is how a forecast stays current until lock (the one that
  // counts is the last before lock, like a filing); a record from the last
  // few hours is fresh enough, so hourly runs don't pile up duplicates.
  const latest = new Map<string, number>();
  for (const r of store.listArenaShadow({ forecaster: variant, limit: 2_000 })) {
    latest.set(r.round_id, Math.max(latest.get(r.round_id) ?? 0, r.created_at));
  }
  const now = Date.now();
  const out: Array<{ roundId: string; recorded: boolean; error?: string }> = [];
  for (const roundId of roundIds) {
    const last = latest.get(roundId);
    if (last !== undefined && now - last < SHADOW_RERECORD_MS) {
      out.push({
        roundId,
        recorded: false,
        error: `recorded ${Math.round((now - last) / 60_000)} min ago; the latest record before lock is the one scored`,
      });
      continue;
    }
    try {
      const round = await data.round(roundId);
      if (!round) throw new Error("no such round");
      if (Date.parse(round.lock_at) <= Date.now()) throw new Error("already locked");
      const before = usage?.costUsd ?? 0;
      const f = (await forecaster(round, await data.lock(roundId))) as unknown as Record<
        string,
        unknown
      >;
      const { topline, profile, ranking, rules: _rules, note: _note, ...detail } = f;
      if (Date.parse(round.lock_at) <= Date.now()) throw new Error("forecast finished after lock");
      const recorded = store.recordArenaShadow({
        roundId,
        forecaster: variant,
        forecast: JSON.stringify({ topline, profile, ranking }),
        detail: JSON.stringify({ ...detail, settings }),
        costUsd: (usage?.costUsd ?? 0) - before,
      });
      out.push({ roundId, recorded });
    } catch (err) {
      out.push({ roundId, recorded: false, error: (err as Error).message });
    }
  }
  return out;
}

let shadowRunning = false;

/**
 * Hourly (`MARINA_ARENA_SHADOW=<spec>`): record a shadow forecast for every
 * round inside the filing window. Needs no entrant or key — shadow runs
 * collect evidence before (and independently of) a registration.
 */
export async function runArenaShadow(
  store: ArenaStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const raw = env.MARINA_ARENA_SHADOW?.trim();
  if (!raw || shadowRunning) return 0;
  shadowRunning = true;
  try {
    const { arenaWindowHours, parseForecasterSpec } = await import("./config");
    const spec = parseForecasterSpec(raw);
    const data = arenaData(env);
    const horizon = Date.now() + arenaWindowHours(env) * 3_600_000;
    const due = (await data.openRounds())
      .filter((r) => Date.parse(r.lock_at) <= horizon)
      .map((r) => r.round_id);
    const results = await recordShadow(store, data, spec, due, env);
    const recorded = results.filter((r) => r.recorded).length;
    if (recorded) logger.info("arena", `shadow ${spec}: recorded ${recorded} round(s)`);
    return recorded;
  } catch (err) {
    logger.warn("arena", "shadow run failed", { error: (err as Error).message });
    return 0;
  } finally {
    shadowRunning = false;
  }
}
