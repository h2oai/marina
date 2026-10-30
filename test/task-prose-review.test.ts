// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  artifactFileHash,
  type TaskArtifactFileAccess,
} from "../src/coordination/task-artifact-file";
import { reviewTaskProseFile } from "../src/coordination/task-prose-file";
import { createProseReviewer } from "../src/coordination/task-prose-model-review";
import {
  assessProseReview,
  type ProseReviewAnswer,
  type ProseReviewer,
  proseReviewPacket,
} from "../src/coordination/task-prose-review";
import { TaskWork, WORK_CHECK_TTL_MS, type WorkActor } from "../src/coordination/task-work";
import { resolveEvidenceSource } from "../src/decisions/evidence";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

const original = "Authorization has 11 units unused. The proposal consumes 8 units.";
const claim = "After the proposal, no authorization remains.";
const input = () => ({ target: { name: "handoff.md", content: claim }, refs: ["note:1"] });
const packet = () =>
  proseReviewPacket({
    taskId: 1,
    revision: 1,
    reader: "owner",
    requirements: "Accurate handoff",
    artifact: { proposed: 8 },
    request: input(),
    resolve: (ref) => ({ ref, status: "current", text: original, version: "v1" }),
  });
const finding = (): ProseReviewAnswer => ({
  findings: [
    {
      quote: claim,
      status: "contradicted",
      reason: "11 - 8 = 3 units remain.",
      citations: [{ ref: "note:1", quote: original }],
    },
  ],
  limitations: [],
});

test("prose findings bind the actual extra claim and original source, not a matching artifact value", () => {
  const p = packet();
  expect(p.artifact).toEqual({ proposed: 8 });
  const report = assessProseReview(p, finding());
  expect(report.outcome).toBe("findings");
  expect(report.target.sha256).toBe(artifactFileHash(claim)!);
  expect(report.findings[0]!.reason).toContain("3 units remain");
  const wrongTarget = finding();
  wrongTarget.findings[0]!.quote = "a claim not in the prose";
  expect(() => assessProseReview(p, wrongTarget)).toThrow("exact target");
  const wrongSource = finding();
  wrongSource.findings[0]!.citations[0]!.quote = "Authorization is exhausted.";
  expect(() => assessProseReview(p, wrongSource)).toThrow("nonverbatim");
  const uncited = finding();
  uncited.findings[0]!.citations = [];
  expect(() => assessProseReview(p, uncited)).toThrow("original source citations");
});

test("an unavailable original cannot yield approval or a private-version guessing oracle", () => {
  const make = (secret: string) =>
    proseReviewPacket({
      taskId: 1,
      revision: 0,
      reader: "peer",
      requirements: "handoff",
      artifact: null,
      request: input(),
      resolve: (ref) => ({ ref, status: "unavailable", version: secret, text: secret }),
    });
  const p = make("secret-one");
  expect(JSON.stringify(p)).not.toContain("secret-one");
  expect(p.fingerprint).toBe(make("secret-two").fingerprint);
  expect(assessProseReview(p, { findings: [], limitations: [] }).outcome).toBe("unverified");
  expect(() => assessProseReview(p, finding())).toThrow("unavailable");
  const unknown = finding();
  unknown.findings[0]!.status = "unverified";
  unknown.findings[0]!.citations = [];
  expect(assessProseReview(p, unknown).outcome).toBe("unverified");
  expect(assessProseReview(packet(), { findings: [], limitations: [] }).outcome).toBe(
    "no-findings",
  );
  // Limitations are asked for on every run; alone they are not "something went unchecked".
  const limited = assessProseReview(packet(), {
    findings: [],
    limitations: ["Model interpretation of the custody wording may be incomplete."],
  });
  expect(limited.outcome).toBe("no-findings");
  expect(limited.limitations).toHaveLength(1);
  // An unavailable source names why, as far as is safe: here only that it was unavailable.
  const unread = assessProseReview(p, { findings: [], limitations: [] });
  expect(unread.outcome).toBe("unverified");
  expect(unread.unavailableReasons).toEqual({ "note:1": "unavailable" });
});

describe("optional durable prose review", () => {
  let f: ReturnType<typeof createTestEngine>,
    owner: WorkActor,
    peer: WorkActor,
    id: number,
    ref: string;
  beforeEach(() => {
    f = createTestEngine();
    owner = { id: f.login("Owner").entityId, name: "Owner" };
    peer = { id: f.login("Peer").entityId, name: "Peer" };
    id = f.engine.taskManager!.create({
      title: "Handoff",
      creatorId: owner.id,
      creatorName: owner.name,
    }).id;
    ref = `note:${f.db.createNote(owner.name, original)}`;
  });
  afterEach(async () => {
    await f.dispose();
  });
  const none = async () => ({ findings: [], limitations: [], model: "served" });

  test("identical concurrent requests share inference; current receipts reuse, expire and bind text/model/access", async () => {
    let calls = 0;
    const work = new TaskWork(
      f.db,
      (actor, source) => resolveEvidenceSource(f.db, actor, source),
      undefined,
      async () => {
        calls++;
        return none();
      },
    );
    const request = { ...input(), refs: [ref] };
    const [a, b] = await Promise.all([
      work.reviewFreshProse(id, owner, request),
      work.reviewFreshProse(id, owner, request),
    ]);
    expect(calls).toBe(1);
    expect(a.receiptId).toBe(b.receiptId);
    expect((await work.reviewFreshProse(id, owner, request)).reused).toBe(true);
    expect(calls).toBe(1);
    const now = spyOn(Date, "now").mockReturnValue(a.createdAt + WORK_CHECK_TTL_MS + 1);
    try {
      expect((await work.reviewFreshProse(id, owner, request)).reused).toBe(false);
    } finally {
      now.mockRestore();
    }
    await work.reviewFreshProse(id, owner, {
      ...request,
      target: { ...request.target, content: "Revised prose." },
    });
    await work.reviewFreshProse(id, owner, { ...request, model: "another" });
    const peerResult = await work.reviewFreshProse(id, peer, request);
    expect(calls).toBe(5);
    const low = await work.reviewFreshProse(id, owner, { ...request, reasoningEffort: "low" });
    expect(low.reused).toBe(false);
    expect(
      (await work.reviewFreshProse(id, owner, { ...request, reasoningEffort: "low" })).receiptId,
    ).toBe(low.receiptId);
    await work.reviewFreshProse(id, owner, { ...request, reasoningEffort: "high" });
    expect(calls).toBe(7);
    expect(peerResult.report.outcome).toBe("unverified");
    expect(f.db.getTask(id)!.status).toBe("open");
    expect(f.db.getTaskWorkRevision(id)).toBeUndefined();
  });

  test("work, source or access changes during inference reject the assessment", async () => {
    for (const change of ["work", "source", "access"] as const) {
      let release!: (value: Awaited<ReturnType<ProseReviewer>>) => void;
      let changed = false;
      const work = new TaskWork(
        f.db,
        (actor, source) => {
          const resolved = resolveEvidenceSource(f.db, actor, source);
          return !changed
            ? resolved
            : change === "access"
              ? { ref: source, status: "unavailable" }
              : change === "source"
                ? { ...resolved, text: `${original} Updated.`, version: "new" }
                : resolved;
        },
        undefined,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = work.reviewFreshProse(id, owner, { ...input(), refs: [ref] });
      changed = true;
      if (change === "work")
        work.editArtifact(id, owner, 0, [{ op: "set", path: "", value: { proposed: 8 } }]);
      release(await none());
      await expect(pending).rejects.toThrow("context changed");
    }
  });

  test("task access and unconfigured review fail without preventing ordinary work", async () => {
    const work = new TaskWork(f.db, (actor, source) => resolveEvidenceSource(f.db, actor, source));
    await expect(work.reviewFreshProse(id, owner, { ...input(), refs: [ref] })).rejects.toThrow(
      "not configured",
    );
    expect(work.reviewProse(id, owner, { ...input(), refs: [ref] }).target.content).toBe(claim);
    f.db.createGroup({ id: "private-prose", name: "private", leaderId: owner.id });
    f.db.addGroupMember("private-prose", owner.id);
    const privateTask = f.engine.taskManager!.create({
      title: "Private",
      creatorId: owner.id,
      creatorName: owner.name,
      groupId: "private-prose",
    });
    expect(() => work.reviewProse(privateTask.id, peer, { ...input(), refs: [ref] })).toThrow(
      "accessible",
    );
    expect(
      work.editArtifact(id, owner, 0, [{ op: "set", path: "", value: { value: 1 } }]).revision,
    ).toBe(1);
  });

  test("the registered packet command includes actual text without making a provider call", async () => {
    using _scope = scopeProcessState({ rateLimitBypass: true });
    const session = f.login("CommandReader");
    const request = { ...input(), refs: [ref] };
    await f.engine.dispatchCommand(
      session.entityId,
      `task work ${id} prose-review ${JSON.stringify(request)}`,
    );
    const messages = JSON.stringify(session.connection.messages);
    expect(messages).toContain("task-prose-review-v1");
    expect(messages).toContain(claim);
    expect(messages).not.toContain(original);
  });
});

test("file review submits exact captured bytes, never writes, and refuses stale input or a raced result", async () => {
  let content = claim,
    version = "1",
    calls = 0,
    race = false;
  const access: TaskArtifactFileAccess = {
    read: async () => ({ content, version }),
    compareAndWrite: async () => {
      throw new Error("Review must not write");
    },
    command: async (command) => {
      calls++;
      const request = JSON.parse(command.slice(command.indexOf("{")));
      expect(request.target.content).toBe(claim);
      expect(request.reasoningEffort).toBe("low");
      if (race) {
        content = "peer changed the prose";
        version = "2";
      }
      return JSON.stringify({
        report: { target: { name: "handoff.md", sha256: artifactFileHash(claim) } },
      });
    },
  };
  const request = {
    taskId: 1,
    path: "handoff.md",
    expected: { version, sha256: artifactFileHash(content) },
    refs: ["note:1"],
    mode: "fresh" as const,
    reasoningEffort: "low" as const,
  };
  expect((await reviewTaskProseFile(access, request)).file.version).toBe("1");
  race = true;
  await expect(reviewTaskProseFile(access, request)).rejects.toThrow("historical");
  await expect(reviewTaskProseFile(access, request)).rejects.toThrow("changed since");
  expect(calls).toBe(2);
});

test("fresh transport sends the whole actual prose with no inherited agent stack and preserves output allowance", async () => {
  const p = packet();
  p.target.content = "Unabridged paragraph. ".repeat(2000) + claim;
  let calls = 0;
  const reviewer = createProseReviewer(
    { MARINA_DEFAULT_MAX_TOKENS: "24000" },
    {
      token: async () => "local-test-token",
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(init!.body as string);
        expect(body.messages).toHaveLength(2);
        expect(body.max_tokens).toBe(24000);
        const format = body.response_format;
        expect(format.type).toBe("json_schema");
        expect(format.json_schema.strict).toBe(true);
        expect(format.json_schema.schema.required).toEqual(["findings", "limitations"]);
        const item = format.json_schema.schema.properties.findings.items;
        expect(item.additionalProperties).toBe(false);
        expect(item.properties.status.enum).toEqual(["contradicted", "unverified"]);
        expect(item.properties.citations.items.required).toEqual(["ref", "quote"]);

        expect(body.reasoning_effort).toBe(p.reasoningEffort);
        expect(JSON.parse(body.messages[1].content).target.content).toBe(p.target.content);
        expect(new Headers(init!.headers).get("x-marina-stack")).toBe("none");
        return Response.json({
          model: "served",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(finding()) } }],
        });
      },
    },
  );
  expect((await reviewer(p, "upstream")).model).toBe("served");
  expect(calls).toBe(1);
  p.reasoningEffort = "low";
  expect((await reviewer(p, "upstream")).model).toBe("served");
  expect(calls).toBe(2);
  for (const model of ["marina/verify:x", "marina:agent", "cheap", "strong"])
    await expect(reviewer(p, model)).rejects.toThrow("upstream model ID");
  expect(calls).toBe(2);
});

test("truncated, malformed and failed prose reviews do not silently retry or become assessments", async () => {
  for (const response of [
    Response.json({
      choices: [{ finish_reason: "length", message: { content: JSON.stringify(finding()) } }],
    }),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }),
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"findings":[{"reason":"an unescaped "claim""}],"limitations":[]}' },
        },
      ],
    }),
    new Response("unsupported response_format", { status: 400 }),
    // A 503 is transient: tried once more (metered as a call), then it still fails.
    new Response("failed", { status: 503 }),
  ]) {
    let calls = 0;
    const reviewer = createProseReviewer(
      { MARINA_MODEL_RETRY_BASE_MS: "0" },
      {
        token: async () => "local-test-token",
        fetch: async () => {
          calls++;
          return response.clone();
        },
      },
    );
    await expect(reviewer(packet(), "upstream")).rejects.toThrow();
    if (response.status === 503) {
      expect(calls).toBe(2);
      continue;
    }
    expect(calls).toBe(1);
  }
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
    const reviewer = createProseReviewer(
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

test("reasoning effort validates before inference and changes the source-bound fingerprint", () => {
  const make = (reasoningEffort: unknown) =>
    proseReviewPacket({
      taskId: 1,
      revision: 1,
      reader: "owner",
      requirements: "handoff",
      artifact: null,
      request: { ...input(), reasoningEffort } as Parameters<
        typeof proseReviewPacket
      >[0]["request"],
      resolve: (ref) => ({ ref, status: "current", text: original }),
    });
  expect(make("low").fingerprint).not.toBe(make("high").fingerprint);
  expect(make(undefined)).not.toHaveProperty("reasoningEffort");
  for (const effort of [null, "", "unbounded", 0, {}])
    expect(() => make(effort)).toThrow("reasoningEffort");
});

test("the fresh reviewer's HTTP leg retries a transient failure once, honours Retry-After, never a plain error", async () => {
  const ok = () =>
    Response.json({
      model: "served",
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ findings: [], limitations: [] }) },
        },
      ],
    });
  const closed = (queue: Array<Error | Response>) => {
    let calls = 0;
    return {
      calls: () => calls,
      reviewer: createProseReviewer(
        { MARINA_MODEL_RETRY_BASE_MS: "0" },
        {
          token: async () => "local-test-token",
          fetch: async () => {
            calls++;
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next ?? ok();
          },
        },
      ),
    };
  };
  const once = closed([new Error("The connection was closed."), ok()]);
  expect((await once.reviewer(packet(), "upstream")).model).toBe("served");
  expect(once.calls()).toBe(2);
  const throttled = closed([
    new Response("", { status: 429, headers: { "retry-after": "0" } }),
    ok(),
  ]);
  expect((await throttled.reviewer(packet(), "upstream")).model).toBe("served");
  expect(throttled.calls()).toBe(2);
  const twice = closed([
    new Error("The connection was closed."),
    new Error("The connection was closed."),
  ]);
  await expect(twice.reviewer(packet(), "upstream")).rejects.toThrow("connection was closed");
  expect(twice.calls()).toBe(2);
  const plain = closed([new Error("schema rejected")]);
  await expect(plain.reviewer(packet(), "upstream")).rejects.toThrow("schema rejected");
  expect(plain.calls()).toBe(1);
});
