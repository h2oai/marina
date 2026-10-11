// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOutcome, terminalCodeLifecycle } from "../scripts/code";
import { parseDeliveryManifest, requirementCoverage } from "../src/coding/delivery";
import { beginCodingRun, codingRunMetadata, REQUIREMENT_REFUSALS } from "../src/coding/task-run";
import { VerificationRunner } from "../src/coding/verification-runner";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import type { CodingArtifactRow } from "../src/persistence/database";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

let f: ReturnType<typeof createTestEngine>;
let root: string;
let owner: ReturnType<typeof f.login>;
let run: CodingArtifactRow;
let state: DisposableStack;
const files = ["report.ts", "report.test.ts", "order.test.ts"];
const checks = ["bun test report.test.ts", "bun test order.test.ts"];
function manifest(requirements?: unknown) {
  writeFileSync(
    join(root, "delivery.json"),
    JSON.stringify({ files, checks, ...(requirements ? { requirements } : {}) }),
  );
}
const current = () => f.db.getCodingArtifact(run.id)!;
const meta = () => codingRunMetadata(current());
const send = async (command: string) => {
  await f.engine.dispatchCommand(owner.entityId, command, {
    codingTarget: { sessionId: "delivery", runId: run.id },
  });
  await f.engine.drainCommands();
};
const verify = () => send("code verify delivery manifest:delivery.json");
const claim = () => f.db.getTaskClaim(meta().taskId, owner.entityId)!;
const lifecycle = () =>
  f.db
    .listCodingEvents("delivery")
    .filter((event) => event.kind === "code_lifecycle")
    .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
    .findLast((payload) => payload.terminal === true);

/** What the headless CLI decides from the terminal lifecycle payload. */
const outcome = () =>
  printOutcome(
    terminalCodeLifecycle({
      kind: "message",
      data: {
        code: {
          event: "code_lifecycle",
          sessionId: "delivery",
          phase: "completed",
          metadata: lifecycle(),
        },
      },
      timestamp: Date.now(),
    } as Perception),
  );

function begin(verificationRequirement: "delivery" | "checks" = "delivery") {
  const actor = f.engine.entities.get(owner.entityId)!;
  run = beginCodingRun(f.db, {
    session: f.db.getCodingSession("delivery")!,
    owner: actor,
    worker: actor,
    prompt: "Deliver a report with amount 11 that lists items in order",
    profile: "marina",
    verificationRequirement,
  });
}

beforeEach(() => {
  state = scopeProcessState({
    trustProfile: "shared",
    rateLimitBypass: true,
    env: { MARINA_AUTONOMY: "guarded", MARINA_CHALLENGES: "off" },
  });
  root = mkdtempSync(join(tmpdir(), "marina-delivery-requirements-"));
  writeFileSync(
    join(root, "report.ts"),
    "export const amount = 11; export const items = ['a', 'b'];",
  );
  writeFileSync(
    join(root, "report.test.ts"),
    'import {expect,test} from "bun:test"; import {amount} from "./report"; test("amount",()=>expect(amount).toBe(11));',
  );
  writeFileSync(
    join(root, "order.test.ts"),
    'import {expect,test} from "bun:test"; import {items} from "./report"; test("order",()=>expect(items).toEqual(["a","b"]));',
  );
  f = createTestEngine();
  owner = f.login("Owner");
  const actor = f.engine.entities.get(owner.entityId)!;
  grant(f.db, owner.entityId, "code.exec");
  f.db.createCodingSession({
    id: "delivery",
    title: "Delivery",
    workspaceRoot: root,
    createdBy: actor.name,
  });
  f.db.updateCodingSession("delivery", { agent: actor.name, writer: actor.name });
  f.engine.commands.registerBuiltin(
    codeCommand({
      db: f.db,
      workspaceRegistry: new WorkspaceRegistry({ roots: [root] }),
      verificationRunner: new VerificationRunner(f.db, (pending) =>
        f.engine.trackBackgroundCommand(pending),
      ),
      getEntity: (id) => f.engine.entities.get(id as EntityId),
      getConnectionProtocol: () => "websocket",
    }),
  );
});
afterEach(async () => {
  await f.dispose();
  rmSync(root, { recursive: true, force: true });
  state.dispose();
});

it("refuses once a delivery whose stated requirement no passing check observes, then accepts the observed one", async () => {
  begin();
  manifest([
    { text: "the report's amount is 11", checks: [0] },
    { text: "items are listed in order" },
  ]);
  await verify();
  await send("code summary Report delivered; items are listed in order");
  expect(current().status).toBe("active");
  expect(meta().verification).toBe("passed");
  expect(meta().requirementRefusals).toBe(1);
  expect(meta().requirements).toMatchObject({
    listed: true,
    verified: ["the report's amount is 11"],
    unverified: ["items are listed in order"],
  });
  const text = owner.connection.allTextJoined();
  expect(text).toContain("no passing check that observes them");
  expect(text).toContain("1. items are listed in order");

  manifest([
    { text: "the report's amount is 11", checks: [0] },
    { text: "items are listed in order", checks: ["bun test order.test.ts"] },
  ]);
  await verify();
  await send("code summary Report delivered with observed order");
  expect(current().status, owner.connection.allTextJoined()).toBe("submitted");
  expect(meta().requirements?.unverified).toEqual([]);
  expect(meta().requirements?.verified).toHaveLength(2);
  expect(claim().submission_text).toContain("- verified: items are listed in order");
  expect(outcome().status).toBe("verified");
});

it("submits at once when every stated requirement is observed by a passing check", async () => {
  begin();
  manifest([
    { text: "the report's amount is 11", checks: [0] },
    { text: "items are listed in order", checks: [1] },
  ]);
  await verify();
  await send("code summary Done");
  expect(current().status).toBe("submitted");
  expect(meta().requirementRefusals).toBeUndefined();
});

it("never counts a check from before the delivered files or the checklist changed", async () => {
  begin();
  manifest([{ text: "the report's amount is 11", checks: [0] }]);
  await verify();
  // Mapping a requirement after the checks ran changes the hashed manifest.
  manifest([
    { text: "the report's amount is 11", checks: [0] },
    { text: "items are listed in order", checks: [1] },
  ]);
  await send("code summary Done");
  expect(current().status).toBe("active");
  expect(meta().verification).toBe("stale");
  expect(meta().requirements).toBeUndefined();
  await verify();
  writeFileSync(join(root, "report.ts"), "export const amount = 11; export const items = ['b'];");
  await send("code summary Done");
  expect(current().status).toBe("active");
  expect(meta().verification).toBe("stale");
});

it("records a requirement marked not machine-checkable and proceeds, visibly", async () => {
  begin();
  manifest([
    { text: "the report's amount is 11", checks: [0] },
    { text: "the wording reads naturally", notCheckable: "a matter of judgement, not a property" },
  ]);
  await verify();
  await send("code summary Done");
  expect(current().status).toBe("submitted");
  expect(meta().requirements?.notCheckable).toEqual([
    { text: "the wording reads naturally", reason: "a matter of judgement, not a property" },
  ]);
  expect(claim().submission_text).toContain("not machine-checkable: the wording reads naturally");
});

it("bounds the refusal: a second submission proceeds and reports what is still unverified", async () => {
  begin();
  manifest();
  await verify();
  await send("code summary Done");
  expect(current().status).toBe("active");
  expect(owner.connection.allTextJoined()).toContain("no acceptance checklist");
  for (let i = 0; i < REQUIREMENT_REFUSALS; i++) await send("code summary Done again");
  expect(current().status).toBe("submitted");
  expect(claim().submission_text).toContain("UNVERIFIED: no acceptance checklist");
  const result = outcome();
  expect(result.status).toBe("unverified");
  expect(result.exitCode).toBe(3);
  expect(result.notice).toContain("no acceptance checklist was recorded");
});

it("leaves other verification modes unchanged", async () => {
  begin("checks");
  await send("code recipe save default bun test report.test.ts");
  await send("code verify");
  await send("code summary Done");
  expect(current().status).toBe("submitted");
  expect(meta().requirements).toBeUndefined();
  expect(meta().requirementRefusals).toBeUndefined();
});

it("validates the checklist and counts only passing, non-whitespace checks", () => {
  expect(() =>
    parseDeliveryManifest({
      files: ["a"],
      checks: ["bun test"],
      requirements: [{ text: "x", checks: [3] }],
    }),
  ).toThrow("not in the manifest");
  expect(() =>
    parseDeliveryManifest({
      files: ["a"],
      checks: ["bun test"],
      requirements: [{ text: "x", checks: [0], notCheckable: "why" }],
    }),
  ).toThrow("not both");
  const manifest = parseDeliveryManifest({
    files: ["a"],
    checks: ["git diff --check", "bun test"],
    requirements: [
      { text: "clean", checks: [0] },
      { text: "works", checks: ["bun test"] },
    ],
  });
  expect(
    requirementCoverage(manifest, [
      { command: ["git", "diff", "--check"], outcome: "passed" },
      { command: ["bun", "test"], outcome: "failed" },
    ]),
  ).toMatchObject({ verified: [], unverified: ["clean", "works"] });
});
