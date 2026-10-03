// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The published benchmark setups, as plan builders. Each builder is pure: it
 * turns flags plus the model tier into isolated servers, commands, ledger
 * imports and a pooled comparison. Every setup runs at every tier — with one
 * local model, verification is the model checking itself and the judge is the
 * same model, and the plan says so in its labels.
 *
 * Mechanics carried here so a reader never has to rediscover them:
 * - crew servers require `MODEL_API_KEYS`; the bench key is that key ("open" is
 *   rejected once keys are set), so runs can file into the ledger;
 * - graded items are judged THROUGH a Marina server, never straight at a vendor;
 * - crews get a long per-item limit (the harness default for marina targets) and
 *   a server request timeout above it;
 * - every replicate of a crew arm is a fresh server (independent draws);
 * - scratch lives under the run directory on disk (`TMPDIR`), never a tmpfs;
 * - τ²'s own evaluator (the NL-assertion judge) calls its shipped default model with
 *   the provider keys from the ENVIRONMENT, ignoring `api_base`: the τ² process gets the
 *   operator's `.env` provider keys and no base-URL override, or those tasks end as
 *   infrastructure errors;
 * - τ² sets LiteLLM `drop_params`, which silently strips a top-level `reasoning_effort`
 *   for model ids LiteLLM does not know (every Marina-routed id): effort goes in
 *   `extra_body`, stated for the agent and the user simulator alike;
 * - a τ² run with any infrastructure error is invalid: `tau2 convert --require-clean`
 *   writes no ledger file, so nothing is compared or reported from it.
 */

import { basename, join } from "node:path";
import type {
  ArmSpec,
  CommandStep,
  ModelTier,
  Plan,
  ReproFlags,
  ServerStep,
  Setup,
  Step,
} from "./types";

/** Placeholder the runner replaces with a fresh per-run key (never printed). */
export const LEDGER_KEY = "$LEDGER_KEY";
const BASE_PORT = 47_100;

const FRONTIER = {
  strong: "openrouter/anthropic/claude-opus-5.5",
  value: "openrouter/openai/gpt-6.1-sol",
  judge: "openrouter/openai/gpt-6.1-sol",
};

interface Models {
  answer: string;
  checker: string;
  judge: string;
  labels: string[];
}

/** Resolve answer / checker / judge models for a tier, honouring explicit flags. */
export function resolveModels(
  tier: ModelTier,
  flags: ReproFlags,
  frontierAnswer = FRONTIER.value,
  frontierChecker = FRONTIER.strong,
): Models {
  const labels: string[] = [];
  if (tier === "frontier") {
    return {
      answer: flags.model ?? frontierAnswer,
      checker: flags.checker ?? flags.model ?? frontierChecker,
      judge: flags.judge ?? FRONTIER.judge,
      labels,
    };
  }
  const answer = flags.model ?? "marina/default";
  const checker = flags.checker ?? answer;
  const judge = flags.judge ?? answer;
  if (tier === "single-local") labels.push("single local model");
  if (tier === "single-provider") labels.push("single provider");
  if (checker === answer) labels.push("verification = self-check (one model)");
  if (judge === answer) labels.push("judge = the answer model (not independent)");
  return { answer, checker, judge, labels };
}

function serverEnv(world: string, spendCapUsd: number, extra: Record<string, string> = {}) {
  return {
    MARINA_WORLD: world,
    MARINA_ROOM_AGENTS: "false",
    MODEL_API_KEYS: LEDGER_KEY,
    MARINA_OPEN_API: "true",
    MODEL_REQUEST_TIMEOUT_MS: "1200000",
    MARINA_EVENT_RETENTION: "2000000",
    MARINA_DAILY_SPEND_CAP_USD: String(Math.max(1, Math.ceil(spendCapUsd))),
    ...extra,
  };
}

function plainServer(id: string, port: number, spendCapUsd: number): ServerStep {
  return {
    kind: "server",
    id,
    port,
    world: "empty",
    env: serverEnv("empty", spendCapUsd, { AGENT_AUTORESPAWN: "false" }),
  };
}

function crewServer(
  id: string,
  port: number,
  formation: string,
  models: Models,
  spendCapUsd: number,
): ServerStep {
  const agentModels: Record<string, string> =
    models.checker === models.answer ? {} : { MARINA_AGENT_MODELS: `Skeptic=${models.checker}` };
  return {
    kind: "server",
    id,
    port,
    world: "showcase",
    env: serverEnv("showcase", spendCapUsd, {
      AGENT_AUTORESPAWN: "true",
      MARINA_ADMINS: "Operator",
      MARINA_CREW_MODEL: models.answer,
      MARINA_ANSWERER_COUNT: "1",
      MARINA_ENDPOINTS: "none",
      ...agentModels,
    }),
    operator: [
      ...(formation === "freeform" ? [] : [`crew formation answerer ${formation}`]),
      "crew dispatch answerer Adopt your formation for incoming model requests on model-answerer. Answer each request with the final answer in the requested format.",
    ],
    waitModel: "marina:answerer",
  };
}

function importStep(
  flags: ReproFlags,
  dir: string,
  kind: "model" | "crew",
  target: string,
  group: string,
): CommandStep {
  return {
    kind: "command",
    label: `ledger ← ${group}`,
    argv: [
      "bun",
      "scripts/benchmark-import.ts",
      dir,
      "--target-kind",
      kind,
      "--target",
      target,
      "--label",
      group,
      "--group",
      group,
    ],
    env: { DB_PATH: flags.ledgerDb },
  };
}

function armsOf(setup: { arms: ArmSpec[] }, flags: ReproFlags): ArmSpec[] {
  if (!flags.arms?.length) return setup.arms;
  const unknown = flags.arms.filter((a) => !setup.arms.some((s) => s.name === a));
  if (unknown.length) {
    throw new Error(
      `unknown arm(s) ${unknown.join(", ")} — choose from ${setup.arms.map((a) => a.name).join(", ")}`,
    );
  }
  return setup.arms.filter((a) => flags.arms!.includes(a.name));
}

function estimate(arms: ArmSpec[], tier: ModelTier, items: number, replicates: number): number {
  if (tier === "single-local" || tier === "none") return 0;
  return arms.reduce((t, a) => t + a.usdPerItem * items * replicates, 0);
}

function comparisons(benchmark: string, setup: string, arms: ArmSpec[]): Step[] {
  // Each later arm against the first (the base): A = treatment, B = base.
  const [base, ...rest] = arms;
  if (!base) return [];
  return rest.map((a) => ({
    kind: "compare" as const,
    benchmark,
    a: `${setup}-${a.name}`,
    b: `${setup}-${base.name}`,
  }));
}

function finish(
  setup: Setup,
  flags: ReproFlags,
  tier: ModelTier,
  arms: ArmSpec[],
  limit: number,
  labels: string[],
  steps: Step[],
): Plan {
  return {
    setup: setup.name,
    tier,
    arms: arms.map((a) => a.name),
    replicates: flags.replicates,
    limit,
    estimateUsd: estimate(arms, tier, limit, flags.replicates),
    armNotes: arms.map(
      (a) =>
        `${a.name}: ${a.describe}${tier === "frontier" ? ` (~$${a.usdPerItem.toFixed(3)}/item)` : ""}`,
    ),
    requires: setup.requires,
    labels,
    steps,
  };
}

// ─── HLE-Verified: single model vs verification crew ─────────────────────────

const hle: Setup = {
  name: "hle-verified",
  summary:
    "HLE-Verified Gold (text) — one model alone vs a Marina verification crew, judged through Marina.",
  smoke: 20,
  full: 200,
  arms: [
    {
      name: "single",
      describe: "the answer model alone, through a Marina server",
      usdPerItem: 0.04,
    },
    {
      name: "verify",
      describe: "a verification crew (lead = answer model, Skeptic = checker)",
      usdPerItem: 0.15,
    },
  ],
  requires: ["models", "tmpdir", "disk"],
  plan(flags, tier) {
    const arms = armsOf(this, flags);
    const limit = flags.limit ?? this.smoke;
    const m = resolveModels(tier, flags, FRONTIER.strong, FRONTIER.strong);
    const share = Math.max(5, flags.budgetUsd / Math.max(1, arms.length * flags.replicates));
    const steps: Step[] = [];
    let port = BASE_PORT;
    for (const arm of arms) {
      for (let r = 1; r <= flags.replicates; r++) {
        const id = `hle-${arm.name}-r${r}`;
        const out = join(flags.runDir, "results", id);
        const p = port++;
        const server =
          arm.name === "single"
            ? plainServer(id, p, share)
            : crewServer(id, p, "verification", m, share);
        steps.push(server);
        const endpoint =
          arm.name === "single"
            ? ["--endpoint", `http://localhost:${p}`, "--model", m.answer]
            : ["--endpoint", "marina:answerer", "--base", `http://localhost:${p}`];
        steps.push({
          kind: "command",
          label: `${id}: tier0 hle ${limit}`,
          argv: [
            "bun",
            "benchmarks/tier0.ts",
            ...endpoint,
            "--hle",
            String(limit),
            "--gpqa",
            "0",
            "--frames",
            "0",
            "--seed",
            String(flags.seed),
            "--concurrency",
            "2",
            "--judge-model",
            m.judge,
            "--file-to",
            `http://localhost:${p}`,
            "--group",
            `hle-verified-${arm.name}`,
            "--out-dir",
            out,
          ],
          env: { MARINA_BENCH_API_KEY: LEDGER_KEY, MARINA_LEDGER_API_KEY: LEDGER_KEY },
          needs: [id],
        });
        steps.push({ kind: "stop", id });
        steps.push(
          importStep(
            flags,
            out,
            arm.name === "single" ? "model" : "crew",
            arm.name === "single"
              ? m.answer
              : JSON.stringify({ formation: "verification", lead: m.answer, skeptic: m.checker }),
            `hle-verified-${arm.name}`,
          ),
        );
      }
    }
    steps.push(...comparisons("hle-verified-gold", "hle-verified", arms));
    return finish(this, flags, tier, arms, limit, m.labels, steps);
  },
};

// ─── SWE-bench Verified: agentless single vs verify ──────────────────────────

const swebench: Setup = {
  name: "swebench-verified",
  summary:
    "SWE-bench Verified — one model patches alone vs a patch reviewed by a checker; official harness, unmodified.",
  smoke: 10,
  full: 500,
  arms: [
    { name: "single", describe: "the answer model writes the patch alone", usdPerItem: 0.09 },
    { name: "verify", describe: "the answer model patches, the checker reviews", usdPerItem: 0.2 },
  ],
  requires: ["models", "container-runtime", "podman-network", "python-swebench", "tmpdir", "disk"],
  plan(flags, tier) {
    const arms = armsOf(this, flags);
    const limit = flags.limit ?? this.smoke;
    const m = resolveModels(tier, flags);
    const data = join(flags.runDir, "swebench");
    const common = ["--data", data];
    const steps: Step[] = [
      {
        kind: "command",
        label: `subset ${limit} (seed ${flags.seed})`,
        argv: [
          "bun",
          "scripts/swebench.ts",
          "subset",
          "--n",
          String(limit),
          "--seed",
          String(flags.seed),
          ...common,
        ],
      },
    ];
    for (const arm of arms) {
      for (let r = 1; r <= flags.replicates; r++) {
        const run = [
          "bun",
          "scripts/swebench.ts",
          "run",
          "--arm",
          arm.name,
          "--model",
          m.answer,
          "--replicate",
          String(r),
          ...(arm.name === "verify" ? ["--review-model", m.checker] : []),
          ...(flags.envImage ? ["--env-image"] : []),
          ...common,
        ];
        steps.push({ kind: "command", label: `${arm.name} r${r}: patches`, argv: run });
        steps.push({
          kind: "command",
          label: `${arm.name} r${r}: official harness`,
          argv: [
            "bun",
            "scripts/swebench.ts",
            "score",
            "--arm",
            arm.name,
            "--replicate",
            String(r),
            ...common,
          ],
        });
        steps.push({
          kind: "command",
          label: `${arm.name} r${r}: ledger`,
          argv: [
            "bun",
            "scripts/swebench.ts",
            "file",
            "--arm",
            arm.name,
            "--replicate",
            String(r),
            "--db",
            flags.ledgerDb,
            "--group",
            `swebench-${arm.name}`,
            ...common,
          ],
        });
      }
    }
    steps.push(...comparisons("swebench-verified", "swebench", arms));
    const labels = [...m.labels, flags.envImage ? "full agent (env images)" : "agentless"];
    return finish(this, flags, tier, arms, limit, labels, steps);
  },
};

// ─── τ²-bench: one model vs marina/verify ────────────────────────────────────

/** τ²'s recommended user simulator (shown on its leaderboard). */
const TAU2_USER_SIMULATOR = "openrouter/openai/gpt-5.2";

/** Task counts of the τ² splits this kit names, for the cost estimate. */
const TAU2_SPLIT_SIZES: Record<string, number> = {
  "airline/test": 20,
  "retail/test": 40,
};

/**
 * LiteLLM args for a Marina-routed τ² model. `reasoning_effort` rides in `extra_body`:
 * τ² sets `drop_params`, and LiteLLM drops a top-level `reasoning_effort` for ids it
 * does not recognise, which is every id routed through Marina.
 */
export function tau2LlmArgs(apiBase: string, effort: string): string {
  return JSON.stringify({
    api_base: apiBase,
    api_key: LEDGER_KEY,
    extra_body: { reasoning_effort: effort },
  });
}

const tau2: Setup = {
  name: "tau2",
  summary:
    "τ²-bench — the official CLI, simulator and evaluator, with the agent served by Marina: one model vs `marina/verify`.",
  smoke: 10,
  full: 50,
  arms: [
    { name: "single", describe: "the answer model as the agent", usdPerItem: 0.05 },
    {
      name: "verify",
      describe: "`marina/verify:<answer>[+<checker>]` as the agent",
      usdPerItem: 0.24,
    },
  ],
  requires: ["models", "tau2", "tau2-evaluator", "tmpdir"],
  plan(flags, tier) {
    const arms = armsOf(this, flags);
    const domain = flags.domain ?? "airline";
    // A named split without --limit runs the whole split (sized for the estimate).
    const splitSize = flags.split ? TAU2_SPLIT_SIZES[`${domain}/${flags.split}`] : undefined;
    const limit = flags.limit ?? splitSize ?? this.smoke;
    const m = resolveModels(tier, flags, FRONTIER.value, FRONTIER.value);
    // τ²'s recommended user simulator at the frontier tier; --judge overrides it.
    if (tier === "frontier" && !flags.judge) m.judge = TAU2_USER_SIMULATOR;
    const effort = flags.effort ?? "high";
    const userEffort = flags.userEffort ?? "low";
    const port = BASE_PORT + 50;
    const base = `http://localhost:${port}/v1`;
    const steps: Step[] = [plainServer("tau2", port, flags.budgetUsd)];
    for (const arm of arms) {
      const agent =
        arm.name === "single"
          ? m.answer
          : `marina/verify:${m.answer}${m.checker !== m.answer ? `+${m.checker}` : ""}`;
      // τ² writes data/simulations/<name>/results.json under its own checkout and offers
      // to resume an existing one, so the name carries the run directory's.
      const name = `marina-repro-${basename(flags.runDir)}-${domain}${flags.split ? `-${flags.split}` : ""}-${arm.name}`;
      const results = `$TAU2_HOME/data/simulations/${name}/results.json`;
      const ledgerFile = join(flags.runDir, "results", `${name}-ledger.json`);
      const agentArgs = tau2LlmArgs(base, effort);
      const userArgs = tau2LlmArgs(base, userEffort);
      steps.push({
        kind: "command",
        label: `${arm.name}: τ² ${domain}${flags.split ? ` (${flags.split})` : ""} × ${flags.replicates} trials`,
        argv: [
          "$TAU2_HOME/.venv/bin/tau2",
          "run",
          "--domain",
          domain,
          ...(flags.split ? ["--task-split-name", flags.split] : []),
          "--agent-llm",
          `openai/${agent}`,
          "--agent-llm-args",
          agentArgs,
          "--user-llm",
          `openai/${m.judge}`,
          "--user-llm-args",
          userArgs,
          "--num-trials",
          String(flags.replicates),
          ...(flags.limit !== undefined || !splitSize ? ["--num-tasks", String(limit)] : []),
          "--max-concurrency",
          "4",
          "--save-to",
          name,
        ],
        cwd: "$TAU2_HOME",
        providerEnv: true,
        needs: ["tau2"],
      });
      steps.push({
        kind: "command",
        label: `${arm.name}: convert for the ledger (refused on infrastructure errors)`,
        argv: [
          "bun",
          "scripts/tau2.ts",
          "convert",
          results,
          "--out",
          ledgerFile,
          "--require-clean",
        ],
      });
      steps.push(importStep(flags, ledgerFile, "model", agent, `tau2-${domain}-${arm.name}`));
    }
    steps.push({ kind: "stop", id: "tau2" });
    steps.push(...comparisons(`tau2-${domain}`, `tau2-${domain}`, arms));
    const labels = [
      ...m.labels,
      `agent reasoning_effort = ${effort} (extra_body)`,
      `user simulator = ${m.judge} (reasoning_effort = ${userEffort}, extra_body)`,
      "evaluator = τ² as shipped, with the operator's provider keys",
    ];
    return finish(this, flags, tier, arms, limit, labels, steps);
  },
};

// ─── FutureX clean backtest ──────────────────────────────────────────────────

const futurex: Setup = {
  name: "futurex-backtest",
  summary:
    "FutureX resolved questions, forecast with date-bounded research only (no leakage), scored locally.",
  smoke: 20,
  full: 160,
  arms: [
    { name: "cheap", describe: "built-in `cheap` forecast variant", usdPerItem: 0.09 },
    { name: "verify", describe: "built-in `verify` forecast variant", usdPerItem: 0.2 },
  ],
  requires: ["models", "tmpdir"],
  plan(flags, tier) {
    const arms = armsOf(this, flags);
    const limit = flags.limit ?? this.smoke;
    const m = resolveModels(tier, flags);
    const steps: Step[] = arms.map((arm) => ({
      kind: "command" as const,
      label: `${arm.name}: clean backtest (asof isolation)`,
      argv: [
        "bun",
        "scripts/futurex.ts",
        "backtest",
        "--clean",
        "--isolation",
        "asof",
        "--variant",
        arm.name,
        "--limit",
        String(limit),
        "--replicates",
        String(flags.replicates),
        "--dir",
        join(flags.runDir, "futurex"),
      ],
      env: {
        DB_PATH: flags.ledgerDb,
        // At a single tier every forecast stage uses the one available model.
        ...(tier === "frontier"
          ? {}
          : {
              MARINA_FORECAST_ANALYSTS: m.answer,
              MARINA_FORECAST_PLANNER: m.answer,
              MARINA_FORECAST_CRITIC: m.answer,
              MARINA_FORECAST_VERIFIER: m.checker,
            }),
      },
    }));
    const labels = [...m.labels, "isolation = date-bounded search (asof)"];
    return finish(this, flags, tier, arms, limit, labels, steps);
  },
};

// ─── Social Simulation Arena backtest ────────────────────────────────────────

const arena: Setup = {
  name: "arena-backtest",
  summary:
    "MIT Social Simulation Arena resolved rounds, in lock order with no outcome before its release — keyless.",
  smoke: 0,
  full: 0,
  arms: [
    { name: "baseline", describe: "persistence with fitted spread", usdPerItem: 0 },
    { name: "nowcast", describe: "freshest official reading at the lock", usdPerItem: 0 },
  ],
  requires: ["tmpdir"],
  plan(flags, tier) {
    const arms = armsOf(this, flags);
    const steps: Step[] = arms
      .filter((a) => a.name !== "baseline")
      .map((arm) => ({
        kind: "command" as const,
        label: `${arm.name} vs baseline: arena evaluate`,
        argv: ["bun", "scripts/arena.ts", "evaluate", "--forecaster", arm.name],
        env: { DB_PATH: join(flags.runDir, "arena.db") },
      }));
    return finish(this, flags, tier, arms, 0, ["keyless; scored on resolved rounds only"], steps);
  },
};

export const SETUPS: readonly Setup[] = [hle, swebench, tau2, futurex, arena];

export function setupNamed(name: string): Setup | undefined {
  return SETUPS.find((s) => s.name === name);
}
