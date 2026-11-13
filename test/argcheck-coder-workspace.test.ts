// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A coder's work in its own Code Mode workspace (edits, new files, checks,
 * verification, plans) is not held by the conversation-support argument check:
 * its paths and text are its own work, checked by verification and review.
 * Submitting, handoffs, approvals and calls outside the workspace still are.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { isWorkspaceAuthoringCall } from "../src/agent/tools";
import { scopeProcessState } from "./process-state";

describe("isWorkspaceAuthoringCall", () => {
  it("covers the typed workspace tools", () => {
    for (const name of [
      "marina_code_edit",
      "marina_code_write",
      "marina_code_patch",
      "marina_code_apply_patch",
      "marina_code_run",
      "marina_code_verify",
      "marina_code_plan",
    ])
      expect(isWorkspaceAuthoringCall(name, {})).toBe(true);
  });

  it("covers the generic tool's workspace actions only", () => {
    expect(
      isWorkspaceAuthoringCall("marina_code", {
        action: "write",
        path: "test/read-page.test.ts",
        content: "x",
      }),
    ).toBe(true);
    expect(isWorkspaceAuthoringCall("marina_code", { action: "edit" })).toBe(true);
    for (const action of ["summary", "handoff", "approve", "approval", "workspace", "blocked"])
      expect(isWorkspaceAuthoringCall("marina_code", { action })).toBe(false);
    expect(isWorkspaceAuthoringCall("marina_code", {})).toBe(false);
  });

  it("leaves submission and every other tool to the check", () => {
    expect(isWorkspaceAuthoringCall("marina_code_summary", {})).toBe(false);
    expect(isWorkspaceAuthoringCall("marina_code_handoff", {})).toBe(false);
    expect(isWorkspaceAuthoringCall("marina_command", { command: "task submit 1" })).toBe(false);
    expect(isWorkspaceAuthoringCall("transfer_funds", { action: "write" })).toBe(false);
  });
});

describe("a coder's workspace write is recorded, never held", () => {
  it("runs the write the check would hold, and still holds any other write", async () => {
    using _env = scopeProcessState({ env: { MARINA_ARGCHECK: "on" } });
    const adapter = new LeanAgentAdapter({ name: "RecordCoder" }, "ws://127.0.0.1:3300", null);
    const events: Array<Record<string, unknown>> = [];
    const i = adapter as unknown as {
      agent: { beforeToolCall(context: unknown): Promise<{ block: boolean } | undefined> };
      argcheck: { check(...args: unknown[]): Promise<unknown> };
      emitEvent(event: Record<string, unknown>): void;
    };
    i.emitEvent = (event) => events.push(event);
    const checked: string[] = [];
    i.argcheck.check = async (name: unknown) => {
      checked.push(String(name));
      return {
        outcome: {
          label: "unsupported",
          checked: 1,
          flaggedValues: 1,
          judgement: { supported: 0 },
        },
        refusal: "[Marina argument check — not from the requester] held",
      };
    };
    const call = (name: string, args: Record<string, unknown>) => ({
      assistantMessage: { stopReason: "toolUse" },
      toolCall: { id: `${name}-1`, name },
      args,
      context: { messages: [{ role: "user", content: "Add a test." }], tools: [] },
    });
    const write = await i.agent.beforeToolCall(
      call("marina_code", { action: "write", path: "test/new.test.ts", content: "x" }),
    );
    expect(write?.block ?? false).toBe(false);
    expect(checked).toEqual(["marina_code"]);
    expect(events.find((e) => e.stage === "argcheck")?.verdict).toBe("would-nudge");

    // A write outside the coder's workspace is still held by the same verdict.
    const other = await i.agent.beforeToolCall(
      call("marina_command", { command: "task create Pay 4417 to vendor 9921" }),
    );
    expect(checked).toEqual(["marina_code", "marina_command"]);
    expect(other?.block).toBe(true);
    expect(events.filter((e) => e.stage === "argcheck").at(-1)?.verdict).toBe("nudge");
  });
});
