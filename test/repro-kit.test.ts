// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The reproduction kit's pure parts: doctor checks (mocked probe), plans and
// their dry-run text, and budget gating. No model call, server or benchmark run.

import { describe, expect, it } from "bun:test";
import { blocking, doctor, modelTier, type Probe, subuidWidth } from "../benchmarks/repro/doctor";
import { budgetRefusal, renderPlan } from "../benchmarks/repro/run";
import { LEDGER_KEY, resolveModels, SETUPS, setupNamed } from "../benchmarks/repro/setups";
import type { CommandStep, ReproFlags, ServerStep } from "../benchmarks/repro/types";

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

  it("τ² exports the base URL and key for components that ignore api_base", () => {
    const plan = setupNamed("tau2")!.plan(flags(), "frontier");
    const run = plan.steps.find(
      (s): s is CommandStep => s.kind === "command" && s.label.includes("τ²"),
    )!;
    expect(run.env?.OPENAI_BASE_URL).toMatch(/^http:\/\/localhost:\d+\/v1$/);
    expect(run.env?.OPENAI_API_KEY).toBe(LEDGER_KEY);
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
