#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator CLI for Marina's Social Simulation Arena entry (docs/guides/arena.md).
 *
 *   bun run arena keygen <path>                 new Ed25519 key (0600); prints the public half
 *   bun run arena registration --name N --org O --github LOGIN [--contact EMAIL] [--out FILE]
 *                                               entrants/<id>.json for the registration PR
 *   bun run arena status                        config, key, filed record
 *   bun run arena rounds                        open rounds, soonest lock first
 *   bun run arena show <round_id>               what Marina would file, and why
 *   bun run arena submit <round_id|due> [--dry-run]
 *                                               sign + file (due = every round inside the window)
 *   bun run arena backtest                      baseline skill vs the arena's persistence
 *   bun run arena research <round_id>           run the research agent once; print dossier + forecast
 *   bun run arena discover [--tracker T] [--proposer provider/model] [--n N]
 *                                               propose → backtest (time-split) → promote signals
 *   bun run arena signals [--tracker T]         every discovery attempt and its verdict
 *   bun run arena shadow run <round_id|due> | list | score
 *                                               record / list / score shadow forecasts (never filed)
 *   bun run arena evaluate [--forecaster model:<m>|crew:<m>[,<m>,<m>]] [--no-learn] [--limit N] [--tracker T] [--out FILE]
 *                                               score forecasters on already-resolved rounds (files nothing)
 *
 * `--forecaster baseline|model:<provider/model>` overrides MARINA_ARENA_FORECASTER for show/submit.
 *
 * Reads MARINA_ARENA_* from the environment (.env). Submissions are recorded in
 * the world database (DB_PATH) so the server's autopilot and this CLI share one
 * ledger and never double-file.
 */

import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseForecasterSpec } from "../src/arena/config";
import {
  evaluateResolved,
  evaluateShapes,
  type Forecaster,
  type Learner,
  scoreShadow,
} from "../src/arena/evaluate";
import { backtestSeries } from "../src/arena/forecast";
import { generateArenaKey } from "../src/arena/protocol";
import {
  arenaData,
  arenaDepsWithForecaster,
  arenaStatus,
  forecasterFor,
  recordShadow,
} from "../src/arena/service";
import { buildForecastBody, dueRounds, submitRound } from "../src/arena/submit";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    org: { type: "string" },
    github: { type: "string" },
    contact: { type: "string" },
    homepage: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
    forecaster: { type: "string" },
    limit: { type: "string" },
    tracker: { type: "string" },
    weight: { type: "string" },
    "no-learn": { type: "boolean" },
    proposer: { type: "string" },
    n: { type: "string" },
  },
});
const [cmd = "status", arg] = positionals;

/** The default research crew: one analyst per vendor. */
const DEFAULT_RESEARCH =
  "research:openrouter/deepseek/deepseek-v4-pro,openrouter/anthropic/claude-sonnet-5,openrouter/openai/gpt-6-luna";

function weightFlag(): number | undefined {
  if (values.weight === undefined) return undefined;
  const w = Number(values.weight);
  if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error("--weight must be between 0 and 1");
  return w;
}

function openDb(): MarinaDB {
  return new MarinaDB(process.env.DB_PATH || "marina.db");
}

async function main(): Promise<number> {
  switch (cmd) {
    case "keygen": {
      if (!arg) throw new Error("usage: bun run arena keygen <path>");
      const key = generateArenaKey();
      // O_EXCL: never overwrite an existing key; 0600: only this user can read it.
      const fd = openSync(arg, "wx", 0o600);
      writeSync(fd, key.privatePem);
      closeSync(fd);
      console.log(`Wrote ${arg} (mode 600). Keep it private; it never leaves this machine.`);
      console.log(`Public key (goes in the registration): ${key.publicBase64}`);
      console.log(`Next: set MARINA_ARENA_KEY_FILE=${arg} and MARINA_ARENA_ENTRANT=<id>, then`);
      console.log("      bun run arena registration --name … --org … --github <login>");
      return 0;
    }
    case "registration": {
      const s = arenaStatus();
      if (!s.configured || !s.entrant) throw new Error("set MARINA_ARENA_ENTRANT first");
      if (!s.publicKey) throw new Error(`signing key not ready: ${s.keyError}`);
      if (!values.name || !values.github) throw new Error("--name and --github are required");
      const registration = {
        entrant_id: s.entrant,
        name: values.name,
        ...(values.org ? { organization: values.org } : {}),
        type: "participant",
        ...(values.contact ? { contact: values.contact } : {}),
        github: values.github,
        ...(values.homepage ? { homepage: values.homepage } : {}),
        keys: [{ id: s.keyId, alg: "ed25519", public: s.publicKey, revoked: false }],
      };
      const text = `${JSON.stringify(registration, null, 2)}\n`;
      if (values.out) await Bun.write(values.out, text);
      process.stdout.write(text);
      console.error(
        `Add this as entrants/${s.entrant}.json in a fork of Social-Atoms/social-sim-arena and open the PR from ${values.github}.`,
      );
      return 0;
    }
    case "status": {
      const s = arenaStatus();
      console.log(JSON.stringify(s, null, 2));
      if (s.configured) {
        const db = openDb();
        const rows = db.listArenaSubmissions({ entrant: s.entrant, limit: 500 });
        console.log(
          `filed: ${rows.filter((r) => r.status === "accepted").length} accepted, ${rows.filter((r) => r.status !== "accepted").length} other`,
        );
        db.close();
      }
      return 0;
    }
    case "rounds": {
      const now = Date.now();
      for (const r of await arenaData().openRounds()) {
        const h = Math.round((Date.parse(r.lock_at) - now) / 3_600_000);
        console.log(
          `${r.lock_at}  ${String(h).padStart(4)} h  ${r.target_type.padEnd(17)} ${r.round_id}`,
        );
      }
      return 0;
    }
    case "show": {
      if (!arg) throw new Error("usage: bun run arena show <round_id>");
      const data = arenaData();
      const round = await data.round(arg);
      if (!round) throw new Error(`no round ${arg}`);
      const spec = parseForecasterSpec(values.forecaster ?? process.env.MARINA_ARENA_FORECASTER);
      const { forecaster } = await forecasterFor(spec, { weight: weightFlag() });
      const body = await buildForecastBody(
        data,
        arenaStatus().entrant ?? "marina-preview",
        round,
        forecaster,
      );
      console.log(
        JSON.stringify({ question: round.question, lock_at: round.lock_at, body }, null, 2),
      );
      return 0;
    }
    case "submit": {
      if (!arg) throw new Error("usage: bun run arena submit <round_id|due> [--dry-run]");
      const db = openDb();
      try {
        const deps = await arenaDepsWithForecaster(
          db,
          process.env,
          values.forecaster ? parseForecasterSpec(values.forecaster) : undefined,
          weightFlag(),
        );
        if ("error" in deps) throw new Error(deps.error);
        const ids = arg === "due" ? (await dueRounds(deps)).map((r) => r.round_id) : [arg];
        if (ids.length === 0) console.log("Nothing due.");
        let failed = 0;
        for (const id of ids) {
          const outcome = await submitRound(deps, id, { dryRun: values["dry-run"] });
          if (outcome.kind === "dry-run") {
            console.log(`${id}: would file ${JSON.stringify(outcome.body)}`);
          } else if (outcome.kind === "accepted") {
            console.log(`${id}: accepted${outcome.already ? " (already filed)" : ""}`);
          } else {
            failed++;
            console.log(`${id}: ${outcome.kind} — ${outcome.reason}`);
          }
        }
        return failed ? 1 : 0;
      } finally {
        db.close();
      }
    }
    case "backtest": {
      const data = arenaData();
      const rows: string[] = [];
      let total = 0;
      let count = 0;
      for (const round of (await data.openRounds()).filter(
        (r) => r.target_type !== "ranking_list",
      )) {
        const lock = await data.lock(round.round_id).catch(() => undefined);
        if (!lock) continue;
        const series =
          round.target_type === "profile_energy"
            ? Object.values(lock.answer_history_by_cell ?? {})
            : [lock.answer_history ?? lock.history ?? []];
        for (const points of series) {
          const r = backtestSeries(points);
          if (!r) continue;
          total += r.skill;
          count++;
          rows.push(
            `${r.skill >= 0 ? "+" : ""}${r.skill.toFixed(3)}  ${r.rule.padEnd(11)} ${round.round_id}`,
          );
        }
      }
      console.log(rows.join("\n"));
      console.log(`mean skill over ${count} series: ${count ? (total / count).toFixed(3) : "n/a"}`);
      return 0;
    }
    case "evaluate": {
      const forecasters: Record<string, Forecaster> = {
        baseline: (await forecasterFor("baseline")).forecaster,
      };
      const usage: { calls: number; costUsd: number }[] = [];
      const learners: Record<string, Learner> = {};
      let scratch: MarinaDB | undefined;
      const specArg = values.forecaster ? parseForecasterSpec(values.forecaster) : "baseline";
      if (specArg.startsWith("crew:")) {
        // The crew's lesson memory lives in a throwaway Marina DB: evaluation
        // never writes the world's notes.
        const dir = mkdtempSync(join(tmpdir(), "arena-eval-"));
        scratch = new MarinaDB(join(dir, "eval.db"));
        const crew = await forecasterFor(specArg, { notes: scratch });
        const label = `crew ${specArg.slice(5).replace(/openrouter\//g, "")}`;
        forecasters[label] = crew.forecaster;
        if (crew.learner && !values["no-learn"]) learners[label] = crew.learner;
        usage.push(crew.usage!);
      } else if (specArg === "nowcast") {
        forecasters.nowcast = (await forecasterFor("nowcast")).forecaster;
      } else if (specArg === "discovered") {
        scratch = openDb();
        forecasters.nowcast = (await forecasterFor("nowcast")).forecaster;
        forecasters.discovered = (await forecasterFor("discovered", { notes: scratch })).forecaster;
      } else if (specArg !== "baseline") {
        const spec = specArg;
        const model = spec.replace(/^model:/, "");
        const blended = await forecasterFor(spec, { weight: weightFlag() });
        const raw = await forecasterFor(spec, { raw: true });
        forecasters[`${model} blend ${weightFlag() ?? 0.5}`] = blended.forecaster;
        forecasters[`${model} raw`] = raw.forecaster;
        usage.push(blended.usage!, raw.usage!);
      }
      const report = await evaluateResolved(arenaData(), forecasters, {
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        ...(values.tracker ? { tracker: values.tracker } : {}),
        concurrency: 4,
        learners,
      });
      const lessons = scratch?.getNotesByType("arena-crew", "lesson", 1000).length;
      scratch?.close();
      const names = Object.keys(forecasters);
      const fmt = (x: number) => (Number.isNaN(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`);
      console.log(
        ["family".padEnd(18), "n".padEnd(4), ...names.map((n) => n.padEnd(34))].join(" "),
      );
      for (const f of report.families) {
        const cells = names.map((n) =>
          `${fmt(f.skill[n]!)} (${f.wins[n]}/${f.rounds} beat)`.padEnd(34),
        );
        console.log([f.tracker.padEnd(18), String(f.rounds).padEnd(4), ...cells].join(" "));
      }
      const all = names.map((n) => fmt(report.overall[n]!).padEnd(34));
      console.log(["ALL".padEnd(18), String(report.rounds.length).padEnd(4), ...all].join(" "));
      if (usage.length) {
        const kept = report.rounds.filter((r) =>
          Object.entries(r.results).some(
            ([n, x]) => n !== "baseline" && !n.endsWith("raw") && x.note,
          ),
        ).length;
        const cost = usage.reduce((s, u) => s + u.costUsd, 0);
        const calls = usage.reduce((s, u) => s + u.calls, 0);
        console.log(
          `model calls ${calls} · cost $${cost.toFixed(4)} · kept the baseline on ${kept} round(s)${lessons === undefined ? "" : ` · lessons written ${lessons}${values["no-learn"] ? " (learning off)" : ""}`}`,
        );
      }
      console.log("skill: 0 = the arena's persistence (last value, sd 1.5); above 0 beats it.");
      if (report.excluded.length) {
        console.log(
          `excluded ${report.excluded.length} round(s) whose outcome was already public at lock: ${report.excluded.join(", ")}`,
        );
      }
      // Profile and ranking rounds, scored as the leaderboard scores them.
      const shapes = await evaluateShapes(arenaData(), forecasters);
      if (shapes.rounds.length) {
        console.log(
          `\nprofile & ranking rounds (${shapes.rounds.length}), skill vs the arena's persistence:`,
        );
        for (const r of shapes.rounds) {
          console.log(
            `  ${r.roundId.padEnd(26)} ${names.map((n) => `${n.slice(0, 18)} ${r.results[n] ? fmt(r.results[n]!.skill) : "n/a"}`).join("  ")}`,
          );
        }
        console.log(
          `  ALL ${names.map((n) => `${n.slice(0, 18)} ${fmt(shapes.overall[n]!)}`).join("  ")}`,
        );
      }
      if (values.out) {
        await Bun.write(
          values.out,
          `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
        );
        console.error(`report → ${values.out}`);
      }
      return 0;
    }
    case "research": {
      if (!arg)
        throw new Error(
          "usage: bun run arena research <round_id> [--forecaster research:<m>[,<m>,<m>]]",
        );
      const spec = parseForecasterSpec(values.forecaster ?? DEFAULT_RESEARCH);
      if (!spec.startsWith("research:")) throw new Error("--forecaster must be research:<models>");
      const data = arenaData();
      const round = await data.round(arg);
      if (!round) throw new Error(`no round ${arg}`);
      const { forecaster, usage } = await forecasterFor(spec);
      const f = (await forecaster(round, await data.lock(arg))) as unknown as Record<
        string,
        unknown
      >;
      console.log(JSON.stringify({ question: round.question, ...f }, null, 2));
      console.error(`cost $${(usage?.costUsd ?? 0).toFixed(4)}`);
      return 0;
    }
    case "shadow": {
      const db = openDb();
      try {
        const action = arg ?? "list";
        if (action === "run") {
          const target = positionals[2];
          if (!target)
            throw new Error("usage: bun run arena shadow run <round_id|due> [--forecaster …]");
          const spec = parseForecasterSpec(values.forecaster ?? DEFAULT_RESEARCH);
          const data = arenaData();
          const hours = Number(process.env.MARINA_ARENA_WINDOW_HOURS ?? 24);
          const ids =
            target === "due"
              ? (await data.openRounds())
                  .filter((r) => Date.parse(r.lock_at) <= Date.now() + hours * 3_600_000)
                  .map((r) => r.round_id)
              : [target];
          const results = await recordShadow(db, data, spec, ids);
          for (const r of results)
            console.log(`${r.roundId}: ${r.recorded ? "recorded" : r.error}`);
          const rows = db.listArenaShadow({ forecaster: spec, limit: 2_000 });
          const cost = rows
            .filter((r) => ids.includes(r.round_id))
            .reduce((t, r) => t + r.cost_usd, 0);
          console.log(
            `${spec}: ${results.filter((r) => r.recorded).length} recorded · cost $${cost.toFixed(4)}`,
          );
          return 0;
        }
        if (action === "list") {
          for (const r of db.listArenaShadow({ limit: 200 })) {
            const t = (JSON.parse(r.forecast) as { topline?: { mean: number; sd: number } })
              .topline;
            const d = JSON.parse(r.detail) as { trust?: number; fallback?: string };
            console.log(
              `${new Date(r.created_at).toISOString().slice(0, 16)} ${r.round_id.padEnd(34)} ${t ? `${t.mean}±${t.sd}` : "(non-numeric)"} trust ${d.trust?.toFixed(2) ?? "-"} ${d.fallback ?? ""} ${r.forecaster}`,
            );
          }
          return 0;
        }
        if (action === "score") {
          const scores = await scoreShadow(arenaData(), db.listArenaShadow({ limit: 2_000 }));
          if (scores.length === 0) {
            console.log("No recorded shadow forecast has resolved yet.");
            return 0;
          }
          const by = new Map<string, typeof scores>();
          for (const x of scores) by.set(x.forecaster, [...(by.get(x.forecaster) ?? []), x]);
          for (const [name, list] of by) {
            const mean = (f: (x: (typeof list)[number]) => number) =>
              list.reduce((t, x) => t + f(x), 0) / list.length;
            console.log(
              `${name}: n=${list.length} skill ${mean((x) => x.skill).toFixed(3)} vs baseline ${mean((x) => x.baselineSkill).toFixed(3)} · beat persistence ${list.filter((x) => x.skill > 0).length} · beat baseline ${list.filter((x) => x.skill > x.baselineSkill).length} · cost $${list.reduce((t, x) => t + x.costUsd, 0).toFixed(3)}`,
            );
          }
          return 0;
        }
        throw new Error("usage: bun run arena shadow run|list|score");
      } finally {
        db.close();
      }
    }
    case "discover": {
      const db = openDb();
      try {
        const [{ discover }, { modelComplete }] = await Promise.all([
          import("../src/arena/discovery/loop"),
          import("../src/arena/model-backend"),
        ]);
        const proposerModel = values.proposer ?? "openrouter/anthropic/claude-sonnet-5";
        const { complete, usage } = modelComplete(proposerModel);
        const trackers = values.tracker
          ? [values.tracker]
          : ["civiqs", "economist_yougov", "morning_consult", "aaii"];
        for (const tracker of trackers) {
          const out = await discover({
            data: arenaData(),
            notes: db,
            tracker,
            n: values.n ? Number(values.n) : 5,
            propose: (prompt) =>
              complete("You design forecasting signals. Reply with one JSON object only.", prompt),
          });
          console.log(`\n== ${tracker}`);
          if (out.note) console.log(`  ${out.note}`);
          for (const r of out.records) {
            const d = r.discovery ? `disc ${r.discovery.skill.toFixed(3)}` : "";
            const h = r.holdout ? `hold ${r.holdout.skill.toFixed(3)}` : "";
            console.log(
              `  ${r.verdict.padEnd(9)} centre ${r.spec.centre.padEnd(18)} spread ${r.spec.spread.padEnd(10)} ${d} ${h}  ${r.reason}`,
            );
          }
          const inc = out.records.find((r) => r.incumbent)?.incumbent;
          if (inc)
            console.log(
              `  incumbent (nowcast/baseline): disc ${inc.discovery.skill.toFixed(3)} hold ${inc.holdout.skill.toFixed(3)}`,
            );
        }
        console.log(
          `\nproposer ${proposerModel} · ${usage.calls} call(s) · $${usage.costUsd.toFixed(4)}`,
        );
        return 0;
      } finally {
        db.close();
      }
    }
    case "signals": {
      const db = openDb();
      try {
        const { pastAttempts } = await import("../src/arena/discovery/loop");
        const trackers = values.tracker
          ? [values.tracker]
          : [
              "civiqs",
              "economist_yougov",
              "morning_consult",
              "aaii",
              "umich_sentiment",
              "google_trends",
              "wikipedia",
            ];
        for (const t of trackers) {
          const list = pastAttempts(db, t);
          if (!list.length) continue;
          console.log(`== ${t}`);
          for (const r of list) {
            console.log(
              `  ${new Date(r.at).toISOString().slice(0, 10)} ${r.verdict.padEnd(9)} ${r.spec.centre}/${r.spec.spread}  disc ${r.discovery?.skill.toFixed(3)} hold ${r.holdout?.skill.toFixed(3)}  ${r.rationale ?? ""}`,
            );
          }
        }
        return 0;
      } finally {
        db.close();
      }
    }
    default:
      throw new Error(
        `unknown command ${cmd} (keygen, registration, status, rounds, show, submit, backtest, evaluate, research, shadow, discover, signals)`,
      );
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
