// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingQualificationFixture, qualifyCoding } from "../scripts/qualify-coding";
import { scopeProcessState } from "./process-state";

test("scripted provider drives real console, worker, candidate checks, review and compaction", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "marina-controls-test-"));
  using _state = scopeProcessState({ env: { OPENAI_API_KEY: "scripted-provider-only" } });
  const network = globalThis.fetch;
  let stage = 0;
  let nonce = "";
  let originalTask = "";
  let inspectedOriginal = false;
  const requested: string[] = [];
  const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return network(request);
    expect(url.href).toBe("https://api.openai.com/v1/chat/completions");
    const body = (await request.json()) as {
      model: string;
      stream?: boolean;
      messages: unknown[];
      tools?: { function: { name: string } }[];
    };
    const text = JSON.stringify(body.messages);
    nonce ||= /continuity-[a-f0-9-]+/.exec(text)?.[0] ?? "";
    const names = body.tools?.map((t) => t.function.name) ?? [];
    const plan = names.includes("marina_code_summary") && !names.includes("marina_code");
    let tool: { name: string; arguments: string } | undefined;
    const call = (name: string, args: Record<string, unknown>) => {
      if (!names.includes(name) && names.includes("marina_code")) {
        args = { action: name.replace("marina_code_", ""), ...args };
        name = "marina_code";
      }
      expect(names).toContain(name);
      requested.push(name);
      tool = { name, arguments: JSON.stringify(args) };
    };
    if (plan && stage === 0) {
      originalTask = /task_run_[a-z0-9_-]+/.exec(text)?.[0] ?? "";
      call("marina_code_read_file", { path: "source.ts" });
      stage = 1;
    } else if (plan && stage === 1) {
      call("marina_code_summary", {
        text: `Proposal: fix the exclusive slice endpoint and add boundary regression tests. No files changed or commands executed. Preserve corrupted-summary-marker.`,
      });
      stage = 2;
    } else if (plan && stage === 6 && !inspectedOriginal) {
      expect(originalTask).not.toBe("");
      call("marina_code_show", { artifactId: originalTask });
      inspectedOriginal = true;
    } else if (plan && stage >= 6) {
      call("marina_code_summary", {
        text: `The unresolved continuity marker is ${nonce}. No files changed.`,
      });
      stage = 7;
    } else if (
      !plan &&
      (names.includes("marina_code_edit") || names.includes("marina_code")) &&
      stage === 2
    ) {
      call("marina_code_edit", {
        path: "source.ts",
        oldText: "start + size - 1",
        newText: "start + size",
      });
      stage = 3;
    } else if (
      (names.includes("marina_code_write") || names.includes("marina_code")) &&
      stage === 3
    ) {
      call("marina_code_write", {
        path: "regression.test.ts",
        content: `import { expect, test } from "bun:test";\nimport { paginate } from "./source";\ntest("pagination edges", () => { expect(paginate([1,2],2,1)).toEqual([2]); expect(paginate([],1,1)).toEqual([]); expect(paginate([1],3,1)).toEqual([]); });\n`,
      });
      stage = 4;
    } else if (
      (names.includes("marina_code_verify") || names.includes("marina_code")) &&
      stage === 4
    ) {
      call("marina_code_verify", { verificationMode: "candidate" });
      stage = 5;
    } else if (
      (names.includes("marina_code_summary") || names.includes("marina_code")) &&
      stage === 5
    ) {
      if (/passed|3 pass/.test(text.slice(-16000))) {
        call("marina_code_summary", {
          text: "Fixed the exclusive pagination endpoint in source.ts and added regression.test.ts for size=1, empty input and a page beyond the end. Candidate verification passed all 3 tests with zero failures; protected acceptance and package files are unchanged.",
        });
        stage = 6;
      } else {
        const requestId = /verification_request_[a-z0-9_-]+/.exec(text)?.[0];
        if (requestId) call("marina_code", { action: "show", artifactId: requestId });
        else call("marina_code_artifacts", { kind: "verification" });
      }
    }
    const message = tool
      ? {
          role: "assistant",
          tool_calls: [{ id: `call_${requested.length}`, type: "function", function: tool }],
        }
      : {
          role: "assistant",
          content: `Preserve unresolved marker ${nonce}. Awaiting the next owner request.`,
        };
    const usage = { prompt_tokens: 3000, completion_tokens: 80, total_tokens: 3080 };
    const base = { id: crypto.randomUUID(), model: body.model, created: 1 };
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
        usage,
      });
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] }
      : message;
    return new Response(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }], usage })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    const report = await qualifyCoding(
      { directory: join(scratch, "evidence"), budgetUsd: 25, cliControls: true, timeoutMs: 60000 },
      provider,
    );
    if (report.error) {
      const traces = await Bun.file(join(scratch, "evidence", "traces.json")).json();
      console.error(
        "Scripted stage",
        stage,
        requested,
        JSON.stringify(
          traces
            .filter((x: { event: { type: string } }) => x.event.type === "tool_result")
            .slice(0, 10),
        ),
      );
    }
    expect(report.error).toBeUndefined();
    expect(report.passed).toBe(true);
    expect(requested).toContain("marina_code");
    expect(stage).toBe(7);
    expect(requested).toContain("marina_code_show");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 150000);

for (const failure of ["timeout", "malformed-tool"] as const) {
  test(`provider ${failure} leaves no successful result or late workspace write`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "marina-controls-failure-"));
    using _state = scopeProcessState({ env: { OPENAI_API_KEY: "scripted-provider-only" } });
    const network = globalThis.fetch;
    let cancelled = false;
    const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (["127.0.0.1", "localhost"].includes(new URL(request.url).hostname))
        return network(request);
      if (failure === "timeout")
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            cancelled = true;
            reject(request.signal.reason);
          };
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        });
      const chunk = {
        id: crypto.randomUUID(),
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-6-luna",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "malformed",
                  type: "function",
                  function: { name: "marina_code", arguments: '{"action":"write","path":' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const directory = join(scratch, "evidence");
      const report = await qualifyCoding({ directory, budgetUsd: 25, timeoutMs: 1000 }, provider);
      expect(report.passed).toBe(false);
      expect(report.error).toBeDefined();
      expect(report.workers_settled).toBe(true);
      if (failure === "timeout") expect(cancelled).toBe(true);
      expect(readFileSync(join(directory, "bugfix", "source.ts"), "utf8")).toBe(
        codingQualificationFixture("bugfix").source,
      );
      const persisted = await Bun.file(join(directory, "report.json")).json();
      expect(persisted.passed).toBe(false);
      expect(persisted.spending.attempts).toBeGreaterThan(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30000);
}
