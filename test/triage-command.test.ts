// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { builtinSkill } from "../src/agent/builtin-skills";
import { loadSkillFile } from "../src/agent/skill-import";
import { runTriage, triageCommand } from "../src/engine/commands/triage";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { stripAnsi } from "./helpers";

const NOW = new Date("2026-10-05T00:00:00Z");

async function triage(args: string): Promise<string> {
  const sent: string[] = [];
  const entity = { id: "e_1", name: "resident" } as unknown as Entity;
  const cmd = triageCommand({ getEntity: () => entity, now: () => NOW });
  const ctx = { send: (_id: string, msg: string) => sent.push(msg) } as unknown as RoomContext;
  await cmd.handler(ctx, {
    entity: "e_1" as EntityId,
    verb: "triage",
    args,
    tokens: args.split(/\s+/),
    raw: `triage ${args}`,
  } as never);
  return stripAnsi(sent.join("\n"));
}

describe("triage command", () => {
  test("is a rank-0 read-only command", () => {
    const cmd = triageCommand({ getEntity: () => undefined });
    expect(cmd.name).toBe("triage");
    expect(cmd.minRank).toBe(0);
    expect(cmd.usage?.every((u) => typeof u !== "string" && u.effect === "read")).toBe(true);
  });

  test("a published statistic is a lookup at the world clock, an anchor at an earlier asof", async () => {
    const live = await triage("What was the US CPI-U inflation rate for August 2026? type:number");
    expect(live).toContain("class: lookup");
    expect(live).toContain("triage:readoff");
    expect(live).toContain("publisher BLS (bls.gov)");
    const past = await triage(
      "What was the US CPI-U inflation rate for August 2026? type:number asof:2026-09-01",
    );
    expect(past).toContain("class: anchor");
    expect(past).toContain("quant");
  });

  test("lists, events and open questions", async () => {
    expect(
      await triage(
        "Which five films will top the domestic box office for 18-20 October 2026? type:ranking size:5",
      ),
    ).toContain("class: list");
    expect(
      await triage("Will Arsenal beat Aston Villa on 31 August 2026? type:choice options:Yes,No"),
    ).toContain("class: lookup");
    expect(await triage("Will the treaty be signed?")).toContain("class: forecast");
    expect(await triage("Who wins? resolves:2026-10-01")).toContain("resolution");
  });

  test("bad input replies with the usage", async () => {
    expect(await triage("")).toContain("Usage:");
    expect(await triage("asof:nope What?")).toContain("asof: takes an ISO time");
    expect(await triage("Q? type:choice")).toContain("needs options");
    expect(() => runTriage("type:number", NOW)).toThrow("no question");
  });
});

describe("the intake-triage skill", () => {
  test("ships built in, exactly as its seed file", () => {
    const skill = builtinSkill("intake-triage")!;
    expect(skill).toEqual(loadSkillFile("seeds/skills/intake-triage.md"));
    expect(skill.description).toContain("lookup");
  });
});
