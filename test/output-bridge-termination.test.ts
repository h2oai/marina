// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { parseToolArguments } from "../scripts/qualification/long-horizon-tools";
import {
  openAIResponsesStream,
  openAIResponseToChat,
} from "../src/net/model-api/openai-responses-bridge";

for (const [reason, finish] of [
  ["max_output_tokens", "length"],
  ["content_filter", "content_filter"],
  ["unexpected", "error"],
]) {
  test(`Responses preserves incomplete reason ${reason} in buffered and streaming paths`, async () => {
    const response = { id: "r", status: "incomplete", output: [], incomplete_details: { reason } };
    const data = openAIResponseToChat(response, "fixture") as {
      choices: { finish_reason: string }[];
    };
    expect(data.choices[0]?.finish_reason).toBe(finish!);
    const upstream = new Response(
      `data: ${JSON.stringify({ type: "response.incomplete", response })}\n\n`,
    );
    const out = await new Response(
      openAIResponsesStream(upstream.body!, "fixture", false, () => {}),
    ).text();
    expect(out).toContain(`"finish_reason":"${finish}"`);
  });
}
for (const reason of [undefined, null, "error", "content_filter", "length"]) {
  test(`qualification refuses even parseable tool arguments from ${String(reason)} turns`, () => {
    expect(() => parseToolArguments('{"path":"a","content":"b"}', reason)).toThrow();
  });
}
