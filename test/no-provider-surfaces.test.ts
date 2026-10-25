// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A world with no model provider stays honest: a refused model call is
 * reported with the refusal's own fix, an optional capability is not an
 * operational emergency, and a capped list says what it left out.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { askCommand } from "../src/engine/commands/ask";
import { forecastCommand } from "../src/engine/commands/forecast";
import { syncOperationalAlerts } from "../src/engine/commands/ops";
import type { ReadinessReport } from "../src/engine/readiness";
import { LocalModelError } from "../src/engine/registrations/model-helpers";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi, until } from "./helpers";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

describe("no-provider surfaces", () => {
  let f: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;

  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: noProviderEnv() });
    f = createTestEngine();
  });
  afterEach(async () => {
    await f.dispose();
    state.dispose();
  });

  it("ask keeps its world context and says why the model gave no answer", async () => {
    f.engine.commands.registerBuiltin(
      askCommand({
        getEntity: (id) => f.engine.entities.get(id as EntityId),
        db: f.db,
        answerQuestion: async () => {
          throw new LocalModelError(
            "Model request failed (HTTP 503): No upstream LLM providers configured. Set one of OPENROUTER_API_KEY.",
          );
        },
      }),
    );
    const me = f.login("Asker");
    me.connection.clear();
    await f.engine.processCommand(me.entityId, "ask what about widgets?");
    await until(() => me.connection.allText().length > 0);
    const out = stripAnsi(me.connection.allText().join("\n"));
    expect(out).toContain("No model answer — Model request failed (HTTP 503)");
    expect(out).toContain("OPENROUTER_API_KEY");
  });

  it("forecast refuses before promising research when there is no model", async () => {
    f.engine.commands.registerBuiltin(forecastCommand());
    const me = f.login("Forecaster");
    me.connection.clear();
    await f.engine.processCommand(me.entityId, "forecast Will it rain tomorrow?");
    await until(() => me.connection.allText().length > 0);
    const out = stripAnsi(me.connection.allText().join("\n"));
    expect(out).toContain("No model is available to forecast with");
    expect(out).toContain("OPENROUTER_API_KEY");
    expect(out).not.toContain("Researching");
  });

  it("task list says how many tasks it left out and how to see them", async () => {
    const me = f.login("Lister");
    for (let i = 0; i < 25; i++) {
      f.db.createTask({ title: `job ${i}`, creatorId: "e_x", creatorName: "Someone" });
    }
    me.connection.clear();
    await f.engine.processCommand(me.entityId, "task list");
    let out = stripAnsi(me.connection.lastText());
    expect(out).toContain("5 more");
    expect(out).toContain("task list open limit:25");

    await f.engine.processCommand(me.entityId, "task list open limit:25");
    out = stripAnsi(me.connection.lastText());
    expect(out).toContain("job 0");
    expect(out).toContain("job 24");
    expect(out).not.toContain("more —");
  });

  it("ops inbox leaves optional capabilities out and keeps real problems critical", () => {
    const tasks = f.engine.taskManager;
    if (!tasks) throw new Error("no task manager");
    const report = {
      checks: [
        { id: "watcher", label: "Watcher", status: "off", optional: true, detail: "none" },
        {
          id: "providers",
          label: "LLM provider configuration",
          status: "off",
          detail: "no provider",
          remediation: "Set OPENROUTER_API_KEY.",
        },
      ],
    } as unknown as ReadinessReport;
    syncOperationalAlerts({
      db: f.db,
      tasks,
      runtime: f.engine.agentRuntime,
      readiness: () => report,
    });
    const open = f.db.listOperationalAlerts("open", 50);
    const keys = open.map((a) => a.alert_key);
    expect(keys).toContain("readiness:providers");
    expect(keys).not.toContain("readiness:watcher");
    const provider = open.find((a) => a.alert_key === "readiness:providers");
    expect(provider?.severity).toBe("critical");
    expect(provider?.remedy).toBe("Set OPENROUTER_API_KEY.");
  });
});
