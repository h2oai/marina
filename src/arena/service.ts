// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place the command, the hourly autopilot and readiness read arena
 * state from. Config is re-read from the environment on every call (cheap), so
 * a key rotation or an autopilot switch takes effect without a restart.
 */

import { Logger } from "../engine/logger";
import type { ArenaStore } from "../persistence/interfaces/arena-store";
import type { NotesStore } from "../persistence/interfaces/notes-store";
import { type ArenaConfig, arenaConfigFromEnv, loadArenaKey } from "./config";
import { ArenaData, DEFAULT_ARENA_DATA_URL } from "./data";
import type { Forecaster, Learner } from "./evaluate";
import { forecastRound } from "./forecast";
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
 * The forecaster a spec names: the calibrated baseline, or a model shrunk toward
 * it. The model stack is imported only when a model is actually asked for.
 * `raw: true` returns the model's own answer (for shadow scoring), not the blend.
 */
/** Live Civiqs reads for open rounds (on unless MARINA_ARENA_CIVIQS_LIVE=off). */
async function liveCiviqs(env: NodeJS.ProcessEnv = process.env) {
  const { civiqsLiveEnabled, fetchCiviqsLive } = await import("./research/civiqs-live");
  return civiqsLiveEnabled(env)
    ? { live: (n: string, f?: Record<string, string>) => fetchCiviqsLive(n, f) }
    : {};
}

export async function forecasterFor(
  spec: string,
  opts: { weight?: number; raw?: boolean; env?: NodeJS.ProcessEnv; notes?: NotesStore } = {},
): Promise<{ forecaster: Forecaster; usage?: Usage; learner?: Learner }> {
  if (spec === "baseline") return { forecaster: baselineForecaster };
  if (spec === "discovered") {
    // Each family's best PROMOTED signal (arena discover), else the nowcast.
    const [{ nowcastForecaster }, loop, signals] = await Promise.all([
      import("./research/civiqs-nowcast"),
      import("./discovery/loop"),
      import("./discovery/signals"),
    ]);
    const data = arenaData(opts.env ?? process.env);
    const fallback = nowcastForecaster(data, forecastRound, await liveCiviqs(opts.env));
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
        await liveCiviqs(opts.env),
      ),
    };
  }
  if (spec.startsWith("research:")) {
    return researchForecasterFor(spec, opts.env ?? process.env);
  }
  if (spec.startsWith("formation:")) {
    return formationForecasterFor(spec, opts.env ?? process.env);
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
    // Start from the nowcast (fresher than the weekly history for Civiqs; the
    // baseline elsewhere), exactly as the research agent does.
    const { nowcastForecaster } = await import("./research/civiqs-nowcast");
    const start = nowcastForecaster(arenaData(env), forecastRound, {
      ...(await liveCiviqs(env)),
      daily: DAILY_POINTS,
    });
    return {
      usage,
      forecaster: async (round, lock) =>
        crew.crewForecastRound(round, lock, members, notes, await start(round, lock)),
      ...(notes
        ? {
            learner: (round, lock, filed, outcome) =>
              crew.learn(notes, round, lock, filed, outcome),
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
    ...(await liveCiviqs(env)),
    daily: DAILY_POINTS,
  });
  return {
    usage,
    forecaster: async (round, lock) =>
      modelForecastRound(round, lock, await start(round, lock), complete, options, modelSpec),
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
): Promise<{ forecaster: Forecaster; usage: Usage }> {
  const [head = "", ...parts] = spec.split("+");
  const [{ modelComplete }, formations, { nowcastForecaster }] = await Promise.all([
    import("./model-backend"),
    import("./formations"),
    import("./research/civiqs-nowcast"),
  ]);
  const stageOf = (text: string) => {
    const [, name = "", list = ""] = text.match(/^(?:formation|then):([a-z]+):(.+)$/i) ?? [];
    const pattern = formations.formationPattern(name);
    if (!pattern) throw new Error(`unknown formation ${name}`);
    const models = list.split(",");
    // Fail fast on a missing provider key, before any round runs.
    for (const m of models) modelComplete(m, env);
    return { pattern, models };
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
  if (researchPart) {
    const [retrieve, { defaultPageText }] = await Promise.all([
      import("./research/retrieve"),
      import("./research/verify"),
    ]);
    const orKey = env.OPENROUTER_API_KEY;
    research = retrieve.withProvidedText(
      retrieve.retrieverFromSpec(researchPart.slice("research@".length), {
        ...(orKey ? { openrouter: orKey } : {}),
        ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
      }),
      defaultPageText(),
    );
  }
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const start = nowcastForecaster(arenaData(env), forecastRound, {
    ...(await liveCiviqs(env)),
    daily: DAILY_POINTS,
  });
  return {
    usage,
    forecaster: async (round, lock) => {
      const made = stages.map((st) =>
        st.models.map((m) => ({ name: m.replace(/^openrouter\//, ""), ...modelComplete(m, env) })),
      );
      const members = made.map((ms) => ms.map(({ name, complete }) => ({ name, complete })));
      const given = await start(round, lock);
      const f =
        stages.length === 1 && !research
          ? await formations.formationForecastRound(
              stages[0]!.pattern,
              round,
              lock,
              members[0]!,
              given,
            )
          : await formations.composeForecastRound(
              round,
              lock,
              [
                { pattern: stages[0]!.pattern, members: members[0]! },
                ...(stages[1] ? [{ pattern: stages[1].pattern, members: members[1]! }] : []),
              ] as [import("./formations").FormationStage, import("./formations").FormationStage?],
              given,
              research,
            );
      let cost = (f as { dossier?: { costUsd?: number } }).dossier?.costUsd ?? 0;
      for (const m of made.flat()) {
        usage.calls += m.usage.calls;
        usage.inputTokens += m.usage.inputTokens;
        usage.outputTokens += m.usage.outputTokens;
        cost += m.usage.costUsd;
      }
      usage.costUsd += cost;
      return cost > 0 || made.flat().some((m) => m.usage.calls > 0) ? { ...f, costUsd: cost } : f;
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
    const { forecaster } = await forecasterFor(spec, { weight, env, ...(notes ? { notes } : {}) });
    return { ...deps, forecaster };
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
export async function runArenaAutopilot(
  store: ArenaStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubmitOutcome[]> {
  const status = arenaStatus(env);
  if (!status.autopilot || running) return [];
  const deps = await arenaDepsWithForecaster(store, env);
  if ("error" in deps) {
    logger.warn("arena", "autopilot skipped", { error: deps.error });
    return [];
  }
  running = true;
  const outcomes: SubmitOutcome[] = [];
  try {
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
 * Close the crew's loop live: for every round Marina filed that the arena has
 * since resolved, write the lesson once (a lesson names its round, so a second
 * pass finds it and skips).
 */
export async function learnFromResolutions(
  store: ArenaStore & NotesStore,
  deps: Pick<SubmitDeps, "config" | "data">,
): Promise<number> {
  const { learn, CREW_ENTITY } = await import("./crew");
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
    learn(store, round, await deps.data.lock(row.round_id), body.topline, value);
    known.add(row.round_id);
    written++;
  }
  return written;
}

// ─── Research agent + shadow mode ────────────────────────────────────────────

/**
 * `research:<analyst>[,<analyst>…][@<retriever>[,<retriever>…]]` (up to eight
 * analysts, one vendor each). Retrieval is the spec's `@` list, else
 * `MARINA_ARENA_RESEARCH_RETRIEVER` (default `openrouter-web:openai/gpt-6-luna`;
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
): Promise<{ forecaster: Forecaster; usage?: Usage }> {
  const [{ modelComplete }, research, retrieve, decisions] = await Promise.all([
    import("./model-backend"),
    import("./research/forecaster"),
    import("./research/retrieve"),
    import("../decisions/config"),
  ]);
  const orKey = env.OPENROUTER_API_KEY;
  // `research:<analysts>[@<retrievers>]` — retrievers in the spec win over the env.
  const [analystsPart = "", specRetrievers] = spec.slice("research:".length).split("@");
  const retrieverSpec =
    specRetrievers?.trim() ||
    env.MARINA_ARENA_RESEARCH_RETRIEVER?.trim() ||
    "openrouter-web:openai/gpt-6-luna";
  const { defaultPageText } = await import("./research/verify");
  // Page text a retriever already fetched (Tavily) is checked in place of a fetch.
  const { retriever, pageText } = retrieve.withProvidedText(
    retrieve.retrieverFromSpec(retrieverSpec, {
      ...(orKey ? { openrouter: orKey } : {}),
      ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
    }),
    defaultPageText(),
  );
  const models = analystsPart.split(",");
  const made = models.map((m) => ({
    name: m.replace(/^openrouter\//, ""),
    ...modelComplete(m, env),
  }));
  const judge = decisions.researchJudge(
    env.MARINA_ARENA_RESEARCH_JUDGE?.trim() || (orKey ? "jev" : "none"),
    env,
    orKey,
  );
  const trustCap = Number(env.MARINA_ARENA_RESEARCH_TRUST ?? 0.5);
  // Structured evidence first: the research agent starts from the Civiqs nowcast.
  const { nowcastForecaster } = await import("./research/civiqs-nowcast");
  const nowcast = nowcastForecaster(arenaData(env), forecastRound, {
    ...(await liveCiviqs(env)),
    daily: DAILY_POINTS,
  });
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
      const f = await research.researchForecastRound(round, lock, {
        retriever,
        analysts: made.map((m) => ({ name: m.name, complete: m.complete })),
        ...(judge ? { judge } : {}),
        trustCap: Number.isFinite(trustCap) ? trustCap : 0.5,
        pageText,
        base: nowcast,
      });
      researchCost += (f.dossier?.costUsd ?? 0) + (f.judge?.costUsd ?? 0);
      judgeCalls += f.judge?.calls ?? 0;
      return f;
    },
  };
}

/** Record what `spec` would file for each round (first record per round wins). */
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
  // Re-recording is how a forecast stays current until lock (the one that
  // counts is the last before lock, like a filing); a record from the last
  // few hours is fresh enough, so hourly runs don't pile up duplicates.
  const latest = new Map<string, number>();
  for (const r of store.listArenaShadow({ forecaster: spec, limit: 2_000 })) {
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
      const recorded = store.recordArenaShadow({
        roundId,
        forecaster: spec,
        forecast: JSON.stringify({ topline, profile, ranking }),
        detail: JSON.stringify(detail),
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
