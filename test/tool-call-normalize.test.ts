// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  extractTextualToolCalls,
  normalizeTextualToolCalls,
  type StreamEvent,
  ToolCallStreamParser,
} from "../src/net/tool-call-normalize";

/** Feed chunks through the streaming parser and collect emitted events + flush. */
function runStream(chunks: string[]): { events: StreamEvent[]; sawToolCall: boolean } {
  const p = new ToolCallStreamParser();
  const events: StreamEvent[] = [];
  for (const ch of chunks) events.push(...p.push(ch));
  events.push(...p.finish());
  return { events, sawToolCall: p.sawToolCall };
}
const streamedText = (events: StreamEvent[]) =>
  events
    .filter((e) => e.type === "content")
    .map((e) => (e as { text: string }).text)
    .join("");
const streamedCalls = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === "toolCall" ? [e.call] : []));

describe("extractTextualToolCalls", () => {
  it("extracts a Hermes <tool_call> block and stringifies arguments", () => {
    const content = `<tool_call>\n{"name": "marina_command", "arguments": {"command": "look"}}\n</tool_call>`;
    const { toolCalls, cleaned } = extractTextualToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.type).toBe("function");
    expect(toolCalls[0]!.function.name).toBe("marina_command");
    expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({ command: "look" });
    expect(cleaned).toBe("");
  });

  it("extracts multiple blocks and keeps surrounding prose", () => {
    const content =
      `Thinking about it.\n<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>\n` +
      `<tool_call>{"name":"b","arguments":{}}</tool_call>`;
    const { toolCalls, cleaned } = extractTextualToolCalls(content);
    expect(toolCalls.map((t) => t.function.name)).toEqual(["a", "b"]);
    expect(cleaned).toBe("Thinking about it.");
  });

  it("accepts `parameters` as an alias for `arguments`", () => {
    const { toolCalls } = extractTextualToolCalls(
      `<tool_call>{"name":"t","parameters":{"k":"v"}}</tool_call>`,
    );
    expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({ k: "v" });
  });

  it("recovers a tool call missing its closing tag (truncated stream)", () => {
    const { toolCalls } = extractTextualToolCalls(`<tool_call>{"name":"t","arguments":{}}`);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.function.name).toBe("t");
  });

  it("leaves invalid/nameless blocks as text (no destruction, no false calls)", () => {
    const garbage = "<tool_call>not json</tool_call>";
    expect(extractTextualToolCalls(garbage)).toEqual({ toolCalls: [], cleaned: garbage });
    const nameless = `<tool_call>{"arguments":{}}</tool_call>`;
    expect(extractTextualToolCalls(nameless).toolCalls).toHaveLength(0);
  });

  it("is a no-op on content with no tool-call tags", () => {
    expect(extractTextualToolCalls("just a normal answer")).toEqual({
      toolCalls: [],
      cleaned: "just a normal answer",
    });
  });
});

describe("normalizeTextualToolCalls", () => {
  it("promotes textual calls to structured tool_calls on the choice", () => {
    const data = {
      choices: [
        {
          message: {
            role: "assistant",
            content: `ok\n<tool_call>{"name":"marina_command","arguments":{"command":"look"}}</tool_call>`,
          },
          finish_reason: "stop",
        },
      ],
    };
    expect(normalizeTextualToolCalls(data)).toBe(true);
    const choice = data.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect((choice.message as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect(choice.message.content).toBe("ok");
  });

  it("leaves already-structured tool_calls untouched", () => {
    const data = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "x", type: "function", function: { name: "a", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    expect(normalizeTextualToolCalls(data)).toBe(false);
  });

  it("is a no-op for a plain text answer", () => {
    const data = {
      choices: [{ message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
    };
    expect(normalizeTextualToolCalls(data)).toBe(false);
    expect(data.choices[0]!.message.content).toBe("hello there");
  });
});

describe("ToolCallStreamParser (streaming)", () => {
  it("streams plain text through unchanged, no false tool calls", () => {
    const { events, sawToolCall } = runStream(["Hello ", "world, this is a normal answer."]);
    expect(streamedText(events)).toBe("Hello world, this is a normal answer.");
    expect(streamedCalls(events)).toHaveLength(0);
    expect(sawToolCall).toBe(false);
  });

  it("converts a tool call delivered in one chunk", () => {
    const { events, sawToolCall } = runStream([
      `<tool_call>{"name":"marina_command","arguments":{"command":"look"}}</tool_call>`,
    ]);
    expect(sawToolCall).toBe(true);
    expect(streamedText(events)).toBe("");
    const calls = streamedCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("marina_command");
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ command: "look" });
  });

  it("converts a tool call split across many chunks (tags + JSON straddle boundaries)", () => {
    const { events, sawToolCall } = runStream([
      "<tool_",
      'call>{"name":"t",',
      '"arguments":{"x":',
      "1}}</tool_",
      "call>",
    ]);
    expect(sawToolCall).toBe(true);
    const calls = streamedCalls(events);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ x: 1 });
  });

  it("streams prose before and after a tool call", () => {
    const { events } = runStream([
      `Let me look.<tool_call>{"name":"a","arguments":{}}</tool_call>done`,
    ]);
    expect(streamedText(events)).toBe("Let me look.done");
    expect(streamedCalls(events).map((c) => c.function.name)).toEqual(["a"]);
  });

  it("forwards structured tool_calls verbatim (caller handles them, not the parser)", () => {
    // The parser only ever sees content deltas; a plain text stream with no
    // tags emits no tool calls — this guards against false positives.
    const { events, sawToolCall } = runStream(["The answer is 42."]);
    expect(sawToolCall).toBe(false);
    expect(streamedCalls(events)).toHaveLength(0);
  });

  it("holds back a partial opening tag, then flushes it as text if it never completes", () => {
    const { events, sawToolCall } = runStream(["text<tool", " but not really"]);
    expect(sawToolCall).toBe(false);
    expect(streamedText(events)).toBe("text<tool but not really");
  });

  it("preserves invalid tool-call blocks as text instead of dropping them", () => {
    const { events, sawToolCall } = runStream(["<tool_call>not json</tool_call>"]);
    expect(sawToolCall).toBe(false);
    expect(streamedText(events)).toBe("<tool_call>not json</tool_call>");
  });
});
