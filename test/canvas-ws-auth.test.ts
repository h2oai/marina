// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  authorizeCanvasSubscription,
  CanvasBroadcaster,
  type CanvasScopeLookup,
} from "../src/net/canvas-ws";

function lookup(
  canvases: Record<string, { scope: string; scope_id: string | null }>,
): CanvasScopeLookup {
  return { getCanvas: (id) => canvases[id] };
}

const fakeWs = () => ({ readyState: 1, send() {} }) as never;

describe("canvas-ws subscription authorization", () => {
  const db = lookup({
    world: { scope: "global", scope_id: null },
    "alice-private": { scope: "entity", scope_id: "e_alice" },
  });

  it("allows anyone to subscribe to a public/shared canvas", () => {
    expect(authorizeCanvasSubscription(db, "world", undefined)).toBe(true);
    expect(authorizeCanvasSubscription(db, "world", { entityId: "e_bob" })).toBe(true);
  });

  it("allows the owner to subscribe to their private canvas", () => {
    expect(authorizeCanvasSubscription(db, "alice-private", { entityId: "e_alice" })).toBe(true);
  });

  it("denies a non-owner from subscribing to a private canvas", () => {
    expect(authorizeCanvasSubscription(db, "alice-private", { entityId: "e_bob" })).toBe(false);
    expect(authorizeCanvasSubscription(db, "alice-private", undefined)).toBe(false);
  });

  it("allows a trusted operator onto any private canvas", () => {
    expect(
      authorizeCanvasSubscription(db, "alice-private", { entityId: "op", isOperator: true }),
    ).toBe(true);
  });

  it("allows an unknown canvas id (nothing to leak)", () => {
    expect(authorizeCanvasSubscription(db, "does-not-exist", { entityId: "e_bob" })).toBe(true);
  });

  it("addClient enforces authorization and reports the outcome", () => {
    const b = new CanvasBroadcaster();

    const denied = b.addClient(fakeWs(), "alice-private", { db, principal: { entityId: "e_bob" } });
    expect(denied).toBe(false);
    expect(b.clientCount("alice-private")).toBe(0);

    const owner = b.addClient(fakeWs(), "alice-private", {
      db,
      principal: { entityId: "e_alice" },
    });
    expect(owner).toBe(true);
    expect(b.clientCount("alice-private")).toBe(1);

    const publicOk = b.addClient(fakeWs(), "world", { db, principal: { entityId: "e_bob" } });
    expect(publicOk).toBe(true);
    expect(b.clientCount("world")).toBe(1);
  });

  it("addClient stays permissive for internal callers that pass no auth", () => {
    const b = new CanvasBroadcaster();
    expect(b.addClient(fakeWs(), "alice-private")).toBe(true);
    expect(b.clientCount("alice-private")).toBe(1);
  });
});
