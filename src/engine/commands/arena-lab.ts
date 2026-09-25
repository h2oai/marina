// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The arena's measurement loop, in the world — what `bun run arena evaluate /
 * shadow / discover / signals` does, so an agent can run the loop itself:
 *
 *   arena evaluate [baseline|nowcast|discovered] [tracker:T] [limit:N]
 *   arena shadow [list] | arena shadow score | arena shadow run <round_id|due> [forecaster:F]
 *   arena discover [tracker:T] [n:N]
 *   arena signals [tracker:T]
 *
 * Only forecasters that cost nothing run here (baseline, nowcast, discovered):
 * model-backed evaluation and shadow runs spend real money and stay operator
 * steps. `discover` makes one proposer call per family, so it is rate limited
 * per entity and runs one at a time. Filing a submission is never in-world.
 */

import type { ArenaData } from "../../arena/data";
import {
  DISCOVERY_TRACKERS,
  discover,
  PROPOSER_SYSTEM,
  pastAttempts,
  proposerModel,
  SIGNAL_TRACKERS,
} from "../../arena/discovery/loop";
import { evaluateResolved, type Forecaster, scoreShadow } from "../../arena/evaluate";
import { forecasterFor, recordShadow } from "../../arena/service";
import { RateLimiter } from "../../auth/rate-limiter";
import { bold, dim, header, separator } from "../../net/ansi";
import type { ArenaStore } from "../../persistence/interfaces/arena-store";
import type { NotesStore } from "../../persistence/interfaces/notes-store";
import { type ModifierSpec, parseModifiers } from "../parse-input";

/** Forecasters that make no model calls — the only ones the world may run. */
export const FREE_FORECASTERS = ["baseline", "nowcast", "discovered"] as const;

export interface ArenaLabDeps {
  store?: ArenaStore;
  notes?: NotesStore;
  data: () => ArenaData;
  /** The proposer for `arena discover`; default: `proposerModel()` via its provider key. */
  propose?: (prompt: string) => Promise<{ reply: string; costUsd: number }>;
}

// Scoring every resolved round fetches every lock: bounded per entity.
const evaluateLimiter = new RateLimiter({
  maxTokens: 6,
  refillRate: 1,
  refillInterval: 10 * 60_000,
});
// A proposer call per family, and every attempt raises the promotion bar for that family.
const discoverLimiter = new RateLimiter({
  maxTokens: 2,
  refillRate: 1,
  refillInterval: 60 * 60_000,
});
let discovering = false;

const MODS: ModifierSpec = {
  tracker: { type: "string", aliases: ["family"] },
  limit: { type: "int" },
  n: { type: "int" },
  forecaster: { type: "string" },
};

const fmt = (x: number | undefined) =>
  x === undefined || Number.isNaN(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

type Reply = (text: string) => void;

function freeForecaster(name: string | undefined): string | undefined {
  const f = (name ?? "").toLowerCase();
  return (FREE_FORECASTERS as readonly string[]).includes(f) ? f : undefined;
}

const PAID =
  "Model-backed forecasters (model:, crew:, research:) spend real money — run them as an operator step: bun run arena evaluate|shadow --forecaster …";

export async function arenaEvaluate(
  deps: ArenaLabDeps,
  entity: string,
  tokens: string[],
  reply: Reply,
): Promise<void> {
  const mods = parseModifiers(tokens, MODS);
  const named = mods.rest[0] ?? "nowcast";
  const pick = freeForecaster(named);
  if (!pick)
    return reply(
      `Unknown or paid forecaster "${named}". Free here: ${FREE_FORECASTERS.join(", ")}.\n${dim(PAID)}`,
    );
  if (!evaluateLimiter.consume(entity))
    return reply("Evaluation is rate limited — try again in a few minutes.");
  reply(dim("Scoring every resolved round as the leaderboard does… (~10–60 s)"));
  const forecasters: Record<string, Forecaster> = {
    baseline: (await forecasterFor("baseline")).forecaster,
  };
  if (pick !== "baseline") {
    forecasters[pick] = (
      await forecasterFor(pick, deps.notes ? { notes: deps.notes } : {})
    ).forecaster;
  }
  const tracker = mods.values.tracker as string | undefined;
  const limit = mods.values.limit as number | undefined;
  const report = await evaluateResolved(deps.data(), forecasters, {
    ...(tracker ? { tracker } : {}),
    ...(limit ? { limit: Math.min(Math.max(limit, 1), 200) } : {}),
    concurrency: 4,
  });
  if (report.rounds.length === 0) return reply("No resolved numeric rounds to score yet.");
  const names = Object.keys(forecasters);
  const lines = [
    header(`Arena evaluation — ${names.join(" vs ")}`),
    separator(),
    dim(`${"family".padEnd(18)} ${"n".padEnd(4)} ${names.map((n) => n.padEnd(22)).join(" ")}`),
    ...report.families.map(
      (f) =>
        `${bold(f.tracker.padEnd(18))} ${String(f.rounds).padEnd(4)} ${names
          .map((n) => `${fmt(f.skill[n])} (${f.wins[n]}/${f.rounds} beat)`.padEnd(22))
          .join(" ")}`,
    ),
    `${bold("ALL".padEnd(18))} ${String(report.rounds.length).padEnd(4)} ${names
      .map((n) => fmt(report.overall[n]).padEnd(22))
      .join(" ")}`,
    dim("skill: 0 = the arena's persistence (last value, sd 1.5); above 0 beats it."),
  ];
  if (report.excluded.length) {
    lines.push(dim(`excluded ${report.excluded.length} round(s) whose outcome was public at lock`));
  }
  reply(lines.join("\n"));
}

export async function arenaShadow(
  deps: ArenaLabDeps,
  tokens: string[],
  reply: Reply,
): Promise<void> {
  if (!deps.store) return reply("The shadow ledger needs the world database.");
  const action = (tokens[0] ?? "list").toLowerCase();
  if (action === "list" || action === "ls") {
    const rows = deps.store.listArenaShadow({ limit: 40 });
    if (rows.length === 0)
      return reply("No shadow forecasts yet. Record some: arena shadow run due");
    return reply(
      [
        header("Shadow forecasts (recorded, never filed)"),
        separator(),
        ...rows.map((r) => {
          const t = (JSON.parse(r.forecast) as { topline?: { mean: number; sd: number } }).topline;
          return `  ${bold(r.round_id)} ${t ? `${t.mean} ± ${t.sd}` : dim("(profile/ranking)")} ${dim(`${r.forecaster} · ${new Date(r.created_at).toISOString().slice(0, 16)}`)}`;
        }),
      ].join("\n"),
    );
  }
  if (action === "score") {
    const scores = await scoreShadow(deps.data(), deps.store.listArenaShadow({ limit: 2_000 }));
    if (scores.length === 0) return reply("No recorded shadow forecast has resolved yet.");
    const by = new Map<string, typeof scores>();
    for (const x of scores) by.set(x.forecaster, [...(by.get(x.forecaster) ?? []), x]);
    return reply(
      [
        header("Shadow record — scored on outcomes no one had seen"),
        separator(),
        ...[...by].map(([name, list]) => {
          const mean = (f: (x: (typeof list)[number]) => number) =>
            list.reduce((t, x) => t + f(x), 0) / list.length;
          return `  ${bold(name)} n=${list.length} skill ${fmt(mean((x) => x.skill))} vs baseline ${fmt(mean((x) => x.baselineSkill))} ${dim(`· beat persistence ${list.filter((x) => x.skill > 0).length} · beat baseline ${list.filter((x) => x.skill > x.baselineSkill).length}`)}`;
        }),
      ].join("\n"),
    );
  }
  if (action === "run") {
    const mods = parseModifiers(tokens.slice(1), MODS);
    const target = mods.rest[0];
    if (!target) return reply("Usage: arena shadow run <round_id|due> [forecaster:nowcast]");
    const named = (mods.values.forecaster as string | undefined) ?? "nowcast";
    const spec = freeForecaster(named);
    if (!spec)
      return reply(
        `"${named}" is not free to run here (${FREE_FORECASTERS.join(", ")}).\n${dim(PAID)}`,
      );
    const data = deps.data();
    const hours = Number(process.env.MARINA_ARENA_WINDOW_HOURS ?? 24) || 24;
    const ids =
      target === "due"
        ? (await data.openRounds())
            .filter((r) => Date.parse(r.lock_at) <= Date.now() + hours * 3_600_000)
            .map((r) => r.round_id)
        : [target];
    if (ids.length === 0) return reply(`No round locks within ${hours} h.`);
    const results = await recordShadow(deps.store, data, spec, ids);
    const recorded = results.filter((r) => r.recorded).length;
    return reply(
      [
        header(`Shadow ${spec}: ${recorded} recorded`),
        ...results.map(
          (r) => `  ${r.roundId} ${r.recorded ? "recorded" : dim(r.error ?? "skipped")}`,
        ),
        dim("Scored once they resolve: arena shadow score"),
      ].join("\n"),
    );
  }
  reply(
    "Usage: arena shadow [list] | arena shadow score | arena shadow run <round_id|due> [forecaster:nowcast]",
  );
}

export async function arenaDiscover(
  deps: ArenaLabDeps,
  entity: string,
  tokens: string[],
  reply: Reply,
): Promise<void> {
  if (!deps.notes) return reply("Discovery needs the world's notes.");
  const mods = parseModifiers(tokens, MODS);
  const tracker = mods.values.tracker as string | undefined;
  const trackers = tracker ? [tracker] : DISCOVERY_TRACKERS;
  const n = Math.min(Math.max((mods.values.n as number | undefined) ?? 5, 1), 8);
  if (discovering)
    return reply("A discovery run is already in progress — try again when it finishes.");
  if (!discoverLimiter.consume(entity)) {
    return reply(
      "Discovery is rate limited (each run raises the bar for the next) — try again later.",
    );
  }
  let propose = deps.propose;
  if (!propose) {
    const { modelComplete } = await import("../../arena/model-backend");
    const { complete, usage } = modelComplete(proposerModel());
    propose = async (prompt) => {
      const before = usage.costUsd;
      const reply = await complete(PROPOSER_SYSTEM, prompt);
      return { reply, costUsd: usage.costUsd - before };
    };
  }
  discovering = true;
  reply(dim(`Proposing and backtesting signals for ${trackers.join(", ")}… (~30–90 s)`));
  let cost = 0;
  try {
    const lines = [header("Signal discovery"), separator()];
    for (const t of trackers) {
      const out = await discover({
        data: deps.data(),
        notes: deps.notes,
        tracker: t,
        n,
        propose: async (prompt) => {
          const r = await propose(prompt);
          cost += r.costUsd;
          return r.reply;
        },
      });
      lines.push(bold(t));
      if (out.note) lines.push(`  ${dim(out.note)}`);
      for (const r of out.records) {
        const scores =
          r.discovery && r.holdout
            ? ` ${dim(`disc ${fmt(r.discovery.skill)} hold ${fmt(r.holdout.skill)}`)}`
            : "";
        lines.push(`  ${r.verdict.padEnd(9)} ${r.spec.centre}/${r.spec.spread}${scores}`);
      }
      const inc = out.records.find((r) => r.incumbent)?.incumbent;
      if (inc) {
        lines.push(
          dim(
            `  incumbent nowcast/baseline: disc ${fmt(inc.discovery.skill)} hold ${fmt(inc.holdout.skill)}`,
          ),
        );
      }
    }
    lines.push(
      dim(
        `cost $${cost.toFixed(4)} · promoted signals drive the \`discovered\` forecaster; prove them forward with arena shadow run due forecaster:discovered`,
      ),
    );
    reply(lines.join("\n"));
  } finally {
    discovering = false;
  }
}

export function arenaSignals(deps: ArenaLabDeps, tokens: string[], reply: Reply): void {
  if (!deps.notes) {
    reply("Signals live in the world's notes, which are unavailable.");
    return;
  }
  const tracker = parseModifiers(tokens, MODS).values.tracker as string | undefined;
  const lines = [header("Discovery attempts"), separator()];
  for (const t of tracker ? [tracker] : SIGNAL_TRACKERS) {
    const list = pastAttempts(deps.notes, t);
    if (!list.length) continue;
    lines.push(bold(t));
    for (const r of list.slice(-12)) {
      lines.push(
        `  ${new Date(r.at).toISOString().slice(0, 10)} ${r.verdict.padEnd(9)} ${r.spec.centre}/${r.spec.spread} ${dim(`disc ${fmt(r.discovery?.skill)} hold ${fmt(r.holdout?.skill)}`)}`,
      );
    }
  }
  if (lines.length === 2) lines.push("No signal has been tried yet. Start one: arena discover");
  reply(lines.join("\n"));
}

/** Test hook: the limiters and the single-run latch are module state. */
export function resetArenaLabForTests(entities: string[]): void {
  for (const e of entities) {
    evaluateLimiter.reset(e);
    discoverLimiter.reset(e);
  }
  discovering = false;
}
