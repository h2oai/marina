import { describe, expect, it } from "vitest";
import { entityOrigin, ORIGIN_META } from "../lib/entity-origin";

const agentStatus = { state: "autonomous" } as const;

describe("entityOrigin", () => {
  it("classifies a human as a player", () => {
    expect(entityOrigin({ kind: "human" })).toBe("player");
  });

  it("classifies npc/object world fixtures as system", () => {
    expect(entityOrigin({ kind: "npc" })).toBe("system");
    expect(entityOrigin({ kind: "object" })).toBe("system");
  });

  it("classifies a seeded agent (spawnedBy system) as system", () => {
    expect(entityOrigin({ kind: "agent", agentStatus, spawnedBy: "system" })).toBe("system");
    // missing spawnedBy on a runtime agent also reads as system (the legacy default)
    expect(entityOrigin({ kind: "agent", agentStatus })).toBe("system");
  });

  it("classifies an operator/dashboard launch as manual", () => {
    expect(entityOrigin({ kind: "agent", agentStatus, spawnedBy: "operator" })).toBe("manual");
  });

  it("classifies an agent spawned by another agent as crew", () => {
    expect(entityOrigin({ kind: "agent", agentStatus, spawnedBy: "Coordinator" })).toBe("crew");
  });

  it("classifies an agent with no runtime status as joined (external connection)", () => {
    expect(entityOrigin({ kind: "agent", spawnedBy: "operator" })).toBe("joined");
  });

  it("every origin has display metadata with a stable sort rank", () => {
    const origins = ["manual", "crew", "system", "player", "joined"] as const;
    const ranks = origins.map((o) => ORIGIN_META[o].rank);
    expect(new Set(ranks).size).toBe(origins.length); // unique
    expect([...ranks].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});
