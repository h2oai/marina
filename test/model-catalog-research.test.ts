// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { resolveModel } from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";

test("Sol research prompts retain answer capacity and never disable mandatory reasoning", async () => {
  const model = resolveModel("openai/gpt-6.1-sol");
  let payload: Record<string, unknown> | undefined;
  await piModels.completeSimple(
    model,
    {
      messages: [{ role: "user", content: "Dated verified evidence. ".repeat(1600), timestamp: 0 }],
    },
    {
      apiKey: "fixture",
      maxTokens: 4000,
      maxRetries: 0,
      fetch: (async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            error: { message: "fixture: captured request", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  );
  expect(payload?.model).toBe("gpt-6.1-sol");
  expect(payload?.max_output_tokens).toBe(4000);
  expect((payload?.reasoning as { effort?: string } | undefined)?.effort).not.toBe("none");
  expect(model.cost.cacheWrite).toBe(2.5);
});
