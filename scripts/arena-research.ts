#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Explicit, checkpointed research qualification. Never signs or submits. */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mergeCalibrationHistory } from "../src/arena/calibration-history";
import { forecastRound } from "../src/arena/forecast";
import { buildDossier } from "../src/arena/formations";
import { requireFreshForecast } from "../src/arena/freshness";
import { portfolioModels } from "../src/arena/portfolio";
import { horizonOptionsFromEnv } from "../src/arena/research/civiqs-horizon";
import { nowcastForecaster } from "../src/arena/research/civiqs-nowcast";
import {
  arenaResearchLookups,
  arenaSignalHints,
  withDataLookups,
} from "../src/arena/research/data-evidence";
import { retrieverFromSpec, withProvidedText } from "../src/arena/research/retrieve";
import { defaultPageText } from "../src/arena/research/verify";
import {
  type ExperimentAttempt,
  qualifyResearchExperiments,
  RESEARCH_ARMS,
  type ResearchExperiment,
  runResearchArm,
  scoreResearchExperiment,
  validateExperiment,
} from "../src/arena/research-experiment";
import { arenaData, lockForModels } from "../src/arena/service";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { getErrorMessage } from "../src/engine/errors";
import { SpendGuard } from "../src/engine/spend-guard";
import { dailyCapRefusal } from "../src/engine/spend-ledger";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { MarinaDB } from "../src/persistence/database";
import { evidenceHash } from "../src/research/evidence";
import { researchRetriever } from "../src/research/retriever";
import { researchFeatures } from "../src/research/settings";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    models: { type: "string" },
    retriever: { type: "string", default: "search" },
    "max-usd": { type: "string", default: "20" },
    "max-calls": { type: "string", default: "32" },
    "max-tokens": { type: "string", default: "2000" },
    "research-rounds": { type: "string", default: "2" },
    reader: { type: "string" },
    history: { type: "string" },
    "lesson-db": { type: "string" },
    arms: { type: "string", default: "A,B,C,D" },
    help: { type: "boolean" },
  },
});

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function save(path: string, value: unknown, fresh = false) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (fresh) return writeFile(path, body, { flag: "wx", mode: 0o600 });
  await writeFile(`${path}.tmp`, body, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
async function attemptsAt(dir: string): Promise<ExperimentAttempt[]> {
  return Promise.all(
    (await readdir(dir))
      .filter((f) => /^arm-[ABCDOL]\.json$/.test(f))
      .sort()
      .map((f) => json<ExperimentAttempt>(join(dir, f))),
  );
}

async function main() {
  const action = positionals[0];
  if (values.help || !action)
    return {
      usage:
        "bun run arena:research capture <round> --out <new-directory> --models <provider/model,...> [--retriever search] [--research-rounds 2] [--reader provider/model] [--history calibration.json] [--lesson-db path]; run --out <directory> [--arms A,B,C,D,O,L]; score --out <batch-directory>. Capture/run use --max-usd 20, persist each attempt, and never submit.",
    };
  if (!values.out) throw new Error("--out is required, outside the tracked source tree");
  const out = values.out;
  const data = arenaData().frozen();
  if (action === "score") {
    const resolutions = await data.resolutions();
    const dirs = await readdir(out, { withFileTypes: true });
    const roots = dirs.some((d) => d.name === "input.json")
      ? [out]
      : dirs.filter((d) => d.isDirectory()).map((d) => join(out, d.name));
    const reports = [];
    const failures = [];
    for (const root of roots) {
      try {
        const input = await json<ResearchExperiment>(join(root, "input.json"));
        reports.push(
          scoreResearchExperiment(
            input,
            await attemptsAt(root),
            resolutions[input.round.round_id] ?? {},
            new Date().toISOString(),
          ),
        );
      } catch (e) {
        failures.push({ directory: root, error: getErrorMessage(e) });
      }
    }
    const scores = reports.flatMap((r) => r.scores);
    return {
      asOf: new Date().toISOString(),
      scores,
      failures,
      qualification: qualifyResearchExperiments(scores).map((q) =>
        failures.length
          ? {
              ...q,
              status: "retain-current-strategy",
              reasons: [...q.reasons, "batch contains incomplete or unreadable captures"],
            }
          : q,
      ),
      calibrationObservations: reports.flatMap((r) => r.calibrationObservations),
      promotion: "none",
    };
  }
  const maxUsd = Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd must be positive");
  if (action !== "capture" && action !== "run") throw new Error("expected capture, run or score");
  // Persistent scope shares the cap across capture and run, including interrupted work.
  process.env.MARINA_SPEND_SCOPE = `arena-research-${evidenceHash(out).slice(0, 16)}`;
  process.env.MARINA_SPEND_SCOPE_CAP_USD = String(maxUsd);
  const close = attachCliSpendLedger("arena:research");
  try {
    if (action === "capture") {
      const id = positionals[1];
      const models =
        values.models
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      if (!id || !models.length) throw new Error("capture needs a round id and --models");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MARINA_RESEARCH_EVIDENCE: "on",
        MARINA_RESEARCH_LOOP_ROUNDS: values["research-rounds"],
        MARINA_READ_SWARM_READER: values.reader ?? "",
        MARINA_ARENA_RESEARCH_SIGNALS: "consumer",
      };
      const features = researchFeatures(env);
      await mkdir(out, { recursive: true, mode: 0o700 });
      await save(
        join(out, "capture.json"),
        { roundId: id, status: "started", at: new Date().toISOString() },
        true,
      );
      try {
        const capRefusal = dailyCapRefusal();
        if (capRefusal) throw new Error(capRefusal);
        const round = await data.round(id);
        if (round?.tracker !== "civiqs" || round.target_type !== "continuous_normal")
          throw new Error("expected a Civiqs scalar round");
        if (Date.now() >= Date.parse(round.lock_at) - 300_000)
          throw new Error("too close to lock for research capture");
        const lock = await lockForModels(data, round, await data.lock(id));
        const controlHorizon = horizonOptionsFromEnv(process.env);
        const projectedHorizon = {
          mode: "drift" as const,
          phi: 0.8,
          weeklyAnchor: true,
          series: ["civiqs_net_econ_now", "civiqs_net_econ_direction"],
        };
        const starts = {
          control: await nowcastForecaster(data, forecastRound, {
            daily: 30,
            horizon: controlHorizon,
            strictFreshness: true,
          })(round, lock),
          projected: await nowcastForecaster(data, forecastRound, {
            daily: 30,
            horizon: projectedHorizon,
            strictFreshness: true,
          })(round, lock),
        };
        // Both use the same archived snapshot. No live fetch is repeated between arms.
        requireFreshForecast(round, lock, starts.control);
        requireFreshForecast(round, lock, starts.projected);
        const keys = {
          openrouter: env.OPENROUTER_API_KEY,
          tavily: env.TAVILY_API_KEY,
          exa: env.EXA_API_KEY,
        };
        const controlRetriever = withProvidedText(
          researchRetriever(
            withDataLookups(retrieverFromSpec("closed-book", {}), arenaResearchLookups(env)),
            { ...env, MARINA_RESEARCH_LOOP_ROUNDS: "1", MARINA_READ_SWARM_READER: "" },
            undefined,
            { maxTokens: Number(values["max-tokens"]) },
          ),
          defaultPageText(),
        );
        const richRetriever = withProvidedText(
          researchRetriever(
            withDataLookups(
              retrieverFromSpec(values.retriever, keys, { env }),
              arenaResearchLookups(env),
              { hints: arenaSignalHints(env) },
            ),
            env,
            models[0],
            { maxTokens: Number(values["max-tokens"]) },
          ),
          defaultPageText(),
        );
        const dossiers = {
          control: await buildDossier(
            round,
            lock,
            starts.control,
            controlRetriever.retriever,
            controlRetriever.pageText,
          ),
          research: await buildDossier(
            round,
            lock,
            starts.control,
            richRetriever.retriever,
            richRetriever.pageText,
          ),
        };
        const capturedAt = new Date().toISOString();
        const calibrationInput = values.history
          ? await json<{ observations?: unknown } | unknown[]>(values.history)
          : [];
        const calibration = mergeCalibrationHistory(
          [Array.isArray(calibrationInput) ? calibrationInput : calibrationInput.observations],
          capturedAt,
        ).observations;
        let lessons: ResearchExperiment["lessons"] = [];
        if (values["lesson-db"]) {
          const db = new MarinaDB(values["lesson-db"]);
          try {
            lessons = await forecastLessonsFor(db, { env }).recall(round.question, capturedAt);
          } finally {
            db.close();
          }
        }
        const input = {
          version: 1 as const,
          round,
          lock,
          starts,
          dossiers,
          capturedAt,
          lessons,
          calibration,
          settings: {
            arms: values.arms.split(",") as ResearchExperiment["settings"]["arms"],
            models,
            implementation: evidenceHash(await readFile(import.meta.path, "utf8")),
            maxTokens: Number(values["max-tokens"]),
            callsPerArm: Number(values["max-calls"]),
            timeoutMs: 300_000,
            retriever: values.retriever,
            researchRounds: features.rounds,
            reader: features.reader,
            controlHorizon,
            projectedHorizon,
            captureCostUsd: dossiers.control.costUsd + dossiers.research.costUsd,
          },
        };
        const signed = { ...input, hash: evidenceHash(input) };
        validateExperiment(signed);
        await save(join(out, "input.json"), signed, true);
        if (dossiers.research.status === "failed" || !dossiers.research.verified.trim())
          throw new Error(dossiers.research.error ?? "research treatment has no verified evidence");
        await save(join(out, "capture.json"), {
          roundId: id,
          status: "complete",
          at: capturedAt,
          inputHash: signed.hash,
        });
        return {
          directory: out,
          inputHash: signed.hash,
          research: dossiers.research.status,
          costUsd: input.settings.captureCostUsd,
        };
      } catch (e) {
        await save(join(out, "capture.json"), {
          roundId: id,
          status: "failed",
          at: new Date().toISOString(),
          error: getErrorMessage(e),
        });
        throw e;
      }
    }
    const input = await json<ResearchExperiment>(join(out, "input.json"));
    validateExperiment(input);
    if (input.settings.implementation !== evidenceHash(await readFile(import.meta.path, "utf8")))
      throw new Error("experiment runner changed since capture; use the original compiled runner");
    const prior = await attemptsAt(out);
    const guard = new SpendGuard({
      label: "research experiment",
      budgetUsd: maxUsd,
      spentUsd: input.settings.captureCostUsd + prior.reduce((s, a) => s + a.costUsd, 0),
      concurrency: 3,
      minReserveUsd: 0.1,
    });
    const backend = await portfolioModels(process.env, input.settings.maxTokens);
    const complete = backend.complete;
    let accountedUsd = 0;
    const wrapped = {
      usage: backend.usage,
      complete: async (...args: Parameters<typeof complete>) => {
        const reason = guard.stopReason();
        if (reason) throw new Error(reason);
        try {
          return await complete(...args);
        } finally {
          const total = backend.usage.costUsd;
          guard.record(Math.max(0, total - accountedUsd));
          accountedUsd = total;
        }
      },
    };
    const arms = values.arms.split(",");
    if (arms.some((a) => !input.settings.arms.includes(a as never)))
      throw new Error("arm was not registered at capture");
    const results = [];
    for (const arm of RESEARCH_ARMS.filter((a) => arms.includes(a))) {
      if (prior.some((a) => a.arm === arm)) {
        results.push({ arm, status: "already recorded; no retry" });
        continue;
      }
      const path = join(out, `arm-${arm}.json`);
      const attempt = await runResearchArm(input, arm, wrapped, {
        onStart: (a) => save(path, a, true),
      });
      await save(path, attempt);
      results.push({
        arm,
        status: attempt.status,
        costUsd: attempt.costUsd,
        calls: attempt.calls,
        error: attempt.error,
      });
    }
    return { directory: out, results, promotion: "none" };
  } finally {
    close();
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (e) {
  console.error(getErrorMessage(e));
  process.exitCode = 1;
}
