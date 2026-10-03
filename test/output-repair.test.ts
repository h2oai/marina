// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Output repair (`src/repair/`): a deterministic parse first, then ONE bounded
 * re-encoding shot whose values must appear verbatim in the original, then a
 * labelled delivery. Meaning never changes: a shot that answers, adds a field
 * or invents an id is discarded. Off for callers that want raw output.
 */

import { describe, expect, it } from "bun:test";
import {
  extractJsonValue,
  extractMarkedAnswer,
  groundedIn,
  outputRepairMode,
  repairFinalAnswer,
  repairOutput,
  stripReasoning,
} from "../src/repair/output-repair";
import { repairToolCallMessage } from "../src/repair/tool-call-repair";

describe("deterministic parsing", () => {
  it("finds JSON in fenced, chatty and loosely written output", () => {
    expect(extractJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonValue('Sure!\n```json\n{"a": 1,}\n```\nDone.')).toEqual({ a: 1 });
    expect(extractJsonValue('<think>{"no": 0}</think> result: {"answer": "B"} ok')).toEqual({
      answer: "B",
    });
    expect(extractJsonValue("The value is {“x”: 2}")).toEqual({ x: 2 });
    expect(extractJsonValue('text {"s": "a } b"} tail')).toEqual({ s: "a } b" });
    expect(extractJsonValue("no json here")).toBeUndefined();
  });

  it("reads only an explicitly marked answer", () => {
    expect(extractMarkedAnswer("Working...\n**Final Answer:** 42")).toBe("42");
    expect(extractMarkedAnswer("so x = \\boxed{\\frac{1}{2}}")).toBe("\\frac{1}{2}");
    expect(extractMarkedAnswer("Answer: Paris\nThen more.\nAnswer: Lyon")).toBe("Lyon");
    expect(extractMarkedAnswer("I think it is probably 42.")).toBeUndefined();
    expect(stripReasoning("<think>hidden</think>visible")).toBe("visible");
  });

  it("groundedIn holds every value to the original text, keys excepted", () => {
    expect(groundedIn({ answer: "Paris", n: 42 }, "The capital is paris; 42 total")).toBe(true);
    expect(groundedIn({ answer: "Lyon" }, "The capital is Paris")).toBe(false);
    expect(groundedIn({ order_id: "W123" }, "cancel order #W124")).toBe(false);
    expect(groundedIn([null, undefined, ""], "anything")).toBe(true);
    // Short tokens and numbers must stand alone, with their case.
    expect(groundedIn("A", "I cannot decide, a tough call")).toBe(false);
    expect(groundedIn("A", "so option A it is")).toBe(true);
    expect(groundedIn(7, "order 17 shipped")).toBe(false);
    expect(groundedIn(0.7, "confidence 0.7, roughly")).toBe(true);
  });
});

describe("repairOutput", () => {
  const parseAnswer = (t: string) => {
    const v = extractJsonValue(t) as { answer?: unknown } | undefined;
    return typeof v?.answer === "string" ? v.answer : undefined;
  };

  it("returns output that already meets the contract unlabelled", async () => {
    const r = await repairOutput({ raw: '{"answer":"B"}', parse: parseAnswer, contract: "x" });
    expect(r).toEqual({ value: "B", label: null });
  });

  it("labels a mechanical fix repaired:parse and never calls the shot", async () => {
    let shots = 0;
    const r = await repairOutput({
      raw: 'Here you go:\n```\n{"answer": "B",}\n```',
      parse: (t) => {
        try {
          return (JSON.parse(t) as { answer?: string }).answer;
        } catch {
          return undefined;
        }
      },
      contract: "x",
      shot: async () => {
        shots++;
        return "";
      },
    });
    expect(r).toEqual({ value: "B", label: "repaired:parse" });
    expect(shots).toBe(0);
  });

  it("uses ONE re-encoding shot and keeps it only when grounded", async () => {
    const prompts: string[] = [];
    const grounded = await repairOutput({
      raw: "After checking both sources the capital is Canberra.",
      parse: parseAnswer,
      contract: '{"answer": "..."}',
      mode: "on",
      shot: async (system, user) => {
        prompts.push(system, user);
        return '{"answer": "Canberra"}';
      },
    });
    expect(grounded).toEqual({ value: "Canberra", label: "repaired:shot" });
    expect(prompts[0]).toContain("VERBATIM");
    expect(prompts[1]).toContain("After checking both sources");

    // The shot "answered" instead of re-encoding: discarded.
    const invented = await repairOutput({
      raw: "I am not sure what the capital is.",
      parse: parseAnswer,
      contract: '{"answer": "..."}',
      mode: "on",
      shot: async () => '{"answer": "Canberra"}',
    });
    expect(invented).toBeUndefined();
    const none = await repairOutput({
      raw: "no answer",
      parse: parseAnswer,
      contract: "x",
      mode: "on",
      shot: async () => "NONE",
    });
    expect(none).toBeUndefined();
  });

  it("honours parse-only and off modes", async () => {
    let shots = 0;
    const shot = async () => {
      shots++;
      return '{"answer": "Canberra"}';
    };
    const raw = "the capital is Canberra";
    expect(
      await repairOutput({ raw, parse: parseAnswer, contract: "x", shot, mode: "parse" }),
    ).toBeUndefined();
    expect(
      await repairOutput({
        raw: '```{"answer":"A"}```',
        parse: (t) => (t.startsWith("{") ? parseAnswer(t) : undefined),
        contract: "x",
        mode: "off",
      }),
    ).toBeUndefined();
    expect(shots).toBe(0);
    expect(outputRepairMode({})).toBe("on");
    expect(outputRepairMode({ MARINA_OUTPUT_REPAIR: "off" })).toBe("off");
    expect(outputRepairMode({ MARINA_OUTPUT_REPAIR: "parse" })).toBe("parse");
  });

  it("a throwing shot is no repair, never an error", async () => {
    const r = await repairOutput({
      raw: "prose",
      parse: parseAnswer,
      contract: "x",
      mode: "on",
      shot: async () => {
        throw new Error("upstream down");
      },
    });
    expect(r).toBeUndefined();
  });

  it("repairFinalAnswer: marked answers deterministically, otherwise one grounded shot", async () => {
    expect(await repairFinalAnswer("Reasoning.\nFinal answer: 1060", { mode: "on" })).toEqual({
      value: "1060",
      label: "repaired:parse",
    });
    expect(
      await repairFinalAnswer("Summing the first 50 primes gives 5117 in total.", {
        mode: "on",
        shot: async () => '{"answer":"5117"}',
      }),
    ).toEqual({ value: "5117", label: "repaired:shot" });
    expect(
      await repairFinalAnswer("Let me look that up first.", {
        mode: "on",
        shot: async () => '{"answer":"5117"}',
      }),
    ).toBeUndefined();
  });
});

describe("tool-call repair (write-guard rules)", () => {
  const tools = [
    { type: "function", function: { name: "get_order" } },
    { type: "function", function: { name: "cancel_order" } },
  ];
  const isWrite = (name: string) => name === "cancel_order";

  it("re-parses malformed arguments without changing them", async () => {
    const r = await repairToolCallMessage({
      message: {
        role: "assistant",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "cancel_order", arguments: '```json\n{"order_id": "W123",}\n```' },
          },
        ],
      },
      tools,
      isWrite,
      mode: "on",
    });
    expect(r?.label).toBe("repaired:parse");
    expect(r?.message.tool_calls?.[0]?.function?.arguments).toBe('{"order_id":"W123"}');
    expect(r?.message.tool_calls?.[0]?.id).toBe("c1");
  });

  it("turns an embedded call for a declared tool into a tool call", async () => {
    const r = await repairToolCallMessage({
      message: {
        role: "assistant",
        content:
          'I will cancel it now.\n<tool_call>{"name": "cancel_order", "arguments": {"order_id": "W123", "reason": "duplicate"}}</tool_call>',
      },
      tools,
      isWrite,
      mode: "on",
    });
    expect(r?.label).toBe("repaired:parse");
    expect(r?.message.content).toBeNull();
    expect(r?.message.tool_calls?.[0]?.function).toEqual({
      name: "cancel_order",
      arguments: '{"order_id":"W123","reason":"duplicate"}',
    });
  });

  it("refuses undeclared tools, and shots that add an id or a field to a write call", async () => {
    expect(
      await repairToolCallMessage({
        message: {
          role: "assistant",
          content: '{"name": "delete_account", "arguments": {"id": "A1"}}',
        },
        tools,
        isWrite,
        mode: "on",
      }),
    ).toBeUndefined();
    const content = "Please cancel_order for order W123.";
    expect(
      await repairToolCallMessage({
        message: { role: "assistant", content },
        tools,
        isWrite,
        mode: "on",
        shot: async () => '{"name": "cancel_order", "arguments": {"order_id": "W999"}}',
      }),
    ).toBeUndefined();
    expect(
      await repairToolCallMessage({
        message: { role: "assistant", content },
        tools,
        isWrite,
        mode: "on",
        shot: async () =>
          '{"name": "cancel_order", "arguments": {"order_id": "W123", "refund": "W123"}}',
      }),
    ).toBeUndefined();
    const ok = await repairToolCallMessage({
      message: { role: "assistant", content },
      tools,
      isWrite,
      mode: "on",
      shot: async () => '{"name": "cancel_order", "arguments": {"order": "W123"}}',
    });
    expect(ok?.label).toBe("repaired:shot");
    expect(ok?.message.tool_calls?.[0]?.function?.arguments).toBe('{"order":"W123"}');
  });

  it("does nothing for plain prose that names no tool, or when repair is off", async () => {
    let shots = 0;
    const shot = async () => {
      shots++;
      return "NONE";
    };
    expect(
      await repairToolCallMessage({
        message: { role: "assistant", content: "Your order has shipped." },
        tools,
        isWrite,
        mode: "on",
        shot,
      }),
    ).toBeUndefined();
    expect(shots).toBe(0);
    expect(
      await repairToolCallMessage({
        message: { role: "assistant", content: '{"name": "get_order", "arguments": {"id": "W1"}}' },
        tools,
        isWrite,
        mode: "off",
      }),
    ).toBeUndefined();
  });
});
