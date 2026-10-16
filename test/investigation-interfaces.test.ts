// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { parseInquiryArgs } from "../scripts/inquiry";
import { parseDispatch } from "../scripts/marina";
import * as serviceModule from "../src/investigations/service";
import { InvestigationService } from "../src/investigations/service";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaInvestigationClient } from "../src/sdk/investigation-client";
import {
  investigationAttemptText,
  investigationPlainText,
  investigationResultText,
} from "../src/sdk/investigation-text";
import type { InvestigationRequest } from "../src/sdk/investigation-types";
import { createTestEngine } from "./engine-fixture";
import { binaryInvestigation, investigationFixtures } from "./fixtures/investigations";
import { MockConnection } from "./helpers";

describe("investigation HTTP / SDK contract", () => {
  let world: ReturnType<typeof createTestEngine>;
  let service: InvestigationService;
  let restore: () => void;
  let calls = 0;
  const previousOpen = process.env.MARINA_OPEN_API;
  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    world = createTestEngine();
    calls = 0;
    service = new InvestigationService(world.db, async ({ observation }) => {
      calls++;
      const outputId = observation.capture("fixture", { private: "release details" });
      return {
        result: { ...structuredClone(binaryInvestigation), outputId },
        forecast: {
          question: "Will we ship?",
          kind: "probability",
          probability: 0.65,
          answerJson: "{}",
        },
      };
    });
    const replacement = spyOn(serviceModule, "investigationService").mockReturnValue(service);
    restore = () => replacement.mockRestore();
  });
  afterEach(async () => {
    restore();
    service.close();
    await world.dispose();
    if (previousOpen === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = previousOpen;
  });
  function client(name: string) {
    const connection = new MockConnection(crypto.randomUUID());
    world.engine.addConnection(connection);
    const login = world.engine.login(connection.id, name);
    if ("error" in login) throw new Error(login.error);
    return new MarinaInvestigationClient({
      url: "http://marina.test",
      token: login.token,
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const req = new Request(input, init);
          return (
            (await handleDashboardApi(req, new URL(req.url), req.method, world.engine, world.db)) ??
            new Response("Not found", { status: 404 })
          );
        },
        { preconnect() {} },
      ),
    });
  }
  const request: InvestigationRequest = { kind: "prediction", question: "Will we ship?" };

  it("admits once, replays without spending, checks every private read, and accepts delegated agent work", async () => {
    const owner = client("OwnerWire");
    const agent = client("AgentWire");
    const { attempt } = await owner.start(request, "stable-key");
    await service.wait(attempt.id);
    expect((await owner.start(request, "stable-key")).created).toBe(false);
    const snapshot = await owner.get(attempt.caseId);
    expect(snapshot.attempt.result?.estimate).toEqual(binaryInvestigation.estimate);
    expect((await owner.content(snapshot.attempt.result!.outputId!)).value).toEqual({
      private: "release details",
    });
    expect((await owner.events(attempt.id)).cursor).toBeGreaterThan(0);
    expect(calls).toBe(1);
    await expect(agent.get(attempt.caseId)).rejects.toMatchObject({ status: 404 });
    await expect(agent.content(snapshot.attempt.result!.outputId!)).rejects.toMatchObject({
      status: 404,
    });
    await expect(agent.events(attempt.id)).rejects.toMatchObject({ status: 404 });
    await owner.grant(attempt.caseId, "AgentWire", "read");
    expect((await agent.get(attempt.caseId)).case.access).toBe("read");
    await expect(
      agent.start({ ...request, caseId: attempt.caseId }, "no-write"),
    ).rejects.toMatchObject({ status: 403 });
    await owner.grant(attempt.caseId, "AgentWire", "work");
    const child = (await agent.start({ ...request, parentAttemptId: attempt.id }, "child")).attempt;
    await service.wait(child.id);
    expect((await owner.get(child.caseId)).attempt.actor.name).toBe("AgentWire");
    expect((await owner.get(attempt.caseId)).children[0]?.attemptId).toBe(child.id);
    await owner.grant(attempt.caseId, "AgentWire", null);
    await expect(agent.get(child.caseId)).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(2);
    expect(investigationAttemptText(snapshot.attempt)).toContain("65% chance");
  });

  it("settles through the existing scorer, keeps the outcome private, and erases controlled copies", async () => {
    const owner = client("ResolveWire");
    const other = client("OtherWire");
    const { attempt } = await owner.start(request, "settlement");
    await service.wait(attempt.id);
    await expect(other.resolve(attempt.id, { outcome: "yes" })).rejects.toMatchObject({
      status: 404,
    });
    await owner.review(attempt.id, "Check the outstanding integration risk.");
    expect((await owner.events(attempt.id)).events.at(-1)?.kind).toBe("review");
    const resolved = await owner.resolve(attempt.id, { outcome: "yes" });
    expect(resolved.loss).toBeCloseTo(0.1225);
    expect((await owner.get(attempt.caseId)).resolution?.loss).toBeCloseTo(0.1225);
    expect(world.db.listOutcomes()).toEqual([]);
    await expect(owner.resolve(attempt.id, { outcome: "no" })).rejects.toMatchObject({
      status: 409,
    });
    await owner.erase(attempt.caseId);
    await expect(owner.get(attempt.caseId)).rejects.toMatchObject({ status: 404 });
    await expect(owner.start(request, "settlement")).rejects.toMatchObject({ status: 410 });
  });

  it("requires a durable account even on a dev-open instance", async () => {
    process.env.MARINA_OPEN_API = "true";
    const req = new Request("http://marina.test/api/investigations");
    const response = await handleDashboardApi(req, new URL(req.url), "GET", world.engine, world.db);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls).toBe(0);
  });
});

it("shares faithful answer formatting and strips untrusted terminal instructions", () => {
  expect(investigationResultText(investigationFixtures.numeric!)).toContain(
    "uncertainty not supplied",
  );
  expect(investigationResultText(investigationFixtures.choice!)).toContain("40%");
  expect(investigationResultText(investigationFixtures.unavailable!)).toContain(
    "Probability unavailable",
  );
  expect(investigationResultText(investigationFixtures.research!, "report")).toContain(
    "Integration is unfinished",
  );
  expect(investigationPlainText("safe\x1b]52;c;clipboard-attack\x07\x1b[2J\u202eevil")).toBe(
    "safeevil",
  );
  expect(investigationPlainText("α\nsource\tdata")).toBe("α\nsource\tdata");
});

it("adds CLI namespaces without changing default coding or connect dispatch", () => {
  expect(parseDispatch([], () => false).kind).toBe("code");
  expect(parseDispatch(["connect", "builder"], () => false)).toEqual({
    kind: "connect",
    rest: ["builder"],
  });
  expect(parseDispatch(["predict", "Will we ship?"], () => false)).toEqual({
    kind: "inquiry",
    mode: "predict",
    rest: ["Will we ship?"],
  });
  expect(
    parseInquiryArgs("predict", ["--type", "number", "--unit", "days", "--json", "How long?"], {})
      .request.answer,
  ).toEqual({ type: "number", unit: "days" });
  expect(() => parseInquiryArgs("predict", ["--tui", "--json"], {})).toThrow("cannot be combined");
  expect(() => parseInquiryArgs("predict", ["--runs", "Infinity"], {})).toThrow("1–9");
});
