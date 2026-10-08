// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The reproduction kit's pure parts: doctor checks (mocked probe), plans and
// their dry-run text, and budget gating. No model call, server or benchmark run.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validGroupKey } from "../benchmarks/replicates";
import { blocking, doctor, modelTier, type Probe, subuidWidth } from "../benchmarks/repro/doctor";
import { budgetRefusal, parseDotEnv, renderPlan, withProviderEnv } from "../benchmarks/repro/run";
import {
  LEDGER_KEY,
  ledgerGroup,
  resolveModels,
  SETUPS,
  setupNamed,
  tau2ConfigTag,
} from "../benchmarks/repro/setups";
import type { CommandStep, ReproFlags, ServerStep } from "../benchmarks/repro/types";
import { isFeatureEnvName } from "../src/engine/feature-env";
import { scopeProcessState } from "./process-state";

function probe(over: Partial<Probe> = {}): Probe {
  return {
    env: {},
    which: () => false,
    run: () => undefined,
    readFile: () => undefined,
    disk: () => ({ freeBytes: 500 * 1024 ** 3, fsType: "ext4" }),
    exists: () => false,
    home: "/home/u",
    user: "u",
    ...over,
  };
}

const flags = (over: Partial<ReproFlags> = {}): ReproFlags => ({
  replicates: 2,
  budgetUsd: 10,
  seed: 42,
  runDir: "/runs/x",
  ledgerDb: "/runs/x/ledger.db",
  ...over,
});

describe("model tier", () => {
  it("classifies what intelligence is reachable", () => {
    expect(modelTier({ OPENROUTER_API_KEY: "k" })).toBe("frontier");
    expect(modelTier({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toBe("frontier");
    expect(modelTier({ GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g" })).toBe("single-provider");
    expect(modelTier({ OPENAI_API_KEY: "o" })).toBe("single-provider");
    expect(modelTier({ OLLAMA_BASE_URL: "http://localhost:11434/v1" })).toBe("single-local");
    expect(modelTier({ OPENAI_API_KEY: "" })).toBe("none");
  });
});

describe("repro doctor", () => {
  it("reports keys by name only and never their values", () => {
    const { checks } = doctor(probe({ env: { OPENROUTER_API_KEY: "sk-secret-value" } }), {
      runDir: "/runs",
    });
    expect(JSON.stringify(checks)).not.toContain("sk-secret-value");
    expect(checks.find((c) => c.id === "models")?.status).toBe("ok");
  });

  it("missing models blocks; optional keys only warn", () => {
    const { tier, checks } = doctor(probe(), { runDir: "/runs", only: ["models"] });
    expect(tier).toBe("none");
    expect(blocking(checks).map((c) => c.id)).toEqual(["models"]);
    expect(checks.find((c) => c.id === "optional-keys")?.status).toBe("warn");
  });

  it("flags podman without pasta, a narrow sub-UID range and a tmpfs TMPDIR, with fixes", () => {
    const { checks } = doctor(
      probe({
        which: (c) => c === "podman",
        readFile: (p) => (p === "/etc/subuid" ? "u:100000:65536\n" : undefined),
        disk: (p) =>
          p === "/tmp"
            ? { freeBytes: 2 * 1024 ** 3, fsType: "tmpfs" }
            : { freeBytes: 9e12, fsType: "ext4" },
      }),
      { runDir: "/runs" },
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId["podman-network"]?.status).toBe("warn");
    expect(byId["podman-network"]?.fix).toContain('netns = "pasta"');
    expect(byId.subuid?.status).toBe("warn");
    expect(byId.subuid?.fix).toContain("usermod --add-subuids");
    expect(byId.tmpdir?.status).toBe("warn");
    expect(byId["container-runtime"]?.status).toBe("warn"); // no API socket
  });

  it("accepts a configured pasta network and a τ² checkout", () => {
    const { checks } = doctor(
      probe({
        env: { TAU2_HOME: "/opt/tau2" },
        which: (c) => c === "podman",
        readFile: (p) =>
          p.endsWith("containers.conf") ? '[containers]\nnetns = "pasta"\n' : undefined,
        exists: (p) => p === "/opt/tau2/.venv/bin/tau2",
      }),
      { runDir: "/runs" },
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId["podman-network"]?.status).toBe("ok");
    expect(byId.tau2?.status).toBe("ok");
  });

  it("parses the sub-UID width for the user only", () => {
    expect(subuidWidth("a:100000:65536\nu:200000:300000\n", "u")).toBe(300000);
    expect(subuidWidth(undefined, "u")).toBe(0);
  });
});

describe("plans", () => {
  // Plans snapshot the operator's Marina feature settings (bun loads .env in
  // tests): clear them so every expectation is the same on every machine.
  let state: DisposableStack | undefined;
  beforeEach(() => {
    const cleared = Object.fromEntries(
      Object.keys(process.env)
        .filter(isFeatureEnvName)
        .map((k) => [k, undefined]),
    );
    state = scopeProcessState({ env: cleared });
  });
  afterEach(() => {
    state?.dispose();
    state = undefined;
  });

  it("every setup plans at every tier, with a dry-run that hides the ledger key", () => {
    for (const setup of SETUPS) {
      for (const tier of ["frontier", "single-provider", "single-local"] as const) {
        const plan = setup.plan(flags(), tier);
        expect(plan.steps.length).toBeGreaterThan(0);
        const text = renderPlan(plan, 10);
        expect(text).not.toContain(LEDGER_KEY);
        if (tier === "single-local") expect(plan.estimateUsd).toBe(0);
      }
    }
  });

  it("crew servers require a key and the bench uses that key, judged through Marina", () => {
    const plan = setupNamed("hle-verified")!.plan(flags({ arms: ["verify"] }), "frontier");
    const server = plan.steps.find((s): s is ServerStep => s.kind === "server")!;
    expect(server.env.MODEL_API_KEYS).toBe(LEDGER_KEY);
    expect(server.world).toBe("showcase");
    expect(server.operator?.[0]).toContain("crew formation answerer verification");
    const bench = plan.steps.find(
      (s): s is CommandStep => s.kind === "command" && s.label.includes("tier0"),
    )!;
    expect(bench.env?.MARINA_BENCH_API_KEY).toBe(LEDGER_KEY);
    expect(bench.argv).toContain("--base");
    expect(bench.argv).toContain("--judge-model");
  });

  it("each crew replicate is a fresh server", () => {
    const plan = setupNamed("hle-verified")!.plan(
      flags({ arms: ["verify"], replicates: 3 }),
      "frontier",
    );
    const servers = plan.steps.filter((s) => s.kind === "server");
    expect(new Set(servers.map((s) => (s as ServerStep).port)).size).toBe(3);
  });

  it("τ² runs the evaluator as shipped, with effort in extra_body and a stated user simulator", () => {
    const plan = setupNamed("tau2")!.plan(flags(), "frontier");
    const run = plan.steps.find(
      (s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"),
    )!;
    // Provider keys from .env, no base-URL override: τ²'s own judge reaches OpenAI.
    expect(run.providerEnv).toBe(true);
    expect(run.env?.OPENAI_BASE_URL).toBeUndefined();
    expect(run.env?.OPENAI_API_KEY).toBeUndefined();
    const arg = (flag: string) => JSON.parse(run.argv[run.argv.indexOf(flag) + 1]!);
    expect(arg("--agent-llm-args").extra_body).toEqual({ reasoning_effort: "high" });
    expect(arg("--agent-llm-args").reasoning_effort).toBeUndefined();
    expect(arg("--user-llm-args").extra_body).toEqual({ reasoning_effort: "low" });
    expect(run.argv[run.argv.indexOf("--user-llm") + 1]).toBe("openai/openrouter/openai/gpt-5.2");
    expect(plan.labels).toContain("agent reasoning_effort = high (extra_body)");
    expect(
      plan.labels.some((l) => l.startsWith("user simulator = openrouter/openai/gpt-5.2")),
    ).toBe(true);
    const convert = plan.steps.filter(
      (s): s is CommandStep => s.kind === "command" && s.argv.includes("convert"),
    );
    expect(convert.length).toBe(2);
    for (const c of convert) expect(c.argv).toContain("--require-clean");
  });

  it("τ² tags the agent's requests as a measurement (never the simulator's) and passes a review choice", () => {
    const setup = setupNamed("tau2")!;
    const run = (p: ReturnType<typeof setup.plan>) =>
      p.steps.find((s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"))!;
    const arg = (r: CommandStep, flag: string) => JSON.parse(r.argv[r.argv.indexOf(flag) + 1]!);
    const plain = run(setup.plan(flags({ domain: "retail" }), "frontier"));
    expect(arg(plain, "--agent-llm-args").extra_headers).toEqual({
      "x-marina-eval": "benchmark=tau2-retail; mode=measure",
    });
    expect(arg(plain, "--user-llm-args").extra_headers).toBeUndefined();
    const reviewed = run(setup.plan(flags({ domain: "retail", review: "auto" }), "frontier"));
    expect(arg(reviewed, "--agent-llm-args").extra_headers["x-marina-review"]).toBe("auto");
    expect(() => setup.plan(flags({ review: "max" }), "frontier")).toThrow("--review must be");
  });

  it("feature settings change the τ² save name and are filed with the result", () => {
    const setup = setupNamed("tau2")!;
    const saveTo = (p: ReturnType<typeof setup.plan>) =>
      p.steps
        .filter((s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"))
        .map((s) => s.argv[s.argv.indexOf("--save-to") + 1])[0];
    const importOf = (p: ReturnType<typeof setup.plan>) =>
      p.steps.find(
        (s): s is CommandStep =>
          s.kind === "command" && s.argv.includes("scripts/benchmark-import.ts"),
      )!;
    const plain = setup.plan(flags(), "frontier");
    const featured = setup.plan(
      flags({ serverEnv: { MARINA_OBLIGATIONS_REVIEW: "auto" } }),
      "frontier",
    );
    expect(saveTo(featured)).not.toBe(saveTo(plain));
    expect(importOf(plain).argv).not.toContain("--server-features");
    const imp = importOf(featured).argv;
    expect(JSON.parse(imp[imp.indexOf("--server-features") + 1]!)).toEqual({
      MARINA_OBLIGATIONS_REVIEW: "auto",
    });
  });

  it("τ² --split runs the whole named split, sized for the estimate", () => {
    const setup = setupNamed("tau2")!;
    const plan = setup.plan(
      flags({ domain: "retail", split: "test", effort: "medium", userEffort: "minimal" }),
      "frontier",
    );
    expect(plan.limit).toBe(40);
    const run = plan.steps.find(
      (s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"),
    )!;
    expect(run.argv).toContain("--task-split-name");
    expect(run.argv).not.toContain("--num-tasks");
    const arg = (flag: string) => JSON.parse(run.argv[run.argv.indexOf(flag) + 1]!);
    expect(arg("--agent-llm-args").extra_body.reasoning_effort).toBe("medium");
    expect(arg("--user-llm-args").extra_body.reasoning_effort).toBe("minimal");
    // Each run directory AND configuration gets its own τ² save name (τ² auto-resumes one).
    const saveTo = (p: ReturnType<typeof setup.plan>, arm = "single") =>
      p.steps
        .filter((s): s is CommandStep => s.kind === "command" && s.label.startsWith(`${arm}: τ²`))
        .map((s) => s.argv[s.argv.indexOf("--save-to") + 1])[0];
    expect(saveTo(plan)).toMatch(/^marina-repro-x-retail-test-single-[0-9a-f]{8}$/);
    expect(setup.plan(flags({ split: "test", limit: 5 }), "frontier").limit).toBe(5);
  });

  it("τ² obligations arm runs only when named, and --task-ids runs a fixed subset", () => {
    const setup = setupNamed("tau2")!;
    expect(setup.plan(flags({ domain: "retail", split: "test" }), "frontier").arms).toEqual([
      "single",
      "verify",
    ]);
    const plan = setup.plan(
      flags({
        arms: ["single", "obligations"],
        domain: "airline",
        taskIds: ["3", "1"],
        model: "anthropic/claude-fable-5-1",
      }),
      "frontier",
    );
    expect(plan.limit).toBe(2);
    const runs = plan.steps.filter(
      (s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"),
    );
    const agent = (s: CommandStep) => s.argv[s.argv.indexOf("--agent-llm") + 1];
    expect(runs.map(agent)).toEqual([
      "openai/anthropic/claude-fable-5-1",
      "openai/marina/obligations:anthropic/claude-fable-5-1",
    ]);
    for (const r of runs) {
      expect(r.argv.slice(r.argv.indexOf("--task-ids"), r.argv.indexOf("--task-ids") + 3)).toEqual([
        "--task-ids",
        "3",
        "1",
      ]);
      expect(r.argv).not.toContain("--num-tasks");
    }
    expect(() =>
      setup.plan(flags({ taskIds: ["1"], limit: 3, domain: "airline" }), "frontier"),
    ).toThrow("--task-ids");
  });

  it("τ² files an arm whose name holds `+` under a valid ledger group, compared by the same key", () => {
    const plan = setupNamed("tau2")!.plan(
      flags({ arms: ["single", "obligations+argcheck"], domain: "banking_knowledge" }),
      "frontier",
    );
    const groups = plan.steps
      .filter((s): s is CommandStep => s.kind === "command" && s.label.startsWith("ledger ←"))
      .map((s) => s.argv[s.argv.indexOf("--group") + 1]!);
    expect(groups).toEqual([
      "tau2-banking_knowledge-single",
      "tau2-banking_knowledge-obligations_argcheck",
    ]);
    for (const g of groups) expect(validGroupKey(g)).toBe(true);
    const compare = plan.steps.find((s) => s.kind === "compare") as { a: string; b: string };
    expect(compare).toMatchObject({ a: groups[1], b: groups[0] });
    expect(ledgerGroup("swebench", "a+b c")).toBe("swebench-a_b_c");
  });

  it("τ² never auto-resumes a results file of another configuration", () => {
    const setup = setupNamed("tau2")!;
    const saveTo = (f: Partial<ReproFlags>) =>
      setup
        .plan(flags({ domain: "retail", split: "test", ...f }), "frontier")
        .steps.filter(
          (s): s is CommandStep => s.kind === "command" && s.label.startsWith("single: τ²"),
        )
        .map((s) => s.argv[s.argv.indexOf("--save-to") + 1])[0];
    const base = saveTo({});
    // The same configuration resumes the same file …
    expect(saveTo({})).toBe(base);
    // … any change that alters the run starts another.
    for (const change of [
      { model: "openrouter/other/model" },
      { judge: "openrouter/other/judge" },
      { effort: "low" },
      { userEffort: "high" },
      { replicates: 3 },
      { limit: 7 },
    ] satisfies Partial<ReproFlags>[]) {
      expect(saveTo(change)).not.toBe(base);
    }
  });

  it("τ² --split base runs every task (leaderboard rule) and resumes an interrupted run", () => {
    const setup = setupNamed("tau2")!;
    for (const [domain, size] of [
      ["airline", 50],
      ["retail", 114],
      ["telecom", 114],
    ] as const) {
      const plan = setup.plan(flags({ domain, split: "base", replicates: 4 }), "frontier");
      expect(plan.limit).toBe(size);
      const run = plan.steps.find(
        (s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"),
      )!;
      expect(run.argv[run.argv.indexOf("--task-split-name") + 1]).toBe("base");
      expect(run.argv).not.toContain("--num-tasks");
      expect(run.argv).not.toContain("--task-ids");
      expect(run.argv).toContain("--auto-resume");
    }
    expect(() => setup.plan(flags({ split: "base", limit: 2 }), "frontier")).toThrow(
      /runs every task/,
    );
  });

  it("τ³ banking passes the board's retrieval config and requires the shell sandbox", () => {
    const setup = setupNamed("tau2")!;
    const runOf = (p: ReturnType<typeof setup.plan>) =>
      p.steps.find((s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"))!;
    const plan = setup.plan(
      flags({ domain: "banking_knowledge", split: "base", replicates: 4 }),
      "frontier",
    );
    expect(plan.limit).toBe(97);
    const run = runOf(plan);
    expect(run.argv[run.argv.indexOf("--retrieval-config") + 1]).toBe("alltools");
    expect(run.argv).not.toContain("--num-tasks");
    expect(plan.requires).toContain("tau2-knowledge-shell");
    expect(plan.requires).toContain("tau2-knowledge");
    expect(plan.labels.some((l) => l.startsWith("knowledge retrieval = alltools"))).toBe(true);
    // Another retrieval config is another configuration (its own τ² results file).
    const bm25 = setup.plan(
      flags({ domain: "banking_knowledge", split: "base", replicates: 4, retrievalConfig: "bm25" }),
      "frontier",
    );
    const saveTo = (r: CommandStep) => r.argv[r.argv.indexOf("--save-to") + 1];
    expect(saveTo(runOf(bm25))).not.toBe(saveTo(run));
    expect(bm25.requires).not.toContain("tau2-knowledge-shell");
    expect(bm25.requires).toContain("tau2-knowledge");
    // Other domains never get the flag, and their configuration tags are unchanged.
    const retail = runOf(setup.plan(flags({ domain: "retail", split: "test" }), "frontier"));
    expect(retail.argv).not.toContain("--retrieval-config");
    expect(saveTo(retail)).toBe(
      `marina-repro-x-retail-test-single-${tau2ConfigTag({
        agent: retail.argv[retail.argv.indexOf("--agent-llm") + 1]!.slice("openai/".length),
        user: "openrouter/openai/gpt-5.2",
        effort: "high",
        userEffort: "low",
        trials: 2,
        numTasks: null,
        split: "test",
        domain: "retail",
      })}`,
    );
    expect(() =>
      setup.plan(flags({ domain: "retail", retrievalConfig: "bm25" }), "frontier"),
    ).toThrow(/only to --domain banking_knowledge/);
  });

  it("the τ³ shell check names each missing tool", () => {
    const check = (missing: string[]) =>
      doctor(
        {
          ...probe({}),
          which: (cmd: string) => !missing.includes(cmd),
        },
        { runDir: "/x", only: ["tau2-knowledge-shell"] },
      ).checks.find((c) => c.id === "tau2-knowledge-shell")!;
    expect(check([]).status).toBe("ok");
    const miss = check(["srt", "socat"]);
    expect(miss.status).toBe("missing");
    expect(miss.detail).toBe("not on PATH: srt, socat");
  });

  it("the τ³ knowledge check imports τ²'s knowledge extra from TAU2_HOME's virtualenv", () => {
    const check = (imports: boolean) =>
      doctor(
        probe({
          env: { TAU2_HOME: "/opt/tau2" },
          run: (cmd) =>
            imports && cmd[0] === "/opt/tau2/.venv/bin/python" && cmd.at(-1)?.includes("rank_bm25")
              ? ""
              : undefined,
        }),
        { runDir: "/x", only: ["tau2-knowledge"] },
      ).checks.find((c) => c.id === "tau2-knowledge")!;
    expect(check(true).status).toBe("ok");
    expect(check(false).status).toBe("missing");
    expect(check(false).fix).toContain("[knowledge]");
  });

  it("the doctor requires the key τ²'s own judge reads, reporting it by name only", () => {
    const only = setupNamed("tau2")!.requires;
    expect(only).toContain("tau2-evaluator");
    const missing = doctor(probe(), { runDir: "/runs", only }).checks.find(
      (c) => c.id === "tau2-evaluator",
    )!;
    expect(missing.status).toBe("missing");
    expect(missing.fix).toContain("OPENAI_API_KEY");
    const ok = doctor(probe({ env: { OPENAI_API_KEY: "sk-hidden" } }), {
      runDir: "/runs",
      only,
    }).checks.find((c) => c.id === "tau2-evaluator")!;
    expect(ok.status).toBe("ok");
    expect(JSON.stringify(ok)).not.toContain("sk-hidden");
  });

  it("provider env fills keys from .env without overriding, and drops base-URL overrides", () => {
    const parsed = parseDotEnv(
      '# c\nexport OPENAI_API_KEY="sk-a"\nOPENROUTER_API_KEY=sk-b\nMARINA_WORLD=x\nBAD LINE\n',
    );
    expect(parsed).toEqual({
      OPENAI_API_KEY: "sk-a",
      OPENROUTER_API_KEY: "sk-b",
      MARINA_WORLD: "x",
    });
    const env = withProviderEnv(
      { OPENROUTER_API_KEY: "inherited", OPENAI_BASE_URL: "http://x/v1", OPENAI_API_BASE: "y" },
      parsed,
    );
    expect(env).toEqual({ OPENROUTER_API_KEY: "inherited", OPENAI_API_KEY: "sk-a" });
  });

  it("a single local model runs every arm, labelled honestly", () => {
    const m = resolveModels("single-local", flags());
    expect(m.answer).toBe("marina/default");
    expect(m.checker).toBe(m.answer);
    expect(m.labels).toContain("single local model");
    expect(m.labels.some((l) => l.includes("self-check"))).toBe(true);
  });

  it("unknown arms are refused with the valid choices", () => {
    expect(() => setupNamed("tau2")!.plan(flags({ arms: ["nope"] }), "frontier")).toThrow(
      /single, verify/,
    );
  });

  it("swebench-verified: every step reads the same subset, after an export step", () => {
    const plan = setupNamed("swebench-verified")!.plan(
      flags({ limit: 10, seed: 42, replicates: 1, arms: ["single"] }),
      "frontier",
    );
    const cmds = plan.steps.filter((s): s is CommandStep => s.kind === "command");
    const sub = (c: CommandStep) => c.argv[2];
    expect(cmds.map(sub)).toEqual(["export", "subset", "run", "score", "file"]);
    for (const c of cmds) {
      const arg = (flag: string) => c.argv[c.argv.indexOf(flag) + 1];
      // run and file must name the subset `subset` wrote (subset-n10-s42.txt), so the
      // ids file exists and the ledger records the seed actually used.
      expect(arg("--n")).toBe("10");
      expect(arg("--seed")).toBe("42");
      expect(arg("--data")).toBe("/runs/x/swebench");
    }
    const run = cmds.find((c) => sub(c) === "run")!;
    expect(run.argv).toContain("--mirror-cache");
    const file = cmds.find((c) => sub(c) === "file")!;
    expect(file.argv[file.argv.indexOf("--db") + 1]).toBe("/runs/x/ledger.db");
    expect(renderPlan(plan, 100)).toContain("--n 10 --seed 42");
  });

  it("compares each arm against the first, by replicate group", () => {
    const plan = setupNamed("swebench-verified")!.plan(flags(), "frontier");
    const cmp = plan.steps.filter((s) => s.kind === "compare");
    expect(cmp).toEqual([
      {
        kind: "compare",
        benchmark: "swebench-verified",
        a: "swebench-verify",
        b: "swebench-single",
      },
    ]);
  });
});

describe("budget", () => {
  it("refuses a plan whose estimate exceeds the budget", () => {
    const plan = setupNamed("swebench-verified")!.plan(flags({ limit: 500 }), "frontier");
    expect(budgetRefusal(plan, 10)).toMatch(/exceeds --budget-usd/);
    expect(budgetRefusal(plan, 1_000)).toBeUndefined();
    expect(budgetRefusal(plan, Number.NaN)).toMatch(/non-negative/);
  });

  it("smoke defaults stay small", () => {
    for (const s of SETUPS) expect(s.smoke).toBeLessThanOrEqual(20);
  });
});
