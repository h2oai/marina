// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { memoryObserver } from "../src/net/memory-visibility";
import { MarinaDB } from "../src/persistence/database";
import type { ResourceChange } from "../src/persistence/db-resource-changes";
import { RoutingService } from "../src/routing/service";
import { codingDesk } from "../src/sdk/coding-desk";
import { parsePanelOperation } from "../src/sdk/panel-actions";
import { validatePanelDocument } from "../src/sdk/panel-document";
import { panelSourceAffected } from "../src/sdk/panel-events";
import { createTestEngine } from "./engine-fixture";

it("a desk is a valid publication with explicit coding authority and optional peers", () => {
  const solo = codingDesk({ sessionId: "solo" });
  expect(validatePanelDocument(solo).ok).toBe(true);
  expect(solo.components.filter((c) => c.component === "Resource").map((c) => c.reference)).toEqual(
    [
      { kind: "coding", id: "solo" },
      { kind: "feed", limit: 10 },
    ],
  );
  expect(parsePanelOperation(solo.components.find((c) => c.id === "ask")!.operation)).toMatchObject(
    {
      kind: "command",
      command: "code",
      codingTarget: { sessionId: "solo" },
    },
  );
  expect(() => codingDesk({ sessionId: "../foreign" })).toThrow();
  expect(
    parsePanelOperation({
      kind: "command",
      command: "say",
      syntax: "say <text>",
      codingTarget: { sessionId: "solo" },
    }),
  ).toBeNull();
  expect(
    validatePanelDocument(codingDesk({ sessionId: "solo", taskId: "42", participantId: "peer" }))
      .ok,
  ).toBe(true);
});

it("change hints coalesce after transactions, expose only committed reads and stop on close", async () => {
  const db = new MarinaDB(":memory:");
  const changes: ResourceChange[] = [];
  const visible: boolean[] = [];
  db.onResourceChange((change) => {
    changes.push(change);
    visible.push(!!db.getCodingSession("rolled-back"));
  });
  try {
    expect(() =>
      db.transaction(() => {
        db.createCodingSession({
          id: "rolled-back",
          title: "secret",
          workspaceRoot: "/tmp",
          createdBy: "Owner",
        });
        expect(changes).toHaveLength(0);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    await Promise.resolve();
    expect(changes).toEqual([{ resource: "coding", id: "rolled-back" }]);
    expect(visible).toEqual([false]);
    changes.length = 0;
    for (let i = 0; i < 1000; i++)
      db.createCodingSession({
        id: String(i),
        title: "fixture",
        workspaceRoot: "/tmp",
        createdBy: "Owner",
      });
    await Promise.resolve();
    expect(changes).toEqual([{ resource: "coding" }]);
    changes.length = 0;
    db.updateCodingSession("1", { title: "after-close" });
    db.close();
    await Promise.resolve();
    expect(changes).toEqual([]);
  } finally {
    db.close();
  }
});

it("participant change IDs follow current session visibility even for operator observers", async () => {
  const f = createTestEngine();
  try {
    const owner = f.login("Owner");
    const other = f.login("Other");
    const routing = new RoutingService(f.db, f.db.durableEntityKey(owner.entityId));
    const session = routing.join({ clientKey: "private", label: "Private", kind: "service" });
    const event = {
      type: "resource_changed" as const,
      resource: "participant" as const,
      id: session.id,
      timestamp: Date.now(),
    };
    expect(memoryObserver(f.engine, owner.entityId).event(event)).toBe(true);
    expect(memoryObserver(f.engine, other.entityId).event(event)).toBe(false);
    expect(memoryObserver(f.engine, "loopback-anon").event(event)).toBe(false);
    expect(panelSourceAffected({ kind: "participant", id: session.id }, event)).toBe(true);
    expect(panelSourceAffected({ kind: "participant", id: "unrelated" }, event)).toBe(false);
    expect(
      panelSourceAffected(
        { kind: "coding", id: "a" },
        { type: "resource_changed", resource: "coding", id: "b" },
      ),
    ).toBe(false);
  } finally {
    await f.dispose();
  }
});
