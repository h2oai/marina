// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { RoutingEvent } from "../../../src/sdk/routing-types";
import { ParticipantActivity } from "../components/ParticipantActivity";
import { mergeParticipantEvents, participantActivity } from "../lib/participant-activity";

function event(sequence: number, kind: string, payload: unknown): RoutingEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "worker",
    sequence,
    kind,
    payload,
    createdAt: sequence,
  };
}

it("joins native text deltas while keeping every source and separating tool output", () => {
  const events = [
    event(1, "output", { text: "Hello ", method: "item/agentMessage/delta", itemId: "a" }),
    event(2, "output", { text: "world", method: "item/agentMessage/delta", itemId: "a" }),
    event(3, "output", { text: "PASS", method: "item/commandExecution/outputDelta", itemId: "b" }),
    event(5, "output", { text: "gap", method: "item/commandExecution/outputDelta", itemId: "b" }),
  ];
  const blocks = participantActivity(events, "codex");
  expect(blocks.map((block) => block.text)).toEqual(["Hello world", "PASS", "gap"]);
  expect(blocks.flatMap((block) => block.events)).toEqual(events);
  expect(blocks[1]!.title).toBe("Tool output");
  expect(participantActivity(events, "custom")).toHaveLength(4);
});

it("keeps native turn results and delivery acceptance distinct from task completion", () => {
  const blocks = participantActivity(
    [
      event(1, "native.result", { result: "Finished my turn", is_error: false }),
      event(2, "delivery.accepted", {
        text: "Accepted by adapter; this is not proof of task completion.",
      }),
      event(3, "delivery.error", { text: "Connection lost" }),
      event(4, "runtime.state", { status: "waiting", cwd: "/project" }),
    ],
    "claude",
  );
  expect(blocks.map((block) => block.title)).toEqual([
    "Agent turn ended",
    "Instruction accepted",
    "Instruction outcome uncertain",
    "Runtime · waiting",
  ]);
  expect(blocks[2]!.tone).toBe("danger");
});

it("retains custom event data for inspection and search without treating it as HTML", () => {
  render(
    <ParticipantActivity
      adapter="custom"
      events={[
        event(1, "custom.progress", { correlationId: "trace-42", percent: 17 }),
        event(2, "output", { text: "<img src=x onerror=alert(1)>" }),
      ]}
    />,
  );
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "trace-42" } });
  expect(screen.getByText("custom.progress")).toBeVisible();
  expect(screen.queryByText("<img src=x onerror=alert(1)>")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Inspect source event"));
  expect(screen.getByText(/"correlationId": "trace-42"/)).toBeVisible();
});

it("deduplicates replayed pages and bounds retained presentation history", () => {
  const original = Array.from({ length: 500 }, (_, index) => event(index + 1, "output", "text"));
  const merged = mergeParticipantEvents(original, [original[499]!, event(501, "output", "last")]);
  expect(merged).toHaveLength(500);
  expect(merged[0]!.sequence).toBe(2);
  expect(merged.at(-1)!.sequence).toBe(501);
  expect(merged.filter((item) => item.sequence === 500)).toHaveLength(1);
});

it("shows retained message snapshots when deltas are outside the loaded window", () => {
  const source = event(100, "native.assistant", {
    message: {
      content: [
        { type: "text", text: "I will inspect the tests." },
        { type: "tool_use", name: "Read", input: { path: "test.ts" } },
      ],
    },
  });
  const [block] = participantActivity([source], "claude");
  expect(block!.text).toBe("I will inspect the tests.\nTool: Read");
  expect(block!.events[0]).toBe(source);
});
