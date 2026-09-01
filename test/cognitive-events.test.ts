// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { projectEngineEvent } from "../src/engine/cognitive-provenance";
import { type CognitiveEventRow, MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = `/tmp/marina-cognitive-events-${process.pid}.db`;
const previousKey = process.env.MARINA_FEDERATION_SIGNING_KEY;

afterEach(() => {
  if (previousKey === undefined) delete process.env.MARINA_FEDERATION_SIGNING_KEY;
  else process.env.MARINA_FEDERATION_SIGNING_KEY = previousKey;
  cleanupDb(TEST_DB);
});

describe("cognitive provenance ledger", () => {
  it("projects the complete cognitive vocabulary from canonical engine events", () => {
    const at = 1000;
    const projected = [
      ...projectEngineEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "look",
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "recall evidence",
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "reflect now",
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "command",
        entity: entityId("e_1"),
        input: "note finding",
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "agent_turn_end",
        name: "Ada",
        hadToolCalls: true,
        toolCount: 1,
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "agent_tool_call",
        name: "Ada",
        toolName: "marina_recall",
        timestamp: at,
      }),
      ...projectEngineEvent({
        type: "agent_tool_result",
        name: "Ada",
        toolName: "marina_recall",
        isError: false,
        timestamp: at,
      }),
    ];
    expect(new Set(projected.map((event) => event.kind))).toEqual(
      new Set([
        "input",
        "memory_influence",
        "reflection",
        "creation",
        "action",
        "output",
        "tool_intention",
        "consequence",
      ]),
    );
  });

  it("records the exact memory references that influenced recall", () => {
    const [event] = projectEngineEvent({
      type: "recall_trace",
      entity: entityId("e_1"),
      query: "prior evidence",
      seedNoteIds: [4, 9],
      activatedNoteIds: [4, 9, 12],
      timestamp: 1000,
    });
    expect(event).toMatchObject({
      kind: "memory_influence",
      payload: { seedNoteIds: [4, 9], activatedNoteIds: [4, 9, 12] },
    });
  });

  it("appends a deterministic hash chain without requiring signing", () => {
    delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    const db = new MarinaDB(TEST_DB);
    const first = db.appendCognitiveEvent({
      kind: "input",
      actorId: "human:alice",
      payload: { desire: "Understand the evidence" },
      createdAt: 1000,
    });
    const second = db.appendCognitiveEvent({
      kind: "output",
      actorId: "model:one",
      parentIds: [first.id],
      payload: { result: "A partial synthesis" },
      createdAt: 1001,
    });

    expect(second.previous_hash).toBe(first.event_hash);
    expect(db.verifyCognitiveEvent(first)).toEqual({
      valid: true,
      hashValid: true,
      signatureValid: null,
    });
    expect(db.listCognitiveEvents().map((event) => event.sequence)).toEqual([2, 1]);
    db.close();
  });

  it("signs events when a sovereign Marina configures its Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const db = new MarinaDB(TEST_DB);
    const event = db.appendCognitiveEvent({
      kind: "reflection",
      actorId: "intellect:critic",
      payload: { claim: "The premise remains uncertain" },
    });

    expect(event.signature_json).not.toBeNull();
    expect(db.verifyCognitiveEvent(event)).toMatchObject({
      valid: true,
      hashValid: true,
      signatureValid: true,
    });
    db.close();
  });

  it("detects payload mutation", () => {
    delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    const db = new MarinaDB(TEST_DB);
    const event = db.appendCognitiveEvent({
      kind: "action",
      actorId: "intellect:builder",
      payload: { tool: "search", query: "original" },
    });
    const altered: CognitiveEventRow = {
      ...event,
      payload_json: JSON.stringify({ tool: "search", query: "altered" }),
    };
    expect(db.verifyCognitiveEvent(altered).hashValid).toBe(false);
    db.close();
  });
});
