// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readOnlyCall } from "../src/obligations/tool-call";
import {
  isReadOnlyTool,
  readOnlyByName,
  type ToolEffectRole,
  toolEffect,
} from "../src/obligations/tool-effect";

/** An OpenAI-shaped declaration. */
function fn(
  name: string,
  description?: string,
  properties: Record<string, unknown> = {},
  annotations?: Record<string, unknown>,
) {
  return {
    type: "function",
    function: { name, ...(description ? { description } : {}), parameters: { properties } },
    ...(annotations ? { annotations } : {}),
  };
}

const both: ToolEffectRole[] = ["guard", "track"];
const roles = (name: string, tools: unknown[]) => both.map((r) => isReadOnlyTool(name, tools, r));

describe("declared hints", () => {
  it("readOnlyHint wins over the name and the description, in both roles", () => {
    const tools = [
      fn("update_profile", "Update the user's profile.", {}, { readOnlyHint: true }),
      fn("get_rates", "Get the rates.", {}, { readOnlyHint: false }),
      fn("search_docs", "Search the docs.", {}, { destructiveHint: true }),
    ];
    expect(roles("update_profile", tools)).toEqual([true, true]);
    expect(roles("get_rates", tools)).toEqual([false, false]);
    expect(roles("search_docs", tools)).toEqual([false, false]);
    expect(toolEffect("get_rates", tools).basis).toBe("declared");
  });

  it("reads hints at the top level, under `function`, and on MCP/Anthropic shapes", () => {
    const tools = [
      { type: "function", function: { name: "run_job", annotations: { readOnlyHint: true } } },
      { name: "do_thing", description: "x", inputSchema: {}, annotations: { readOnlyHint: true } },
    ];
    expect(isReadOnlyTool("run_job", tools)).toBe(true);
    expect(isReadOnlyTool("do_thing", tools)).toBe(true);
  });
});

describe("names", () => {
  it("read verbs lead, after up to two namespace words, or in camelCase", () => {
    for (const n of [
      "get_order",
      "list_items",
      "search_flights",
      "find_user_id_by_email",
      "lookup_rate",
      "read_file",
      "check_status",
      "view_cart",
      "describe_table",
      "KB_search_bm25",
      "mcp__docs__get_page",
      "marina_look",
      "tool_search",
      "getUserById",
      "searchDocs",
    ]) {
      expect([n, readOnlyByName(n)]).toEqual([n, true]);
    }
  });

  it("a write verb in the lead position is a write even before a read word", () => {
    for (const n of [
      "deposit_check_3847",
      "set_read_log_allowlist",
      "cancel_list_subscription",
      "createIssue",
      "mcp__github__create_pull_request",
    ]) {
      expect([n, readOnlyByName(n)]).toEqual([n, false]);
    }
  });

  it("noun-like read words count only at the start (`assert_line_status` is not a lookup)", () => {
    expect(readOnlyByName("status_report")).toBe(true);
    expect(readOnlyByName("marina_brief")).toBe(true);
    expect(readOnlyByName("assert_line_status")).toBe(false);
  });
});

describe("descriptions", () => {
  it("an undecided name is read-only when the description leads with a read verb", () => {
    const tools = [
      fn("kb", "Search the knowledge base for passages."),
      fn("docs", "Retrieves a document by id."),
      fn("weather", "Returns the current weather for a city."),
      fn("faq", "Use this tool to look up answers in the FAQ."),
    ];
    for (const n of ["kb", "docs", "weather", "faq"]) expect(roles(n, tools)).toEqual([true, true]);
    expect(toolEffect("kb", tools).basis).toBe("description");
  });

  it("a description leading with a write verb is a write, even under a read-like name", () => {
    const tools = [
      fn("account_settings", "Change the email address for a user."),
      fn("get_refund", "Issue a refund for an order."),
      fn("orders", "Submits the order for fulfilment."),
      fn("returns", "Return some items of a delivered order."),
    ];
    for (const n of ["account_settings", "get_refund", "orders", "returns"])
      expect([n, ...roles(n, tools)]).toEqual([n, false, false]);
  });

  it("a read lead with a write word elsewhere is not a read", () => {
    const tools = [fn("profile", "Retrieves and updates the user's profile.")];
    expect(roles("profile", tools)).toEqual([false, false]);
  });
});

describe("ambiguous verbs", () => {
  const unlock = fn(
    "unlock_discoverable_agent_tool",
    "Unlock an agent discoverable tool that was found in the knowledge base.\n\nUse this when the knowledge base indicates that you have access to a specialized internal tool.\n\nAfter unlocking, you can use the tool by calling `call_discoverable_agent_tool` with the tool name and required arguments.",
    { agent_tool_name: { type: "string" } },
  );
  const unlockCard = fn("unlock_card", "Unlock the user's card so they can access it again.", {
    card_id: { type: "string" },
  });
  const give = fn(
    "give_discoverable_user_tool",
    "Pass a tool to the user so they can execute it themselves.\n\nUse this when the knowledge base indicates that the user should perform an action themselves.",
    { discoverable_tool_name: { type: "string" }, arguments: { type: "string" } },
  );
  const shell = fn(
    "shell",
    "Execute a shell command in the knowledge base directory.\n\nUse standard Unix utilities to explore and search the knowledge base files.\nCommon commands: ls, cat, grep, head, tail, find, wc.",
    { command: { type: "string" } },
  );
  const bash = fn("bash", "Run a bash command.", { command: { type: "string" } });
  const tools = [unlock, unlockCard, give, shell, bash];

  it("an unlock that grants access to a tool is a read; one on user state is a write", () => {
    expect(roles("unlock_discoverable_agent_tool", tools)).toEqual([true, true]);
    expect(toolEffect("unlock_discoverable_agent_tool", tools).basis).toBe("access");
    expect(roles("unlock_card", tools)).toEqual([false, false]);
    // Without a description an ambiguous verb is a write.
    expect(readOnlyByName("unlock_discoverable_agent_tool")).toBe(false);
  });

  it("handing the user an action stays a write", () => {
    expect(roles("give_discoverable_user_tool", tools)).toEqual([false, false]);
  });

  it("a shell described as exploring is read-only for the ledger only; a bare shell is a write", () => {
    expect(roles("shell", tools)).toEqual([false, true]);
    expect(toolEffect("shell", tools, "track").basis).toBe("weak");
    expect(roles("bash", tools)).toEqual([false, false]);
  });

  it("a lone free-text search parameter is ledger read evidence; a lone command is not", () => {
    const shaped = [
      fn("kb", undefined, { query: { type: "string" }, k: { type: "integer" } }),
      fn("exec", undefined, { command: { type: "string" } }),
      fn("ticket", undefined, { query: { type: "string" }, account_id: { type: "string" } }),
    ];
    expect(roles("kb", shaped)).toEqual([false, true]);
    expect(roles("exec", shaped)).toEqual([false, false]);
    expect(roles("ticket", shaped)).toEqual([false, false]);
  });
});

describe("dispatcher inner tools", () => {
  const call = fn(
    "call_discoverable_agent_tool",
    "Call an agent discoverable tool that you have previously unlocked.",
    { agent_tool_name: { type: "string" }, arguments: { type: "string" } },
  );
  const tools = [call];
  const run = (inner: string, role: ToolEffectRole) =>
    readOnlyCall(
      "call_discoverable_agent_tool",
      { agent_tool_name: inner, arguments: '{"user_id":"u1"}' },
      { tools, role },
    );

  it("is classified by the inner tool in both roles", () => {
    for (const role of both) {
      expect(run("get_bank_account_transactions_9173", role)).toBe(true);
      expect(run("calculate_apr_adjustment_7842", role)).toBe(true);
      expect(run("apply_savings_account_credit_6831", role)).toBe(false);
      expect(run("submit_interest_discrepancy_report_7294", role)).toBe(false);
      expect(run("deposit_check_3847", role)).toBe(false);
    }
  });

  it("the outer dispatcher itself is a write (no read evidence in its description)", () => {
    expect(roles("call_discoverable_agent_tool", tools)).toEqual([false, false]);
  });
});

describe("regression: genuine writes stay writes", () => {
  const writes: Array<[string, string]> = [
    [
      "cancel_pending_order",
      "Cancel a pending order. If the order is already processed, it cannot be cancelled.",
    ],
    [
      "modify_pending_order_items",
      "Modify items in a pending order to new items of the same product type.",
    ],
    ["return_delivered_order_items", "Return some items of a delivered order."],
    ["exchange_delivered_order_items", "Exchange items in a delivered order to new items."],
    ["book_reservation", "Book a reservation."],
    ["update_reservation_flights", "Update the flight information of a reservation."],
    ["send_certificate", "Send a certificate to a user. Be careful!"],
    [
      "transfer_to_human_agents",
      "Transfer the user to a human agent, with a summary of the user's issue.",
    ],
    ["toggle_airplane_mode", "Toggles airplane mode ON or OFF."],
    ["change_user_email", "Change the email address for a user."],
    [
      "log_verification",
      "Log a verification record after successfully verifying a user's identity.",
    ],
    ["file_credit_card_transaction_dispute_4829", "File a dispute for a credit card transaction."],
  ];

  it("with and without descriptions, in both roles", () => {
    const tools = writes.map(([n, d]) => fn(n, d, { id: { type: "string" } }));
    for (const [n] of writes) {
      expect([n, ...roles(n, tools)]).toEqual([n, false, false]);
      expect([n, readOnlyByName(n)]).toEqual([n, false]);
    }
  });

  it("an unknown tool with no declaration is a write", () => {
    for (const role of both) expect(isReadOnlyTool("process_payment_batch", [], role)).toBe(false);
    expect(isReadOnlyTool("refund", undefined, "track")).toBe(false);
  });
});
