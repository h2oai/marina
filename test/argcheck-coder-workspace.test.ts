// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A coder's work in its own Code Mode workspace (edits, new files, checks,
 * verification, plans) is not held by the conversation-support argument check:
 * its paths and text are its own work, checked by verification and review.
 * Submitting, handoffs, approvals and calls outside the workspace still are.
 */

import { describe, expect, it } from "bun:test";
import { isWorkspaceAuthoringCall } from "../src/agent/tools";

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
