// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { briefCommand } from "../src/engine/commands/brief";
import type { CommandInput, Entity, EntityId, RoomContext, RoomId } from "../src/types";
import { stripAnsi } from "./helpers";

const NO_PROVIDER_LINE = 'No model provider configured — run "readiness" to see what to set.';

function firstLoginEntity(): Entity {
  return {
    id: "e_1" as EntityId,
    name: "Newcomer",
    room: "test/start" as RoomId,
    properties: { _isFirstLogin: true },
  } as unknown as Entity;
}

function runBootstrap(hasLlmKeys: boolean | undefined): string {
  const entity = firstLoginEntity();
  const sent: string[] = [];
  const ctx = {
    entities: [entity],
    send: (_id: EntityId, text: string) => {
      sent.push(text);
    },
  } as unknown as RoomContext;
  const cmd = briefCommand({
    getEntity: () => entity,
    getOnlineAgents: () => [],
    ...(hasLlmKeys === undefined ? {} : { hasLlmKeys }),
  });
  const input: CommandInput = {
    raw: "brief",
    verb: "brief",
    args: "",
    tokens: [],
    entity: entity.id,
    room: entity.room,
  };
  cmd.handler(ctx, input);
  return stripAnsi(sent.join("\n"));
}

describe("brief first-login bootstrap", () => {
  it("tells a newcomer when no model provider is configured and points at readiness", () => {
    const text = runBootstrap(false);
    expect(text).toContain("Welcome to Marina");
    expect(text).toContain(NO_PROVIDER_LINE);
  });

  it("stays silent about providers when one is configured or unknown", () => {
    expect(runBootstrap(true)).not.toContain("No model provider");
    expect(runBootstrap(undefined)).not.toContain("No model provider");
  });
});
