// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapters' shared command-line plumbing: build the candidate
 * configurations from the live model catalogue, run a selection, persist it
 * (the chosen configurations in full, so a live run needs no catalogue), and
 * resolve which configuration a live run files with.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isolationOfSpec } from "../../src/arena/research/isolation";
import {
  DEFAULT_HOLDOUT_FRACTION,
  fileSlotPromotion,
  itemSplit,
  MIN_HOLDOUT_ITEMS,
} from "../../src/engine/benchmark-promotion";
import {
  boardSlotKey,
  type DefaultSlotReader,
  resolveDefault,
} from "../../src/engine/default-resolution";
import { FORECAST_CONFIG_SLOT, FORECAST_FAMILY } from "../../src/forecast/defaults";
import { forecastLessonsFor } from "../../src/learning/forecast-bridge";
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
import { releaseTable } from "./knowledge";
import {
  addLeakCounts,
  auditForecast,
  describeLeakCounts,
  emptyLeakCounts,
  hardLeaks,
  type LeakCounts,
} from "./leak-audit";
import { type BacktestItem, type Selection, selectConfiguration } from "./select";

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
  /** Leak audit per configuration: what its forecasts saw (counts only). */
  leakAudit?: Record<string, LeakCounts>;
  /** What the selection filed on the board's default slot (the journal of the decision). */
  promotion?: SelectionPromotion;
}

/** The slot a board's live forecast configuration resolves from. */
export function forecastConfigSlot(benchmark: string): string {
  return boardSlotKey(FORECAST_CONFIG_SLOT, benchmark);
}

export interface SelectionPromotion {
  slot: string;
  /** seeded / promoted / refused: a history row was written; skipped: nothing was. */
  outcome: "seeded" | "promoted" | "refused" | "skipped";
  /** The challenger: the best configuration on the slot's SELECTION split. */
  challenger?: string;
  run?: string;
  incumbentRun?: string;
  reason: string;
}

type PromotionDb = Pick<
  MarinaDB,
  | "getBenchmarkRun"
  | "queryBenchmarkRuns"
  | "getBenchmarkItems"
  | "listBenchmarkRunValidity"
  | "getBenchmarkDefault"
  | "listBenchmarkDefaults"
  | "listBenchmarkPromotions"
  | "recordBenchmarkPromotion"
  | "durableEntityKey"
>;

/** The item ids a slot's incumbent run was measured on, when it has a valid one. */
export function incumbentItemIds(
  db: Pick<MarinaDB, "getBenchmarkDefault" | "getBenchmarkRun" | "getBenchmarkItems">,
  slot: string,
): string[] | undefined {
  const def = db.getBenchmarkDefault(slot);
  const run = def?.incumbent_run_id ? db.getBenchmarkRun(def.incumbent_run_id) : undefined;
  if (run?.status !== "completed") return undefined;
  const ids = db.getBenchmarkItems(run.id).map((i) => i.item_id);
  return ids.length > 0 ? ids : undefined;
}

/**
 * File a selection's decision as an earned promotion on the board's slot
 * (`forecast-config:<board>`), through the one promotion path
 * (`fileSlotPromotion`): the replicate minimum, the holdout interval and the
 * fishing margin, no self-attestation, an append-only history row.
 *
 * The challenger is chosen on the slot's SELECTION split only (the pooled
 * share of items better than the board's fallback, across its replicates), so
 * the holdout is read once — by the promotion attempt itself. Nothing is filed
 * (and the holdout stays unread) when no candidate was measured, when the
 * challenger already is the default, when the incumbent was measured on a
 * different benchmark, judge or item slice (a contest pairs the same items),
 * or when too few items fall in the holdout.
 */
export function fileSelectionPromotion(
  db: PromotionDb,
  saved: Pick<SavedSelection, "benchmark" | "ranking">,
  opts: { slot?: string; minReplicates?: number; now?: number } = {},
): SelectionPromotion {
  const slot = opts.slot ?? forecastConfigSlot(saved.benchmark);
  const skip = (reason: string, extra: Partial<SelectionPromotion> = {}): SelectionPromotion => ({
    slot,
    outcome: "skipped",
    reason,
    ...extra,
  });
  const def = db.getBenchmarkDefault(slot);
  const fraction = def?.holdout_fraction ?? DEFAULT_HOLDOUT_FRACTION;
  const inSelection = (id: string) => itemSplit(slot, id, fraction) === "selection";
  let best: { label: string; run: string; mean: number; holdout: number } | undefined;
  for (const r of saved.ranking) {
    if (r.mean === undefined || r.ledgerRuns.length === 0) continue;
    if (r.note?.startsWith("over the live budget")) continue;
    const perItem = new Map<string, { correct: number; n: number }>();
    for (const runId of r.ledgerRuns) {
      for (const it of db.getBenchmarkItems(runId)) {
        const acc = perItem.get(it.item_id) ?? { correct: 0, n: 0 };
        acc.n++;
        if (it.correct) acc.correct++;
        perItem.set(it.item_id, acc);
      }
    }
    const sel = [...perItem].filter(([id]) => inSelection(id));
    if (sel.length === 0) continue;
    const mean = sel.reduce((s, [, a]) => s + a.correct / a.n, 0) / sel.length;
    if (!best || mean > best.mean) {
      best = {
        label: r.label,
        run: r.ledgerRuns[0] as string,
        mean,
        holdout: perItem.size - sel.length,
      };
    }
  }
  if (!best) return skip("no measured, affordable candidate with filed ledger runs");
  const tag = { challenger: best.label, run: best.run };
  const challenger = db.getBenchmarkRun(best.run);
  if (!challenger) return skip(`ledger run ${best.run} not found`, tag);
  const incumbent = def?.incumbent_run_id ? db.getBenchmarkRun(def.incumbent_run_id) : undefined;
  if (incumbent?.status === "completed") {
    if (incumbent.target_json === challenger.target_json) {
      return skip(`${best.label} already is the default`, { ...tag, incumbentRun: incumbent.id });
    }
    const differs = [
      incumbent.benchmark !== challenger.benchmark ? "benchmark" : "",
      incumbent.judge !== challenger.judge ? "judge" : "",
      incumbent.slice_hash &&
      challenger.slice_hash &&
      incumbent.slice_hash !== challenger.slice_hash
        ? "item slice"
        : "",
    ].filter(Boolean);
    if (differs.length > 0) {
      return skip(
        `the incumbent ${incumbent.id} was measured on a different ${differs.join(", ")} — re-run the selection on its items to contest it (the holdout stays unread)`,
        { ...tag, incumbentRun: incumbent.id },
      );
    }
  }
  if (best.holdout < MIN_HOLDOUT_ITEMS) {
    return skip(
      `only ${best.holdout} holdout item(s); a promotion needs at least ${MIN_HOLDOUT_ITEMS} (the holdout stays unread)`,
      tag,
    );
  }
  const filed = fileSlotPromotion(db, {
    slot,
    runId: best.run,
    // The operator owns the database; the history records the operator key.
    actor: { key: "operator", keyOf: (id) => db.durableEntityKey(id) },
    ...(opts.minReplicates !== undefined ? { minReplicates: opts.minReplicates } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (filed.kind === "error") return skip(filed.message, tag);
  if (filed.kind === "seeded") {
    return {
      slot,
      outcome: "seeded",
      ...tag,
      reason: `first incumbent (${filed.replicates} replicates; holdout ${Math.round(filed.holdoutFraction * 100)}% of items)`,
    };
  }
  const e = filed.evaluation;
  return {
    slot,
    outcome: filed.kind,
    ...tag,
    incumbentRun: filed.incumbent.id,
    reason:
      filed.kind === "promoted"
        ? `holdout +${(e.stats.delta * 100).toFixed(1)} pts, 95% [${(e.stats.low * 100).toFixed(1)}, ${(e.stats.high * 100).toFixed(1)}], margin ${(e.margin * 100).toFixed(1)}`
        : e.reasons.join("; "),
  };
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
  /** Continue a stopped selection from its journals (`<out>-runs/`), same configuration only. */
  resume?: boolean;
  log: (line: string) => void;
}): Promise<SavedSelection> {
  const retriever = opts.retriever ?? BACKTEST_RETRIEVER;
  // A held-out selection is a measurement of this board: lessons learned from the
  // board itself are excluded (leakage rule 2), so the earned default reflects
  // Marina's general knowledge, never the board's own outcomes.
  const lessons = forecastLessonsFor(opts.db, {
    eval: { benchmark: opts.benchmark, mode: "measure" },
  });
  const leakAudit: Record<string, LeakCounts> = {};
  // A board whose default was earned is contested on the SAME items its
  // incumbent was measured on (a promotion pairs items on one slice).
  const slot = forecastConfigSlot(opts.benchmark);
  const onlyItems = incumbentItemIds(opts.db, slot);
  if (onlyItems) {
    opts.log(`  ${slot} has an incumbent: backtesting on its ${onlyItems.length} items`);
  }
  const selection = await selectConfiguration({
    benchmark: opts.benchmark,
    items: onlyItems ? opts.items.filter((i) => onlyItems.includes(i.id)) : opts.items,
    ...(onlyItems ? { keepAllItems: true } : {}),
    candidates: opts.configs,
    releases: releaseTable(releases(opts.catalogue)),
    makeForecaster: (c) =>
      forecasterFor(c, depsForConfig(c, { lessons, retriever, captureEvidence: true }), {
        onAnswer: (req, answer, reports) => {
          if (!req.asOf) return;
          leakAudit[c.label] = addLeakCounts(
            leakAudit[c.label] ?? emptyLeakCounts(),
            auditForecast(req.asOf, reports, answer),
          );
        },
      }),
    replicates: opts.replicates,
    pick: opts.pick,
    maxItems: opts.maxItems,
    minItems: opts.minItems,
    budgetUsd: opts.budgetUsd,
    ...(opts.livePerItemUsd !== undefined ? { livePerItemUsd: opts.livePerItemUsd } : {}),
    isolation: isolationOfSpec(retriever, false),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ledger: opts.db,
    // Answered items are kept as they land: a cap stop never loses paid-for work.
    journalDir: join(dirname(opts.out), `${basename(opts.out, ".json")}-runs`),
    ...(opts.resume ? { resume: true } : {}),
    log: opts.log,
  });
  const saved: SavedSelection = {
    ...selection,
    configs: Object.fromEntries(opts.configs.map((c) => [c.label, c])),
    retriever,
    leakAudit,
  };
  // The decision is a promotion row on the board's slot; selection.json stays the journal.
  saved.promotion = fileSelectionPromotion(opts.db, saved, { slot });
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
  if (s.promotion) {
    const p = s.promotion;
    log(
      `default ${p.slot}: ${p.outcome}${p.challenger ? ` ${p.challenger}` : ""}${p.run ? ` (${p.run})` : ""} — ${p.reason}`,
    );
  }
  for (const [label, c] of Object.entries(s.leakAudit ?? {})) {
    log(`leak audit ${label}: ${hardLeaks(c) ? "LEAKS" : "clean"} — ${describeLeakCounts(c)}`);
  }
}

/** A slot value as a full forecast configuration (`{ configuration }` or the configuration). */
export function configFromSlot(value: unknown): ForecastConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const inner = (value as { configuration?: unknown }).configuration ?? value;
  try {
    return parseConfigs([inner])[0];
  } catch {
    // allow-empty-catch: a slot value that is not a forecast configuration is not usable here
    return undefined;
  }
}

/**
 * The configuration a live run files with — always with its disclosure line.
 *
 * Pick 1 on a named `board` resolves through `resolveDefault`: an explicit
 * `label` (the operator's `--config`), then the board's earned slot
 * `forecast-config:<board>`, then the family slot, then an upstream seed, then
 * today's built-in — the saved selection's pick (or the fallback). Other picks
 * (`rank` > 1) and calls without a board keep the selection file's order:
 * `label`, else pick number `rank` (1-based), else the fallback.
 */
export function liveConfig(opts: {
  selectionPath: string;
  label?: string;
  rank?: number;
  configsFile?: string;
  /** The board this live run files on (enables its earned slot). */
  board?: string;
  /** The ledger holding the board's promoted defaults. */
  db?: DefaultSlotReader;
}): { config: ForecastConfig; description: string; selected: boolean; source?: string } {
  const saved = existsSync(opts.selectionPath)
    ? (JSON.parse(readFileSync(opts.selectionPath, "utf8")) as SavedSelection)
    : undefined;
  const fromFile = opts.configsFile
    ? parseConfigs(JSON.parse(readFileSync(opts.configsFile, "utf8")))
    : [];
  let explicit: ForecastConfig | undefined;
  let c: ForecastConfig | undefined;
  let selected = false;
  if (opts.label) {
    explicit = fromFile.find((x) => x.label === opts.label) ?? saved?.configs[opts.label];
    if (!explicit)
      throw new Error(
        `no configuration ${opts.label} in ${opts.configsFile ?? opts.selectionPath}`,
      );
    c = explicit;
    selected = !!saved?.picked.includes(opts.label);
  } else if (saved?.picked.length) {
    const label = saved.picked[Math.min(saved.picked.length, opts.rank ?? 1) - 1]!;
    c = saved.configs[label];
    selected = true;
  }
  if (opts.board && (opts.rank ?? 1) === 1) {
    const resolved = resolveDefault<ForecastConfig>({
      slot: FORECAST_CONFIG_SLOT,
      board: opts.board,
      families: [FORECAST_FAMILY],
      surface: `${opts.board}:live`,
      env: { name: "--config", value: explicit },
      read: configFromSlot,
      builtIn: c ?? FALLBACK_CONFIG,
      builtInLabel: c ? "selection.json pick 1" : "fallback (not selected)",
      ...(opts.db ? { db: opts.db } : {}),
    });
    if (resolved.source !== "env" && resolved.source !== "builtin") {
      const via =
        resolved.source === "upstream"
          ? `seeded from upstream (${resolved.key})`
          : `earned default ${resolved.key}${resolved.incumbentRunId ? ` (run ${resolved.incumbentRunId})` : ""}`;
      return {
        config: resolved.value,
        description: `${describeConfig(resolved.value)}; ${via}`,
        selected: true,
        source: resolved.source,
      };
    }
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
