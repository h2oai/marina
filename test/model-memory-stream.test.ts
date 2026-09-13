// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { normalizeToolCallSSE } from "../src/net/model-api";

async function collect(parts: string[], openAfterDone = false) {
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts.shift();
      if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
      else if (!openAfterDone) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = normalizeToolCallSSE(upstream, "model").getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) return { text, cancelled };
      text += new TextDecoder().decode(next.value);
    }
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fragmented stream stalled")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

it("continues across fragmented SSE lines, heartbeats and empty provider deltas", async () => {
  const content = frame({ content: "preserved α🙂" });
  const result = await collect([
    ": heartbeat\n\n",
    frame({ content: "" }),
    content.slice(0, 9),
    content.slice(9),
    frame({}, "stop"),
    "data: [DONE]\n\n",
  ]);
  expect(result.text).toContain("preserved α🙂");
  expect(result.text.match(/\[DONE\]/g)).toHaveLength(1);
});

it("retains usage arriving after finish_reason and closes on DONE without waiting for EOF", async () => {
  const usage = { prompt_tokens: 123, completion_tokens: 17, total_tokens: 140 };
  const result = await collect(
    [
      frame({ role: "assistant", content: "" }),
      frame({ content: "answer" }),
      frame({}, "stop"),
      `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
      "data: [DONE]\n\n",
    ],
    true,
  );
  expect(result.text).toContain(JSON.stringify(usage));
  expect(result.text.indexOf('"usage"')).toBeLessThan(result.text.indexOf("[DONE]"));
  expect(result.cancelled).toBe(true);
});

it("keeps pulling while a textual tool-call tag is held by the parser", async () => {
  const result = await collect([
    frame({ content: "<too" }),
    frame({
      content:
        'l_call>{"name":"memory","arguments":{"action":"search","query":"maple"}}</tool_call>',
    }),
    frame({}, "stop"),
    "data: [DONE]\n\n",
  ]);
  expect(result.text).toContain('"tool_calls"');
  expect(result.text).toContain('"name":"memory"');
});
