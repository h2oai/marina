// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeResumeAction, resumeActionForRunState } from "../src/agent/run-state-resume";
import { MarinaDB } from "../src/persistence/database";
import {
  clearRunState,
  getRunState,
  putRunState,
  type RunState,
} from "../src/persistence/db-run-state";
import { cleanupDb } from "./helpers";

const path = `/tmp/marina-run-state-${crypto.randomUUID()}.db`;

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    agentName: "Ada",
    phase: "tool_call",
    toolCallId: "call_1",
    toolName: "marina_look",
    argsJson: JSON.stringify({ command: "look" }),
    replay: "safe",
    partialOutputJson: "[]",
    updatedAt: 1,
    ...overrides,
  };
}

describe("run_state durability", () => {
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
  });

  afterEach(() => {
    raw.close();
    db.close();
    cleanupDb(path);
  });

  it("round-trips an in-flight tool call", () => {
    putRunState(raw, state());
    expect(getRunState(raw, "Ada")).toEqual(state());
  });

  it("upserts — the row always describes the newest pending effect", () => {
    putRunState(raw, state());
    putRunState(raw, state({ toolCallId: "call_2", toolName: "marina_say", replay: "never" }));
    const got = getRunState(raw, "Ada");
    expect(got?.toolCallId).toBe("call_2");
    expect(got?.replay).toBe("never");
  });

  it("clears the in-flight state", () => {
    putRunState(raw, state());
    clearRunState(raw, "Ada");
    expect(getRunState(raw, "Ada")).toBeUndefined();
  });
});

describe("resume decision over run_state", () => {
  it("reruns only `safe` tools", () => {
    expect(resumeActionForRunState(undefined)).toEqual({ kind: "none" });
    expect(resumeActionForRunState(state({ replay: "safe" }))).toEqual({ kind: "rerun" });
    expect(resumeActionForRunState(state({ replay: "never" }))).toEqual({
      kind: "report_interrupted",
    });
  });

  it("reports interruption with a human-facing summary", () => {
    const interrupted = state({ toolName: "marina_say", replay: "never" });
    expect(describeResumeAction(interrupted)).toBe(
      "tool marina_say was interrupted and will not be repeated",
    );
    expect(describeResumeAction(undefined)).toBe("no in-flight effect to resume");
  });
});
