// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Synthetic functional observations of the real translator; no provider calls. */
import {
  anthropicRequestToOpenai,
  translateStreamToAnthropic,
} from "../../src/net/anthropic-inbound";

const translated = anthropicRequestToOpenai({
  model: "audit-model",
  max_tokens: 500,
  system: [{ type: "text", text: "Audit system", cache_control: { type: "ephemeral" } }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect the image" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "SYNTHETIC_IMAGE" },
        },
      ],
    },
  ],
  tools: [{ name: "inspect", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "tool", name: "inspect" },
});
const toolRoundTrip = anthropicRequestToOpenai({
  model: "audit-model",
  messages: [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call1", name: "inspect", input: { marker: 973 } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call1", content: "inspection complete" }],
    },
  ],
});
const upstream = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call1",
              type: "function",
              function: { name: "inspect", arguments: "" },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"marker":973}' } }] } }],
  },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 123, completion_tokens: 17 },
  },
];
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of upstream)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
});
const output = await new Response(
  translateStreamToAnthropic(stream, "audit-model", "msg_audit"),
).text();
console.log(
  JSON.stringify(
    {
      purpose: "Selected protocol fidelity observations; not complete API conformance",
      observed_at: new Date().toISOString(),
      observations: {
        B01: {
          expected: "Preserve image content or explicitly reject unsupported translation",
          image_preserved: JSON.stringify(translated).includes("SYNTHETIC_IMAGE"),
          translated_request: translated,
        },
        B02: {
          expected:
            "Preserve forced tool selection or explicitly report the unsupported constraint",
          tool_choice_preserved: "tool_choice" in translated,
          basic_tool_call_and_result_preserved:
            JSON.stringify(toolRoundTrip).includes("inspection complete") &&
            JSON.stringify(toolRoundTrip).includes("call1"),
          note: "System block cache_control is also flattened away in this conversion",
        },
        B03: {
          expected:
            "Translate streamed tool calls and usage without inventing a successful empty tool request",
          tool_name_preserved: output.includes("inspect"),
          arguments_preserved: output.includes("973"),
          stop_reason_tool_use: output.includes('"stop_reason":"tool_use"'),
          upstream_usage: { input: 123, output: 17 },
          translated_stream: output,
        },
      },
    },
    null,
    2,
  ),
);
