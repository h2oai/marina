// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import {
  answerCodeViaLocalModel,
  answerViaLocalModel,
} from "../src/engine/registrations/model-helpers";
import { selfModelWriter } from "../src/learning/service";
import { chatNoteWriter } from "../src/memory/ingest-notes";
import { routerMemoryPlanner } from "../src/memory/planning";
import { scopeProcessState } from "./process-state";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const consumers = [
  [
    "lesson",
    () =>
      selfModelWriter("marina/default", process.env, { token: async () => "test" }).complete(
        "system",
        "user",
      ),
  ],
  [
    "note",
    () =>
      chatNoteWriter({ baseUrl: "http://test/v1", model: "test" }).write({
        system: "system",
        user: "user",
      }),
  ],
  [
    "plan",
    () =>
      routerMemoryPlanner("http://test/v1", "test").plan(
        "task",
        { version: 1, definition: { closed: false, predicates: {} } },
        undefined,
      ),
  ],
  ["ask", () => answerViaLocalModel("question", "context")],
  [
    "code",
    () =>
      answerCodeViaLocalModel({
        actor: "a",
        profile: "code",
        prompt: "task",
        sessionId: "s",
        workspaceRoot: "/tmp",
      }),
  ],
] as const;

for (const [name, consume] of consumers) {
  test(`${name}: rejects syntactically valid but unfinished output before consuming it`, async () => {
    for (const reason of ["length", "content_filter", "tool_calls", undefined]) {
      globalThis.fetch = (async () =>
        Response.json({
          choices: [{ finish_reason: reason, message: { content: '{"steps":[]}' } }],
        })) as unknown as typeof fetch;
      await expect(consume()).rejects.toThrow("incomplete output");
    }
  });

  test(`${name}: uses the configured generation allowance and accepts completed output`, async () => {
    using _state = scopeProcessState({ env: { MARINA_DEFAULT_MAX_TOKENS: "24000" } });
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"steps":[]}' } }],
      });
    }) as unknown as typeof fetch;
    expect(await consume()).toBeDefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.max_tokens).toBe(24000);
  });
}

test("note writer preserves an explicit caller cap even above the automatic default", async () => {
  using _state = scopeProcessState({ env: { MARINA_DEFAULT_MAX_TOKENS: "1000" } });
  let cap: unknown;
  const writer = chatNoteWriter({
    baseUrl: "http://test/v1",
    model: "test",
    maxTokens: 32000,
    fetch: async (_url: unknown, init?: RequestInit) => {
      cap = JSON.parse(String(init?.body)).max_tokens;
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "complete note" } }],
      });
    },
  });
  expect(await writer.write({ system: "s", user: "u" })).toBe("complete note");
  expect(cap).toBe(32000);
});
