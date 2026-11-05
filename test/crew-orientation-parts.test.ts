// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A crew member's orientation states its own part and each crewmate's: in a
 * tabletop, the debate rules alone let the "attacker" drift into advising the
 * defenders.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";

describe("crew orientation names each member's part", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let crews: CrewManager;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    channels = new ChannelManager(db, () => {});
    crews = new CrewManager({ channels, db, resolveAgentId: (name) => `e_${name}` });
  });
  afterEach(() => {
    crews.stop();
    db.close();
  });

  it("states the joiner's own goal and each crewmate's", () => {
    db.saveAgentConfig({
      name: "Red_Actor",
      model: "m",
      spawnedBy: "jeff",
      goal: "Play a ransomware crew that already holds domain admin",
    });
    db.saveAgentConfig({
      name: "Blue_Lead",
      model: "m",
      spawnedBy: "jeff",
      goal: "Lead incident response for Acme",
    });
    const crew = crews.create({
      name: "ir",
      goal: "billing cluster encrypted",
      owner: entityId("e_jeff"),
      members: [{ agentName: "jeff", role: "owner" }, { agentName: "Blue_Lead" }],
      formation: "debate",
    });
    crews.dispatch(crew.id, "go");
    crews.addMember(crew.id, "Red_Actor");
    const text = channels
      .getHistory(crew.channelId!, 50)
      .map((m) => m.content)
      .join("\n");
    const brief = text.slice(text.indexOf("[orientation:Red_Actor]"));
    expect(brief).toContain(
      "your part (keep to it; the formation sets turns only): Play a ransomware crew that already holds domain admin",
    );
    expect(brief).toContain("Blue_Lead (specialist) — Lead incident response for Acme");
  });
});
