// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapters' shared command-line plumbing: build the candidate
 * configurations from the live model catalogue, run a selection, persist it
 * (the chosen configurations in full, so a live run needs no catalogue), and
 * resolve which configuration a live run files with.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isolationOfSpec } from "../../src/arena/research/isolation";
import type { MarinaDB } from "../../src/persistence/database";
import {
  type CatalogueModel,
  callCost,
  candidateModels,
  fetchCatalogue,
  releases,
} from "./catalogue";
import {
  candidateConfigs,
  depsForConfig,
  describeConfig,
  type ForecastConfig,
  forecasterFor,
  parseConfigs,
} from "./configs";
import { type BacktestItem, type Selection, selectConfiguration } from "./select";
import { learnedLessons } from "./shared";

/**
 * Models the operator asked to be considered whatever the vendor heuristic
 * picks (the current top tiers); each must exist in the catalogue.
 */
export const DEFAULT_INCLUDE = [
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "openai/gpt-6-astra-pro",
  "openai/gpt-6.1-sol-pro",
  "openai/gpt-6.1-sol",
];

/** Date-strict, keyless retrieval bounded to each question's cutoff. */
export const BACKTEST_RETRIEVER = "asof";

/** Used only when no selection has been made and none is named; disclosed as such. */
export const FALLBACK_CONFIG: ForecastConfig = {
  label: "default (not selected)",
  formation: "ensemble",
  analysts: ["openrouter/deepseek/deepseek-v4-pro-0813"],
  planner: "openrouter/deepseek/deepseek-v4-pro-0813",
  critic: "openrouter/deepseek/deepseek-v4-pro-0813",
  runs: 2,
  researchRounds: 1,
};

export interface SavedSelection extends Selection {
  /** Every candidate configuration in full, by label. */
  configs: Record<string, ForecastConfig>;
  retriever: string;
}

/** A rough projected cost per question (runs + planner + critic calls at list price). */
export function projectedCost(c: ForecastConfig, catalogue: CatalogueModel[]): number {
  const price = (spec?: string) => {
    const m = spec ? catalogue.find((x) => `openrouter/${x.id}` === spec) : undefined;
    return m ? callCost(m) : 0;
  };
  const runs = c.runs ?? 3;
  let usd = 0;
  for (let i = 0; i < runs; i++) usd += price(c.analysts[i % c.analysts.length]);
  usd += price(c.planner ?? c.analysts[0]) * ((c.researchRounds ?? 2) + 1);
  if (c.verify) usd += price(c.verifier ?? c.critic) * runs;
  if (c.formation === "delphi") usd += usd * 0.6;
  if (c.formation === "tournament") usd += price(c.critic) * (runs - 1);
  else if (c.critique !== false) usd += price(c.critic ?? c.planner ?? c.analysts[0]);
  return usd;
}

export async function candidates(opts: {
  include?: string[];
  crews?: string[];
  ablate?: boolean;
  perVendor?: number;
  configsFile?: string;
}): Promise<{ configs: ForecastConfig[]; catalogue: CatalogueModel[] }> {
  const catalogue = await fetchCatalogue();
  if (opts.configsFile) {
    return {
      configs: parseConfigs(JSON.parse(readFileSync(opts.configsFile, "utf8"))),
      catalogue,
    };
  }
  const models = candidateModels(catalogue, {
    include: opts.include ?? DEFAULT_INCLUDE,
    ...(opts.perVendor ? { perVendor: opts.perVendor } : {}),
  });
  const configs = candidateConfigs(models, {
    ...(opts.crews ? { crews: opts.crews } : {}),
    ...(opts.ablate ? { ablate: true } : {}),
  });
  // Cheapest first, so a budget stop measures as many candidates as it can.
  configs.sort((a, b) => projectedCost(a, catalogue) - projectedCost(b, catalogue));
  return { configs, catalogue };
}

export async function runSelection(opts: {
  benchmark: string;
  db: MarinaDB;
  items: BacktestItem[];
  configs: ForecastConfig[];
  catalogue: CatalogueModel[];
  pick: number;
  replicates: number;
  maxItems: number;
  minItems: number;
  budgetUsd: number;
  livePerItemUsd?: number;
  retriever?: string;
  concurrency?: number;
  out: string;
  log: (line: string) => void;
}): Promise<SavedSelection> {
  const retriever = opts.retriever ?? BACKTEST_RETRIEVER;
  const lessons = learnedLessons(opts.db);
  const selection = await selectConfiguration({
    benchmark: opts.benchmark,
    items: opts.items,
    candidates: opts.configs,
    releases: releases(opts.catalogue),
    makeForecaster: (c) => forecasterFor(c, depsForConfig(c, { lessons, retriever })),
    replicates: opts.replicates,
    pick: opts.pick,
    maxItems: opts.maxItems,
    minItems: opts.minItems,
    budgetUsd: opts.budgetUsd,
    ...(opts.livePerItemUsd !== undefined ? { livePerItemUsd: opts.livePerItemUsd } : {}),
    isolation: isolationOfSpec(retriever, false),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ledger: opts.db,
    log: opts.log,
  });
  const saved: SavedSelection = {
    ...selection,
    configs: Object.fromEntries(opts.configs.map((c) => [c.label, c])),
    retriever,
  };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(saved, null, 2));
  return saved;
}

export function printSelection(s: SavedSelection, log: (line: string) => void): void {
  log(
    `\n${s.benchmark}: ${s.items} resolved questions from ${s.window} · ${s.replicates} replicates · retriever ${s.retriever} · $${s.costUsd}`,
  );
  for (const r of s.ranking) {
    const tail =
      r.mean !== undefined
        ? `${r.mean.toFixed(4)}${r.vsLeader ? ` (leader +${r.vsLeader.diff.toFixed(4)}, 95% ${r.vsLeader.ci[0].toFixed(4)}…${r.vsLeader.ci[1].toFixed(4)})` : " (leader)"} · ${r.replicates} reps · $${r.costPerItem}/q`
        : r.status;
    log(
      `  ${s.picked.includes(r.label) ? "★" : " "} ${r.label.padEnd(44)} ${tail}${r.note ? ` — ${r.note}` : ""}`,
    );
  }
  log(`picked: ${s.picked.join(", ") || "(none)"}`);
}

/**
 * The configuration a live run files with: `label` from the saved selection
 * (or a configurations file), else the selection's pick number `rank`
 * (1-based), else the fallback — always with its disclosure line.
 */
export function liveConfig(opts: {
  selectionPath: string;
  label?: string;
  rank?: number;
  configsFile?: string;
}): { config: ForecastConfig; description: string; selected: boolean } {
  const saved = existsSync(opts.selectionPath)
    ? (JSON.parse(readFileSync(opts.selectionPath, "utf8")) as SavedSelection)
    : undefined;
  const fromFile = opts.configsFile
    ? parseConfigs(JSON.parse(readFileSync(opts.configsFile, "utf8")))
    : [];
  let c: ForecastConfig | undefined;
  let selected = false;
  if (opts.label) {
    c = fromFile.find((x) => x.label === opts.label) ?? saved?.configs[opts.label];
    if (!c)
      throw new Error(
        `no configuration ${opts.label} in ${opts.configsFile ?? opts.selectionPath}`,
      );
    selected = !!saved?.picked.includes(opts.label);
  } else if (saved?.picked.length) {
    const label = saved.picked[Math.min(saved.picked.length, opts.rank ?? 1) - 1]!;
    c = saved.configs[label];
    selected = true;
  }
  const config = c ?? FALLBACK_CONFIG;
  const r = saved?.ranking.find((x) => x.label === config.label);
  const evidence =
    selected && saved && r?.mean !== undefined
      ? `; chosen by held-out backtest (${saved.items} resolved questions, ${saved.replicates} replicates, mean 1−Brier ${r.mean.toFixed(3)})`
      : selected
        ? "; chosen by held-out backtest"
        : "; not chosen by backtest";
  return { config, description: `${describeConfig(config)}${evidence}`, selected };
}
