// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  agentModelMapProblems,
  agentModelOverride,
  parseAgentModelMap,
  resetSeededAgentNamesForTests,
  seedAnswererCrew,
  seedOrchestrationCrews,
  seedSystemAgent,
} from "../worlds/seed";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_agent_model_map.db";

describe("parseAgentModelMap", () => {
  it("parses Name=model pairs, case-insensitive names, model strings untouched", () => {
    const { models, invalid } = parseAgentModelMap(
      " Answerer=openrouter/anthropic/claude-opus-5.5 , translator=marina/classifier:openrouter/x/y=z,",
    );
    expect(invalid).toEqual([]);
    expect(models.get("answerer")).toEqual({
      name: "Answerer",
      model: "openrouter/anthropic/claude-opus-5.5",
    });
    // split at the FIRST `=`: the rest of the model string is kept
    expect(models.get("translator")?.model).toBe("marina/classifier:openrouter/x/y=z");
  });

  it("reports malformed entries", () => {
    expect(parseAgentModelMap("Answerer,=x,Scholar=").invalid).toEqual([
      "Answerer",
      "=x",
      "Scholar=",
    ]);
    expect(parseAgentModelMap(undefined).models.size).toBe(0);
  });

  it("agentModelOverride looks a name up in the env map", () => {
    const env = { MARINA_AGENT_MODELS: "Historian=a/b" };
    expect(agentModelOverride("historian", env)).toBe("a/b");
    expect(agentModelOverride("Scholar", env)).toBeUndefined();
    expect(agentModelOverride("Scholar", {})).toBeUndefined();
  });
});

describe("MARINA_AGENT_MODELS at seed time", () => {
  let db: MarinaDB;
  const prev = process.env.MARINA_AGENT_MODELS;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    resetSeededAgentNamesForTests();
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prev === undefined) delete process.env.MARINA_AGENT_MODELS;
    else process.env.MARINA_AGENT_MODELS = prev;
    resetSeededAgentNamesForTests();
  });

  it("puts a different model on every crew member and specialist; wins over per-role models", () => {
    process.env.MARINA_AGENT_MODELS = [
      "Answerer=m/answerer",
      "Translator=m/translator",
      "Mathematician=m/math",
      "Historian=m/historian",
      "Decomposer=m/decomposer",
    ].join(",");
    // per-role models as the showcase world passes them (MARINA_*_MODEL / MARINA_CREW_MODEL)
    seedAnswererCrew(db, {
      answererModel: "role/answerer",
      mathModel: "role/math",
      reflectorModel: "role/reflector",
    });
    seedOrchestrationCrews(db, { models: { Historian: "crew/default", Scholar: "crew/default" } });
    expect(db.getAgentConfig("Answerer")?.model).toBe("m/answerer");
    expect(db.getAgentConfig("Translator")?.model).toBe("m/translator");
    expect(db.getAgentConfig("Mathematician")?.model).toBe("m/math");
    expect(db.getAgentConfig("Historian")?.model).toBe("m/historian");
    expect(db.getAgentConfig("Decomposer")?.model).toBe("m/decomposer");
    // agents the map does not name keep the per-role / crew-default model
    expect(db.getAgentConfig("Reflector")?.model).toBe("role/reflector");
    expect(db.getAgentConfig("Scholar")?.model).toBe("crew/default");
    expect(agentModelMapProblems()).toEqual([]);
  });

  it("re-applies on every boot to seed-owned agents, never to a user-customized one", () => {
    seedSystemAgent(db, { name: "Scholar", model: "seed/default", role: "r", goal: "g" });
    process.env.MARINA_AGENT_MODELS = "Scholar=m/scholar";
    seedSystemAgent(db, { name: "Scholar", model: "seed/default", role: "r", goal: "g" });
    expect(db.getAgentConfig("Scholar")?.model).toBe("m/scholar");
    // unset again → back to the seed default on the next boot
    delete process.env.MARINA_AGENT_MODELS;
    seedSystemAgent(db, { name: "Scholar", model: "seed/default", role: "r", goal: "g" });
    expect(db.getAgentConfig("Scholar")?.model).toBe("seed/default");

    db.saveAgentConfig({
      name: "Mine",
      model: "user/model",
      role: "r",
      goal: "g",
      spawnedBy: "Jeff",
    });
    process.env.MARINA_AGENT_MODELS = "Mine=m/override";
    seedSystemAgent(db, { name: "Mine", model: "seed/default", role: "r", goal: "g" });
    expect(db.getAgentConfig("Mine")?.model).toBe("user/model");
  });

  it("reports names that match no seeded agent and malformed entries", () => {
    process.env.MARINA_AGENT_MODELS = "Scholar=m/s,Scholr=m/typo,broken";
    seedSystemAgent(db, { name: "Scholar", model: "seed/default", role: "r", goal: "g" });
    expect(agentModelMapProblems()).toEqual([
      'malformed entry "broken" (want Name=model)',
      '"Scholr" matches no seeded agent',
    ]);
  });
});
