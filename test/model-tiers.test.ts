// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import {
  BUILTIN_CHEAP_MODELS,
  builtinCheapModel,
  crewModelFromEnv,
  describeModelTiers,
  MODEL_ROLES,
  type ModelRole,
  residentDefaultModel,
  resolveTierAlias,
  roleModel,
  roleModelFromEnv,
  roleModelOverrides,
  roleOverrideProblems,
  strongRoleOverride,
  tierAliasOf,
  tierModel,
} from "../src/config/model-tiers";
import { defaultBenchmarkJudge, resolveBenchmarkJudge } from "../src/engine/benchmark-judge";
import { tierRequestModel } from "../src/net/model-api/upstream";
import { MarinaDB } from "../src/persistence/database";
import { agentModelMapProblems, resetSeededAgentNamesForTests } from "../worlds/seed";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

const OR = { OPENROUTER_API_KEY: "sk-or" };
const CHEAP_OR = "openrouter/deepseek/deepseek-v4.1-flash";

describe("tier aliases", () => {
  it("recognises marina/cheap, marina:cheap, bare cheap (any case) and the strong forms", () => {
    for (const m of ["marina/cheap", "marina:cheap", "cheap", "Marina/Cheap"])
      expect(tierAliasOf(m)).toBe("cheap");
    for (const m of ["marina/strong", "marina:strong", "strong"])
      expect(tierAliasOf(m)).toBe("strong");
    for (const m of ["marina/default", "marina", "openrouter/cheap", "cheapest", undefined, 3])
      expect(tierAliasOf(m)).toBeUndefined();
  });
});

describe("the cheap tier", () => {
  it("built-in: the first provider with a key, OpenRouter's DeepSeek flash first", () => {
    expect(BUILTIN_CHEAP_MODELS[0]).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(builtinCheapModel({ env: { ...OR, ANTHROPIC_API_KEY: "a" } }).model).toBe(CHEAP_OR);
    expect(builtinCheapModel({ env: { ANTHROPIC_API_KEY: "a" } }).model).toBe(
      "anthropic/claude-haiku-5-5",
    );
    expect(builtinCheapModel({ env: { OPENAI_API_KEY: "o" } }).model).toBe("openai/gpt-6-luna");
    expect(builtinCheapModel({ env: { GEMINI_API_KEY: "g" } }).model).toBe(
      "google/gemini-3.1-flash-lite",
    );
    // A key only an admin-panel lookup knows about counts too.
    expect(builtinCheapModel({ env: {}, hasKey: (p) => p === "deepseek" }).model).toBe(
      "deepseek/deepseek-flash",
    );
  });

  it("built-in falls back to marina/default with no cheap model, and with a local runtime", () => {
    expect(builtinCheapModel({ env: {} }).model).toBe("marina/default");
    expect(builtinCheapModel({ env: { XAI_API_KEY: "x" } }).model).toBe("marina/default");
    expect(
      builtinCheapModel({ env: { ...OR, OLLAMA_BASE_URL: "http://127.0.0.1:11434" } }),
    ).toEqual({ model: "marina/default", source: "built-in (local runtime)" });
  });

  it("MARINA_MODEL_TIER_CHEAP wins; an explicit default wins over the built-in", () => {
    expect(tierModel("cheap", { env: { ...OR, MARINA_MODEL_TIER_CHEAP: "a/b" } })).toEqual({
      model: "a/b",
      source: "env:MARINA_MODEL_TIER_CHEAP",
    });
    expect(tierModel("cheap", { env: { ...OR, MARINA_DEFAULT_MODEL: "openai/x" } }).model).toBe(
      "openai/x",
    );
    expect(tierModel("cheap", { env: OR, runtimeDefault: "anthropic/y" }).model).toBe(
      "anthropic/y",
    );
    // The runtime default beats the env default, as it always has.
    expect(
      tierModel("cheap", {
        env: { MARINA_DEFAULT_MODEL: "openai/x" },
        runtimeDefault: "anthropic/y",
      }).model,
    ).toBe("anthropic/y");
    // An explicit `marina/default` is an explicit choice: kept.
    expect(
      tierModel("cheap", { env: { ...OR, MARINA_DEFAULT_MODEL: "marina/default" } }).model,
    ).toBe("marina/default");
    // A default naming the cheap tier itself is not a loop.
    expect(tierModel("cheap", { env: { ...OR, MARINA_DEFAULT_MODEL: "marina/cheap" } }).model).toBe(
      CHEAP_OR,
    );
    // Blank values are unset.
    expect(
      tierModel("cheap", { env: { ...OR, MARINA_MODEL_TIER_CHEAP: " ", MARINA_DEFAULT_MODEL: "" } })
        .model,
    ).toBe(CHEAP_OR);
  });

  it("per-provider defaults shape marina/default, not the cheap tier", () => {
    const env = { ...OR, MARINA_DEFAULT_OPENROUTER_MODEL: "anthropic/claude-opus-5.5" };
    expect(tierModel("cheap", { env }).model).toBe(CHEAP_OR);
  });
});

describe("the strong tier", () => {
  it("is marina/default unless MARINA_MODEL_TIER_STRONG is set, whatever the cheap tier says", () => {
    expect(tierModel("strong", { env: { ...OR, MARINA_MODEL_TIER_CHEAP: "a/b" } }).model).toBe(
      "marina/default",
    );
    expect(tierModel("strong", { env: { MARINA_MODEL_TIER_STRONG: "anthropic/o" } }).model).toBe(
      "anthropic/o",
    );
  });
});

describe("resolveTierAlias", () => {
  it("maps an alias to the tier's model now; anything else is untouched", () => {
    expect(resolveTierAlias("cheap", { env: OR })?.model).toBe(CHEAP_OR);
    expect(resolveTierAlias("marina/strong", { env: OR })?.model).toBe("marina/default");
    expect(resolveTierAlias("marina/default", { env: OR })).toBeUndefined();
    expect(resolveTierAlias("openai/gpt-6-luna", { env: OR })).toBeUndefined();
  });

  it("follows one alias hop and never loops", () => {
    const env = { MARINA_MODEL_TIER_CHEAP: "marina/strong", MARINA_MODEL_TIER_STRONG: "x/y" };
    expect(resolveTierAlias("cheap", { env })?.model).toBe("x/y");
    const loop = { MARINA_MODEL_TIER_CHEAP: "marina/strong", MARINA_MODEL_TIER_STRONG: "cheap" };
    expect(resolveTierAlias("cheap", { env: loop })?.model).toBe("marina/default");
    expect(resolveTierAlias("strong", { env: { MARINA_MODEL_TIER_STRONG: "strong" } })?.model).toBe(
      "marina/default",
    );
  });
});

describe("roles", () => {
  const cheapRoles = Object.entries(MODEL_ROLES)
    .filter(([, i]) => i.tier === "cheap")
    .map(([r]) => r as ModelRole);
  const strongRoles = Object.entries(MODEL_ROLES)
    .filter(([, i]) => i.tier === "strong")
    .map(([r]) => r as ModelRole);

  it("cheap roles get the live alias; strong roles never the cheap tier", () => {
    expect(cheapRoles.sort()).toEqual(["crew", "helper", "resident", "room"]);
    for (const r of cheapRoles) expect(roleModelFromEnv(r, OR)).toBe("marina/cheap");
    const env = { ...OR, MARINA_MODEL_TIER_CHEAP: "cheap/model", MARINA_DEFAULT_MODEL: "d/m" };
    for (const r of strongRoles) expect(roleModelFromEnv(r, env)).toBe("marina/default");
    for (const r of strongRoles)
      expect(roleModelFromEnv(r, { MARINA_MODEL_TIER_STRONG: "s/m" })).toBe("s/m");
  });

  it("precedence: the role's own knob, then role:<role>=, then the tier", () => {
    const env = { MARINA_AGENT_MODELS: "Host=a/b, role:crew=c/d ,ROLE:Judge=e/f" };
    expect(roleModelOverrides(env)).toEqual(
      new Map([
        ["crew", "c/d"],
        ["judge", "e/f"],
      ]),
    );
    expect(roleModel("crew", { env })).toEqual({
      model: "c/d",
      source: "MARINA_AGENT_MODELS role:crew",
    });
    expect(
      roleModel("crew", { env, knob: { name: "MARINA_CREW_MODEL", value: "k/m" } }).model,
    ).toBe("k/m");
    expect(crewModelFromEnv({ ...env, MARINA_CREW_MODEL: "k/m" })).toBe("k/m");
    expect(crewModelFromEnv(env)).toBe("c/d");
    expect(crewModelFromEnv({ MARINA_CREW_MODEL: "" })).toBe("marina/cheap");
    expect(roleModelFromEnv("judge", env)).toBe("e/f");
  });

  it("residents keep an explicit default; the runtime default wins over the env one", () => {
    expect(residentDefaultModel(undefined, {})).toBe("marina/cheap");
    expect(residentDefaultModel(undefined, { MARINA_DEFAULT_MODEL: "openai/x" })).toBe("openai/x");
    expect(
      residentDefaultModel(
        { getSetting: () => "anthropic/y" },
        { MARINA_DEFAULT_MODEL: "openai/x" },
      ),
    ).toBe("anthropic/y");
    expect(
      residentDefaultModel(
        { getSetting: () => "anthropic/y" },
        { MARINA_AGENT_MODELS: "role:resident=r/m" },
      ),
    ).toBe("r/m");
  });

  it("an unknown role is reported, and agentModelMapProblems carries it", () => {
    const env = { MARINA_AGENT_MODELS: "role:crew=a/b,role:jugde=c/d" };
    expect(roleOverrideProblems(env)).toHaveLength(1);
    expect(roleOverrideProblems(env)[0]).toContain('"role:jugde"');
    resetSeededAgentNamesForTests();
    const problems = agentModelMapProblems(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("role:jugde");
  });

  it("the Arbiter keeps its pipeline default unless a role entry or the strong tier says", () => {
    expect(strongRoleOverride("arbiter", {})).toBeUndefined();
    expect(strongRoleOverride("arbiter", { MARINA_MODEL_TIER_STRONG: "s/m" })).toBe("s/m");
    expect(
      strongRoleOverride("arbiter", {
        MARINA_MODEL_TIER_STRONG: "s/m",
        MARINA_AGENT_MODELS: "role:arbiter=a/m",
      }),
    ).toBe("a/m");
  });
});

describe("the benchmark judge never turns cheap by itself", () => {
  it("stays marina/default under a cheap tier, follows the strong tier and role:judge", () => {
    expect(defaultBenchmarkJudge({ ...OR, MARINA_MODEL_TIER_CHEAP: "c/m" })).toBe("marina/default");
    expect(defaultBenchmarkJudge({ MARINA_MODEL_TIER_STRONG: "s/m" })).toBe("s/m");
    expect(defaultBenchmarkJudge({ MARINA_AGENT_MODELS: "role:judge=j/m" })).toBe("j/m");
    expect(
      defaultBenchmarkJudge({
        MARINA_BENCHMARK_JUDGE_MODEL: "b/m",
        MARINA_MODEL_TIER_STRONG: "s/m",
      }),
    ).toBe("b/m");
    const choice = resolveBenchmarkJudge({
      target: "model:x",
      env: { MARINA_MODEL_TIER_STRONG: "s/m" },
    });
    expect(choice).toEqual({ model: "s/m", source: "configured" });
    expect(resolveBenchmarkJudge({ target: "model:x", env: {} })).toEqual({
      model: "marina/default",
      source: "builtin",
    });
  });

  it("a target on a tier alias that resolves to the judge's model is the judge", () => {
    const env = { MARINA_MODEL_TIER_CHEAP: "s/m", MARINA_MODEL_TIER_STRONG: "s/m" };
    const r = resolveBenchmarkJudge({ target: "marina/cheap", env });
    expect("error" in r).toBe(true);
    const ok = resolveBenchmarkJudge({ target: "marina/cheap", env: { ...OR } });
    expect("error" in ok).toBe(false);
  });
});

describe("readout", () => {
  it("names every tier and role with its effective model and source", () => {
    const lines = describeModelTiers({
      env: { ...OR, MARINA_AGENT_MODELS: "role:judge=j/m", MARINA_CREW_MODEL: "k/m" },
      defaultRoute: "anthropic/claude-opus-5-5",
    });
    const text = lines.join("\n");
    expect(text).toContain(`cheap  ${CHEAP_OR}  [built-in (openrouter)`);
    expect(text).toContain("strong marina/default → anthropic/claude-opus-5-5");
    expect(text).toContain(`resident       marina/cheap → ${CHEAP_OR}  [tier:cheap]`);
    expect(text).toContain("crew           k/m  [env:MARINA_CREW_MODEL]");
    expect(text).toContain("judge          j/m  [MARINA_AGENT_MODELS role:judge]");
    expect(text).toContain("decisions      marina/default → anthropic/claude-opus-5-5");
    expect(text).toContain("arbiter        the forecast critic");
    for (const role of Object.keys(MODEL_ROLES)) expect(text).toContain(`  ${role} `);
  });
});

describe("/v1 tier rewrite", () => {
  it("rewrites marina/cheap to the built-in for this instance's keys, leaves others alone", async () => {
    const clear = Object.fromEntries(modelSourceEnvKeys().map((k) => [k, undefined]));
    using _state = scopeProcessState({
      env: {
        ...clear,
        ...OR,
        MARINA_MODEL_TIER_CHEAP: undefined,
        MARINA_MODEL_TIER_STRONG: undefined,
        MARINA_DEFAULT_MODEL: undefined,
        MARINA_AGENT_MODELS: undefined,
      },
    });
    const t = createTestEngine();
    try {
      expect(tierRequestModel(t.engine, "cheap")).toBe(CHEAP_OR);
      expect(tierRequestModel(t.engine, "marina/strong")).toBe("marina/default");
      expect(tierRequestModel(t.engine, "marina/default")).toBeUndefined();
      // The runtime default (dashboard / admin) is an explicit choice for the cheap tier.
      t.db.setSetting("default_model", "anthropic/claude-haiku-5-5");
      expect(tierRequestModel(t.engine, "marina/cheap")).toBe("anthropic/claude-haiku-5-5");
    } finally {
      await t.dispose();
    }
  });
});

describe("seeded populations", () => {
  it("the Workbench no longer picks a provider flagship: it runs on the crew tier", async () => {
    using _state = scopeProcessState({
      env: {
        OPENAI_API_KEY: "sk-test",
        MARINA_WORKBENCH_MODEL: undefined,
        MARINA_CREW_MODEL: undefined,
        MARINA_AGENT_MODELS: undefined,
      },
    });
    const { default: world } = await import("../worlds/default");
    const db = new MarinaDB(":memory:");
    try {
      world.seed?.(db);
      for (const name of ["Host", "Builder", "Critic", "Chronicler"])
        expect(db.getAgentConfig(name)?.model).toBe("marina/cheap");
    } finally {
      db.close();
    }
  });

  it("MARINA_CREW_MODEL and MARINA_WORKBENCH_MODEL still win", async () => {
    using _state = scopeProcessState({
      env: {
        MARINA_WORKBENCH_MODEL: "w/m",
        MARINA_CREW_MODEL: "c/m",
        MARINA_AGENT_MODELS: undefined,
      },
    });
    const { default: world } = await import("../worlds/default");
    const db = new MarinaDB(":memory:");
    try {
      world.seed?.(db);
      expect(db.getAgentConfig("Host")?.model).toBe("w/m");
    } finally {
      db.close();
    }
  });
});
