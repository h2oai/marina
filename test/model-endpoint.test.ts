import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_ENDPOINT_CONFIG,
  getEndpointConfig,
  setEndpointConfig,
} from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_model_endpoint.db";

describe("model-endpoint config", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("defaults to agents+fallback (preserving historical behavior)", () => {
    const c = getEndpointConfig(db);
    expect(c.mode).toBe("agents");
    expect(c.fallback).toBe(true);
    expect(c.strategy).toBe("round-robin");
    expect(c.passthruModel).toBe("");
    expect(c).toEqual(DEFAULT_ENDPOINT_CONFIG);
  });

  it("persists and reads back a valid update", () => {
    const r = setEndpointConfig(db, {
      mode: "panel",
      panelSize: 4,
      panelSynthesis: "synthesize",
      fallback: false,
    });
    expect("config" in r).toBe(true);
    const c = getEndpointConfig(db);
    expect(c.mode).toBe("panel");
    expect(c.panelSize).toBe(4);
    expect(c.panelSynthesis).toBe("synthesize");
    expect(c.fallback).toBe(false);
  });

  it("validates mode / strategy / synthesis", () => {
    expect("error" in setEndpointConfig(db, { mode: "bogus" as never })).toBe(true);
    expect("error" in setEndpointConfig(db, { strategy: "nope" as never })).toBe(true);
    expect("error" in setEndpointConfig(db, { panelSynthesis: "x" as never })).toBe(true);
    // db unchanged after rejected writes
    expect(getEndpointConfig(db).mode).toBe("agents");
  });

  it("validates the passthru model format and accepts empty (= default)", () => {
    expect("error" in setEndpointConfig(db, { passthruModel: "not-a-model" })).toBe(true);
    expect("config" in setEndpointConfig(db, { passthruModel: "openrouter/openai/gpt-4o" })).toBe(
      true,
    );
    expect(getEndpointConfig(db).passthruModel).toBe("openrouter/openai/gpt-4o");
    expect("config" in setEndpointConfig(db, { passthruModel: "" })).toBe(true);
    expect(getEndpointConfig(db).passthruModel).toBe("");
  });

  it("clamps panel size into [1,8]", () => {
    setEndpointConfig(db, { panelSize: 99 });
    expect(getEndpointConfig(db).panelSize).toBe(8);
    expect("error" in setEndpointConfig(db, { panelSize: 0 })).toBe(true);
  });
});
