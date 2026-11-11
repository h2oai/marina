// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * With no model provider, every /v1 call is refused 503 (`unavailable`, no
 * target). That is a configuration state: one WARN per interval carrying the
 * provider-setup hint, never an ERROR per request. Real failures stay ERROR.
 */

import { describe, expect, it } from "bun:test";
import { EventLog } from "../src/engine/event-log";
import type { Logger } from "../src/engine/logger";
import type { EngineEvent } from "../src/types";

function recorder() {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (_category: string, message: string) =>
    lines.push({ level, message });
  const logger = { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
  return { lines, logger: logger as unknown as Logger };
}

const failed = (extra: Partial<Extract<EngineEvent, { type: "model_request_lifecycle" }>>) =>
  ({
    type: "model_request_lifecycle",
    phase: "failed",
    requestId: "req-1",
    model: "marina",
    errorKind: "unavailable",
    timestamp: Date.now(),
    ...extra,
  }) as EngineEvent;

describe("model-request failure logging", () => {
  it("a missing provider warns once per interval with the setup hint", () => {
    const { lines, logger } = recorder();
    const log = new EventLog(logger);
    for (let i = 0; i < 5; i++) log.log(failed({}));
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
    const warns = lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("no model provider");
    expect(warns[0]!.message).toContain("key add <name> <provider> <key>");
    expect(warns[0]!.message).toContain("OLLAMA_BASE_URL");
  });

  it("an upstream that answered 503, or any other failure, is still an ERROR", () => {
    const { lines, logger } = recorder();
    const log = new EventLog(logger);
    log.log(failed({ target: "anthropic/claude" }));
    log.log(failed({ errorKind: "provider" }));
    expect(lines.map((l) => l.level)).toEqual(["error", "error"]);
  });

  it("a request its caller abandoned is a debug line, never an ERROR", () => {
    // Marina's own second opinions stop waiting after their deadline; a client
    // may disconnect. Neither is a provider failure.
    const { lines, logger } = recorder();
    const log = new EventLog(logger);
    log.log(failed({ target: "anthropic/claude-opus-5-5", errorKind: "cancelled" }));
    expect(lines).toEqual([{ level: "debug", message: "Model request cancelled by its caller" }]);
  });

  it("an agent's refused tool call is recorded at info, not raised as a warning", () => {
    const { lines, logger } = recorder();
    const log = new EventLog(logger);
    log.log({
      type: "agent_tool_result",
      name: "Critic",
      toolName: "marina_command",
      isError: true,
      timestamp: Date.now(),
    } as unknown as EngineEvent);
    expect(lines.map((l) => l.level)).toEqual(["info"]);
  });
});
