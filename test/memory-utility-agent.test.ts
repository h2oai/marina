// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { parseAgentAction } from "../examples/memory-service/task-agent-protocol";

it("preserves structured answers without interpreting them as memory operations", () => {
  const value = { code: "Ω-123", sequence: [3, 1], nested: { enabled: false } };
  expect(parseAgentAction(JSON.stringify({ answer: value, citations: ["source"] }))).toEqual({
    kind: "answer",
    answer: JSON.stringify(value),
    citations: ["source"],
  });
  expect(parseAgentAction('{"answer":"UNKNOWN","citations":[]}')).toEqual({
    kind: "answer",
    answer: "UNKNOWN",
    citations: [],
  });
  expect(parseAgentAction('{"answer":{"unexpected":true},"citations":[]}')).toEqual({
    kind: "answer",
    answer: '{"unexpected":true}',
    citations: [],
  });
});

it("separates invalid model envelopes from service requests without fabricating citations", () => {
  for (const content of [
    "```json\n{}\n```",
    "null",
    "[]",
    '{"answer":{},"citations":[23]}',
    '{"answer":{}}',
    '{"answer":"result","operation":"search","citations":[]}',
    '{"operation":"forget","input":{}}',
    '{"operation":"search","input":[]}',
    '{"city":"an unwrapped answer"}',
  ])
    expect(parseAgentAction(content).kind).toBe("invalid");
  expect(parseAgentAction('{"operation":"search","input":{"query":"specific words"}}')).toEqual({
    kind: "operation",
    operation: "search",
    input: { query: "specific words" },
  });
});
