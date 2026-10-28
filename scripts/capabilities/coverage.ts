// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandCatalogEntry } from "../../src/sdk/capabilities";
import type { Site } from "./source";

export interface CoverageInventory {
  provenance: { commit: string; sources: Array<{ file: string; sha256: string }> };
  commands: CommandCatalogEntry[];
  ticks: { periodic: Array<{ name: string }>; everyTick: Site[] };
  environment: Array<{ name: string }>;
  features: Array<{ name: string }>;
  roomCommands: Array<Site & { name: string }>;
  roomCommandBindings: Site[];
  worldRooms: Array<{
    world: string;
    room: string;
    commands: Array<{ name: string }>;
    onTick?: string;
  }>;
  dynamicEnvironment: Site[];
  outcomes: {
    sites: Array<Site & { call: string }>;
    imports: Site[];
    sql: Site[];
    routing: unknown[];
    reachableCandidates: Array<{ id: string }>;
  };
}

export interface QualificationEvidence {
  id: string;
  status: "works" | "failed" | "observed" | "blocked" | "untested";
  detail: string;
  commands?: string[];
  capabilities?: string[];
}

/** Every inventory surface receives a row, even if the harness has no scenario for it. */
export function coverageMatrix(inventory: CoverageInventory, evidence: QualificationEvidence[]) {
  const rows: Array<{ id: string; status: QualificationEvidence["status"]; reason: string }> = [];
  const result = (id: string, relevant: QualificationEvidence[], fallback: string) => {
    // A failed optional branch remains a failure even if another value worked.
    const status: QualificationEvidence["status"] =
      (["failed", "works", "blocked", "observed"] as const).find((s) =>
        relevant.some((e) => e.status === s),
      ) ?? "untested";
    return {
      id,
      status,
      reason: relevant.length
        ? `${relevant.map((e) => e.id).join(", ")}. Only the concrete exercised arguments are covered; optional variants require additional cases.`
        : fallback,
    };
  };
  const missing = (id: string, reason: string) => rows.push({ id, status: "untested", reason });
  for (const c of inventory.commands) {
    if (!c.forms?.length)
      missing(`command:${c.name}`, "No declared usage forms or asserted scenario");
    for (const f of c.forms ?? [])
      rows.push(
        result(
          `command:${c.name}:${f.syntax}`,
          evidence.filter((e) => e.commands?.includes(f.syntax)),
          "No asserted end-to-end scenario for this usage form",
        ),
      );
    for (const alias of c.aliases ?? [])
      missing(`alias:${c.name}:${alias}`, "Alias not exercised explicitly");
  }
  for (const j of inventory.ticks.periodic)
    rows.push({
      id: `tick:${j.name}`,
      status:
        j.name === "schedules" && evidence.some((e) => e.id === "schedule" && e.status === "works")
          ? "works"
          : "untested",
      reason:
        "Requires eligible fixture and checked postcondition; elapsed ticks alone do not qualify",
    });
  for (const s of inventory.ticks.everyTick)
    missing(`tick-statement:${s.file}:${s.line}`, "Every-tick work needs an effect assertion");
  for (const e of inventory.environment)
    missing(`environment:${e.name}`, "No setting-specific behavior assertion");
  for (const e of inventory.dynamicEnvironment)
    missing(
      `dynamic-environment:${e.file}:${e.line}:${e.expression}`,
      "Computed environment read requires name resolution and behavior assertion",
    );
  for (const f of inventory.features)
    missing(
      `feature:${f.name}`,
      "Feature status is a claim; component checks do not qualify the full feature",
    );
  for (const c of inventory.roomCommands)
    missing(`room-source:${c.file}:${c.line}:${c.name}`, "No room-specific scenario");
  for (const c of inventory.roomCommandBindings)
    missing(
      `room-binding:${c.file}:${c.line}`,
      "Source binding requires runtime mapping and a scenario",
    );
  for (const room of inventory.worldRooms) {
    for (const command of room.commands)
      rows.push({
        id: `room:${room.world}:${room.room}:${command.name}`,
        status: "blocked",
        reason: "Absent from the empty world; needs an explicit room installation fixture",
      });
    if (room.onTick)
      missing(`room-tick:${room.world}:${room.room}`, "Room onTick requires eligible room data");
  }
  for (const s of inventory.outcomes.sites)
    missing(
      `outcome:${s.file}:${s.line}:${s.call}`,
      "Requires producer/consumer-specific durable assertions",
    );
  for (const category of ["imports", "sql"] as const)
    for (const s of inventory.outcomes[category])
      missing(
        `outcome-${category}:${s.file}:${s.line}`,
        "Needs runtime producer/consumer coverage",
      );
  for (const [i] of inventory.outcomes.routing.entries())
    missing(`outcome-routing:${i}`, "Routing registry result is not end-to-end delivery evidence");
  for (const candidate of inventory.outcomes.reachableCandidates)
    missing(`outcome-candidate:${candidate.id}`, "Static reachability is not runtime evidence");
  return rows.map((row) => {
    const direct = evidence.filter((e) => e.capabilities?.includes(row.id));
    return direct.length ? result(row.id, direct, row.reason) : row;
  });
}

export function fullyQualified(
  coverage: ReturnType<typeof coverageMatrix>,
  evidence: QualificationEvidence[],
) {
  return (
    coverage.length > 0 &&
    coverage.every((row) => row.status === "works") &&
    !evidence.some((e) => e.status === "failed" || e.status === "blocked")
  );
}
