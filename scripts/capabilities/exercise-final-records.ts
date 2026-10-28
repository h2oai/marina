// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";
import { receipt } from "./exercise-memory-advanced";

export async function exerciseFinalRecords(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  for (const policy of ["left", "right", "both", "neither"]) {
    const pool = `qa-conflict-${policy}`;
    await ctx.command("owner", `pool create ${pool}`);
    await ctx.command("owner", `pool ${pool} add The ${policy} relay is online`);
    await ctx.command("owner", `pool ${pool} add The ${policy} relay is not online`);
    await ctx.command("owner", "note conflicts");
    const row = ctx.db
      .query(
        "SELECT id FROM contradiction_cases WHERE status='open' AND scope_id=(SELECT id FROM memory_pools WHERE name=?) ORDER BY id DESC LIMIT 1",
      )
      .get(pool) as { id: number } | null;
    assert(row, `The ${pool} fixture creates a real contradiction case`);
    await check(
      `note resolve ${row.id} ${policy} This controlled fixture records contradictory observations; the selected policy is an explicit human audit decision.`,
      /resolved as/,
      [`note resolve <case-id> ${policy} `],
      `SELECT id FROM contradiction_cases WHERE id=${row.id} AND status='resolved'`,
    );
  }
  const ids: string[] = [];
  for (const text of [
    "qa-consolidate original evidence",
    "qa-consolidate duplicate account of original evidence",
  ]) {
    const out = await ctx.command("owner", `note ${text}`);
    const id = out.match(/#(\d+)/)?.[1];
    assert(id, out);
    ids.push(id);
  }
  await check(`note consolidate ${ids.join(" ")}`, /1 memory record\(s\).*superseded/, [
    "note consolidate ",
  ]);
  const pageOut = await ctx.command("owner", 'memory api {"operation":"export_page"}');
  const page = receipt(pageOut) as unknown as { header: unknown };
  assert(page.header);
  const fresh = await ctx.freshParticipant("QaTransfer");
  const transfer = receipt(
    await fresh(
      `memory api ${JSON.stringify({ operation: "transfer_begin", input: page.header })}`,
    ),
  );
  await ctx.scenario("memory-transfer-inspect-abort", async () => {
    const status = await fresh(`memory transfer ${transfer.id}`);
    assert.match(status, /receiving/);
    const aborted = await fresh(`memory transfer-abort ${transfer.id}`);
    assert.match(aborted, /aborted/);
    return JSON.stringify({
      status,
      aborted,
      scope:
        "A real staged import into a separate empty principal space was inspected and aborted. Full import commit has separate evidence.",
    });
  }, ["memory transfer <ID>", "memory transfer-abort <ID>"]);
  const genome = value("SELECT hash FROM marina_genomes LIMIT 1");
  await check(
    `marina-descend create ${genome} | qa-descendant-world | | direct-fork | Independent empty descendant fixture`,
    /Declared child world/,
    ["marina-descend create "],
  );
  await check("marina-descend list", /qa-descendant-world/, ["marina-descend list"]);
  const descendant = value("SELECT id FROM marina_descendants WHERE name='qa-descendant-world'");
  await check(`marina-descend start ${descendant}`, /running|started/i, ["marina-descend start "]);
  await check(`marina-descend stop ${descendant}`, /stopped|stop/i, ["marina-descend stop "]);
  // The operator installs a role-bearing room via the real compiler/loader. No
  // authority rows or chronicle entries are inserted directly into the database.
  await ctx.command("operator", "build room qa/chronicler Chronicler fixture");
  await ctx.command(
    "operator",
    'build code qa/chronicler export default {short:"Chronicler fixture",long:"Explicit role fixture",exits:{},onEnter(ctx,entity){ctx.getEntity(entity).properties.role="chronicler";}}',
  );
  await ctx.command("operator", "build reload qa/chronicler");
  await ctx.command("owner", "goto qa/chronicler");
  await check(
    "chronicle record Qualification evidence | The controlled arithmetic task was checked. refs task:1 participants CleanOwner,CleanWorker",
    /record|Recorded|chronicle/i,
    ["chronicle record "],
  );
  const chronicle = value(
    "SELECT id FROM chronicle WHERE title='Qualification evidence' ORDER BY id DESC LIMIT 1",
  );
  await check(`chronicle show ${chronicle}`, /controlled arithmetic/, ["chronicle show "]);
  await check(
    `chronicle correct ${chronicle} Scope correction | This fixture does not prove general productivity. refs task:1 participants CleanOwner`,
    /correct|Correct|record/i,
    ["chronicle correct "],
  );
  for (const period of ["day", "week"])
    await check(
      `chronicle digest ${period} Qualification ${period} | Fresh-world evidence retained. refs task:1`,
      /digest|Digest|record/i,
      [`chronicle digest ${period} `],
    );
  await ctx.command("owner", "goto void/center");
  const event = value(
    "SELECT id FROM mesh_events WHERE mesh_id='mesh:qa' AND kind='result' LIMIT 1",
  );
  const exported = await ctx.command("owner", `mesh export mesh:qa ${event}`);
  const token = exported.split(/\s+/).find((part) => /^eyJ[A-Za-z0-9_-]+$/.test(part));
  assert(token, exported);
  await check(`mesh replicate mesh:qa ${token}`, /replicat|exist|duplicate|accepted/i, [
    "mesh replicate ",
  ]);
}
