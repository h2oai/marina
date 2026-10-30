// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { createArtifactReviewer } from "../src/coordination/task-artifact-model-review";
import { artifactReviewPacket } from "../src/coordination/task-artifact-review";

const packet = () =>
  artifactReviewPacket({
    taskId: 1,
    revision: 1,
    value: { choice: "DO-NOT-SEND-DRAFT" },
    requirements: { description: "Choose using current evidence" },
    reader: "reader",
    questions: [
      { id: "choice", path: "/choice", answerType: "string", refs: ["note:1", "note:2"] },
    ],
    resolve: (ref) =>
      ref === "note:1"
        ? { ref, status: "current", text: "No candidate is eligible.", version: "v1" }
        : { ref, status: "unavailable" },
  });

test("fresh review transport sends only two messages, preserves the output allowance and reports the served model", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const answers = [
    {
      id: "choice",
      status: "answered" as const,
      value: "none",
      reason: "No eligible candidate",
      citations: [{ ref: "note:1", quote: "No candidate is eligible." }],
    },
  ];
  const reviewer = createArtifactReviewer(
    { MARINA_DEFAULT_MAX_TOKENS: "24000" },
    {
      token: async () => "local-test-token",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return Response.json({
          model: "actually-served",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answers }) } }],
        });
      },
    },
  );
  expect(await reviewer(packet(), "requested")).toEqual({ model: "actually-served", answers });
  expect(requests).toHaveLength(1);
  const body = JSON.parse(requests[0]!.init.body as string);
  expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
    "system",
    "user",
  ]);
  expect(body.max_tokens).toBe(24000);
  expect(body.model).toBe("requested");
  expect(JSON.stringify(body)).not.toContain("DO-NOT-SEND-DRAFT");
  expect(new Headers(requests[0]!.init.headers).get("x-marina-stack")).toBe("none");
  expect(JSON.parse(body.messages[1].content).sources[1]).toEqual({
    ref: "note:2",
    status: "unavailable",
  });
});

test("truncated, malformed and failed fresh responses cannot become assessments or silently retry", async () => {
  for (const response of [
    Response.json({
      choices: [{ finish_reason: "length", message: { content: '{"answers":[]}' } }],
    }),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] }),
    new Response("provider failed", { status: 503 }),
  ]) {
    let calls = 0;
    const reviewer = createArtifactReviewer(
      {},
      {
        token: async () => "local-test-token",
        fetch: async () => {
          calls++;
          return response;
        },
      },
    );
    await expect(reviewer(packet(), "requested")).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("fresh review refuses model aliases that can introduce agent context or additional calls", async () => {
  let calls = 0;
  const reviewer = createArtifactReviewer(
    {},
    {
      token: async () => "local-test-token",
      fetch: async () => {
        calls++;
        throw new Error("Unexpected model request");
      },
    },
  );
  for (const model of [
    "marina:reviewer",
    "marina/lessons:requested",
    "marina/verify:requested",
    "marina/ensemble:a,b",
    "marina/cheap",
    "strong",
  ]) {
    await expect(reviewer(packet(), model)).rejects.toThrow("upstream model ID");
  }
  expect(calls).toBe(0);
});

test("shutdown refuses new reviews and cancels an in-flight review without retry", async () => {
  for (const stage of ["before-token", "during-token", "in-flight"] as const) {
    const shutdown = new AbortController();
    let tokens = 0,
      calls = 0;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    if (stage === "before-token") shutdown.abort(new Error("Server shutting down"));
    const reviewer = createArtifactReviewer(
      {},
      {
        signal: shutdown.signal,
        token: async () => {
          tokens++;
          if (stage === "during-token") shutdown.abort(new Error("Server shutting down"));
          return "local-test-token";
        },
        fetch: async (_url, init) => {
          calls++;
          return new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            signal.throwIfAborted();
            started();
          });
        },
      },
    );
    const settled = reviewer(packet(), "upstream").then(
      () => ({ error: undefined }),
      (error: Error) => ({ error }),
    );
    if (stage === "in-flight") {
      await dispatched;
      shutdown.abort(new Error("Server shutting down"));
    }
    expect((await settled).error?.message).toBe("Server shutting down");
    expect(tokens).toBe(stage === "before-token" ? 0 : 1);
    expect(calls).toBe(stage === "in-flight" ? 1 : 0);
  }
});
