// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseUtilities(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check("calc 19*23", /437/, ["calc "]);
  await check("quant fit 1 2 3 4 5 steps:1 method:trend", /mean.*6/, ["quant fit "]);
  await check("quant buckets mean:0 sd:1 -- <0, >=0", /50\.0%/, [
    "quant buckets mean:<m> sd:<s> --",
  ]);
  await check("quant buckets mean:0 sd:1 cuts:0", /50\.0%/, [
    "quant buckets mean:<m> sd:<s> cuts:",
  ]);
  await check("quant buckets q:0.1=-1,0.5=0,0.9=1 -- <0, >=0", /50\.0%/, ["quant buckets q:"]);
  await check("arbiter contested type:choice -- red | blue", /contested.*\n.*agreement/, [
    "arbiter contested ",
  ]);
  await check(
    'arbiter check type:choice majority:red agreement:1 -- {"verdict":"overrule","answer":"blue","confidence":0.9,"source_quality":0.9,"reasoning_quality":0.9,"items":[],"reason":"unsupported"}',
    /after the bar: (keep|abstain)/,
    ["arbiter check "],
  );
  await check("arbiter policy", /independent domain/, ["arbiter policy"]);
  await check("bookmark", /Bookmarked/, ["bookmark"]);
  await check("bookmark note 1 qa-bookmark-812", /annotated/, ["bookmark note "]);
  await check("bookmark list", /qa-bookmark-812/, ["bookmark list"]);
  await check("bookmark delete 1", /removed/, ["bookmark delete "]);
  await check(
    "batch memory kv set qa-batch 631; memory kv get qa-batch",
    /631/,
    ["batch "],
    "SELECT 1 FROM core_memory WHERE key='qa-batch' AND value='631'",
  );
  await check("schedule add qa-daily daily:23:59 max-runs:1 -- look", /qa-daily/, [
    "schedule add <name> daily:",
  ]);
  await check(
    `schedule add qa-before before:${new Date(Date.now() + 3600000).toISOString()} lead:10m -- look`,
    /qa-before/,
    ["schedule add <name> before:"],
  );
  await check("schedule delete qa-daily", /delet|removed/i, ["schedule delete "]);
  await check("schedule delete qa-before", /delet|removed/i, ["schedule delete "]);
  for (const [input, expected, selector] of [
    ["help", /Commands|Marina|Help/, "help"],
    ["help Memory", /note|memory/, "help <category>"],
    ["help note full", /note (link|search|claim)/, "help <command> "],
    ["help all", /calc|memory/, "help all"],
    ["help catalog", /calc|memory/, "help catalog"],
    ["help catalog memory", /memory/, "help catalog <command>"],
    ["help catalog json", /"commands"|"name"/, "help catalog json"],
    ["readiness", /readiness|capabilit|provider/i, "readiness"],
    ["readiness providers", /provider|model|route/i, "readiness providers "],
    ["inventory", /carrying|inventory|empty/i, "inventory"],
    ["look log since:1h limit:5", /qa-|Clean|log|recent|events/i, "look log "],
    ["note room", /qa-|room|notes/i, "note room"],
    ["note types", /fact|skill/, "note types"],
    ["note contradictions", /contradict|conflict|none|No /i, "note contradictions"],
    ["search qa-evidence", /qa-evidence/, "search "],
    ["guide", /guide|topic/i, "guide"],
    ["guide list", /guide|topic/i, "guide list"],
    ["guide memory", /memory|Memory/, "guide <topic>"],
    ["guide recall memory", /memory|Memory|No /, "guide recall "],
    ["guide audit", /guide|audit|knowledge/i, "guide audit"],
    ["usecase list", /recipe|usecase|coding/i, "usecase list"],
    ["usecase info research", /research|Research/, "usecase info "],
    ["usecase research evidence", /research|evidence/i, "usecase <recipe> "],
    ["usecase I want to verify a coding change", /code|task|coding/i, "usecase <natural language>"],
    ["pattern list", /delphi|verification|pipeline/, "pattern list"],
    ["forecast list", /forecast|No /i, "forecast list"],
    ["forecast competence", /competence|evidence|No /i, "forecast competence "],
    ["forecast routes", /route|evidence|No /i, "forecast routes "],
    ["learned", /learned|artifact|learning/i, "learned"],
    ["learned artifacts", /artifact|No /i, "learned artifacts"],
    ["learned items", /items|No /i, "learned items "],
    ["learned seeds", /seed|No /i, "learned seeds"],
    ["learned priors", /prior|No /i, "learned priors "],
    ["learned events", /event|No /i, "learned events "],
    ["lessons qa-evidence", /lesson|No /i, "lessons <topic>"],
    ["lessons qa-evidence domain:code", /lesson|No /i, "lessons <topic> domain:"],
    ["lessons qa-evidence for:code", /lesson|No /i, "lessons <topic> for:"],
    ["novelty", /novel|experiment|No /i, "novelty"],
    ["novelty stats", /Exploration Statistics/, "novelty stats"],
    ["novelty experiments", /novel|experiment|No /i, "novelty experiments "],
    ["provenance", /provenance|chain|event/i, "provenance"],
    ["provenance list", /provenance|chain|event|No /i, "provenance list "],
    ["provenance status", /provenance|chain|event/i, "provenance status"],
    ["provenance verify 10", /verif|valid|chain|No /i, "provenance verify "],
    ["ops inbox", /alert|inbox|No /i, "ops inbox"],
    ["ops history", /alert|history|No /i, "ops history"],
    ["ops assistance", /assistance|jobs|No /i, "ops assistance"],
    ["ops assistance expire", /expired|jobs|No /i, "ops assistance expire"],
    ["ops recover", /recover|pending|No /i, "ops recover"],
    ["quest list", /objective|quest|No /i, "quest list"],
    ["quest status", /objective|quest|No /i, "quest status"],
    ["challenge", /challenge|No /i, "challenge"],
    ["challenge stats", /approval|challenge|No /i, "challenge stats"],
    ["challenge summary", /approval|challenge|No /i, "challenge summary "],
    ["decision list", /decision|pending|No /i, "decision list"],
    ["decision receipts", /receipt|No /i, "decision receipts"],
    ["decision agreement", /agreement|No /i, "decision agreement"],
    ["decision settings", /model|gate|setting/i, "decision settings "],
    ["recruit available", /available|No |Recruitable agents/i, "recruit available "],
    ["recruit match verify arithmetic", /match|No |candidate|Recruitment fit/i, "recruit match "],
    ["link", /link|adapter|telegram|discord/i, "link"],
    ["link status", /link|adapter|telegram|discord/i, "link status"],
    ["source connector discord", /discord|connector|source/i, "source connector "],
    ["evolve", /evol|skill|recipe|learn/i, "evolve"],
    ["evolve loop", /loop|outcome|learn/i, "evolve loop"],
    ["evolve adoption worker", /adopt|No /i, "evolve adoption "],
    ["reflect jobs", /job|No /i, "reflect jobs"],
    ["recap chronicle", /chronicle|narrative|No /i, "recap chronicle"],
    ["recap chronicle day", /chronicle|narrative|No /i, "recap chronicle day"],
    ["recap chronicle week", /chronicle|narrative|No /i, "recap chronicle week"],
  ] as Array<[string, RegExp, string]>)
    await check(
      input,
      expected,
      [selector],
      undefined,
      input === "ops assistance expire" ? "operator" : "owner",
    );
  await check(
    "skill store qa-read | Verify fixture evidence | recall qa-evidence",
    /stored/,
    ["skill store "],
    "SELECT id FROM numeric_notes WHERE note_type='skill' AND content LIKE '[Skill: qa-read]%'",
  );
  await check("skill store qa-check | Check exact arithmetic | calc 19*23", /stored/, [
    "skill store ",
  ]);
  const skill = value(
    "SELECT id FROM numeric_notes WHERE note_type='skill' AND content LIKE '[Skill: qa-read]%'",
  );
  const skill2 = value(
    "SELECT id FROM numeric_notes WHERE note_type='skill' AND content LIKE '[Skill: qa-check]%'",
  );
  await check("skill list", /qa-read/, ["skill list"]);
  await check("skill search qa-read", /qa-read/, ["skill search "]);
  await check("skill top qa-read bytes:800", /qa-read/, ["skill top "]);
  await check(`skill verify ${skill}`, /verified|verif/i, ["skill verify "]);
  await check(`skill compose ${skill} ${skill2}`, /compos|created|stored/i, ["skill compose "]);
  await check(`skill share ${skill} qa-pool`, /shared|added/i, ["skill share "]);
  await check("skill audit", /knowledge|audit|skill/i, ["skill audit"]);
  await check("skill builtin quantitative-estimates", /quant|estimate/i, ["skill builtin "]);
  writeFileSync(
    join(ctx.directory, "qa-skill.md"),
    "---\nname: qa-import\ndescription: Check a deterministic arithmetic fixture\n---\nRun calc 19*23 and require 437.\n",
  );
  await check(
    "skill import qa-skill.md",
    /import|stored/i,
    ["skill import "],
    undefined,
    "operator",
  );
  assert(existsSync(join(ctx.directory, "qa-skill.md")));
}

export async function exerciseCrew(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  await check(
    "crew create qa-crew CleanOwner,CleanWorker formation:verification -- Verify independent fixture evidence",
    /created/i,
    ["crew create "],
  );
  await check("crew join qa-crew", /Joined/, ["crew join "], undefined, "worker");
  await check("crew info qa-crew", /CleanWorker/, ["crew info "]);
  await check("crew dispatch qa-crew qa-crew-dispatch-193", /Dispatched/, ["crew dispatch "]);
  await check("crew formation qa-crew pipeline", /pipeline/, ["crew formation "]);
  await check("crew persist qa-crew", /persist/i, ["crew persist "]);
  await check("crew stage qa-crew planning", /completed/, ["crew stage "]);
  await check("crew artifact qa-crew draft -- fixture:qa-crew-draft-291", /Deposited/, [
    "crew artifact ",
  ]);
  await check("crew stall qa-crew CleanWorker waiting-for-review", /stall/i, ["crew stall "]);
  await check("crew leave qa-crew", /Left/, ["crew leave "], undefined, "worker");
  await check("crew invite qa-crew CleanWorker role:reviewer", /Invited/, ["crew invite "]);
  await check("crew invitations", /qa-crew/, ["crew invitations"], undefined, "worker");
  await check("crew decline qa-crew", /Declined/, ["crew decline "], undefined, "worker");
  await check("crew invite qa-crew CleanWorker role:reviewer", /Invited/, ["crew invite "]);
  await check("crew join qa-crew", /Joined/, ["crew join "], undefined, "worker");
  await check(
    "crew complete qa-crew -- Independently checked fixture:qa-crew-draft-291",
    /completed/,
    ["crew complete "],
  );
  await check("crew dissolve qa-crew qualification-finished", /Dissolved/, ["crew dissolve "]);
}

export async function exerciseOperator(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  for (const [input, expected, selector] of [
    ["admin stats", /entities|connections|rooms/i, "admin stats"],
    ["admin models", /model|provider/i, "admin models"],
    ["admin announce qa-announcement-471", /Announcement sent/, "admin announce "],
    ["admin decisions", /model|gate|setting/i, "admin decisions"],
    ["admin decisions set samples 2", /samples|1/, "admin decisions set "],
    ["admin decisions history", /samples/, "admin decisions history"],
    ["admin decisions unset samples", /samples/, "admin decisions unset "],
    ["admin ban QABannedFixture qualification-only", /Banned/, "admin ban "],
    ["admin bans", /QABannedFixture/i, "admin bans"],
    ["admin unban QABannedFixture", /Unbanned/, "admin unban "],
    ["admin snapshot qa-snapshot --compact", /Snapshot|snapshot/, "admin snapshot "],
    ["admin snapshots", /qa-snapshot/, "admin snapshots"],
    ["admin export", /export|Export/, "admin export"],
    ['adapter enable qa-fixture {"fixture":true}', /enabled/, "adapter enable "],
    ["adapter list", /qa-fixture/, "adapter list"],
    ["adapter status qa-fixture", /qa-fixture/, "adapter status "],
    ["adapter disable qa-fixture", /disabled/, "adapter disable "],
  ] as Array<[string, RegExp, string]>)
    await check(input, expected, [selector], undefined, "operator");
  await check(
    "admin stats",
    /entities|connections|rooms/i,
    ["admin <kick|ban|unban|stats|announce|reload|export> [args]"],
    undefined,
    "operator",
  );
}

export async function exerciseShell(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  await check("shell allow printf", /added/, ["shell allow "], undefined, "operator");
  await check("shell list", /printf/, ["shell list"], undefined, "operator");
  await check("run printf qa-shell-184", /qa-shell-184/, ["run <binary> "], undefined, "operator");
  await check(
    "shell save memory qa-shell-memory",
    /saved/,
    ["shell save memory "],
    "SELECT 1 FROM core_memory WHERE key='qa-shell-memory' AND value LIKE '%qa-shell-184%'",
    "operator",
  );
  await check(
    "shell save note 7 fact",
    /saved|note/i,
    ["shell save note "],
    "SELECT 1 FROM numeric_notes WHERE content LIKE '%qa-shell-184%'",
    "operator",
  );
  await check("board create qa-shell-board", /created/i, ["board create "], undefined, "operator");
  await check(
    "shell save board qa-shell-board qa-shell-post",
    /posted/,
    ["shell save board "],
    undefined,
    "operator",
  );
  await check("shell history 10", /printf/, ["shell history "], undefined, "operator");
  await check("shell log", /printf/, ["shell log "], undefined, "operator");
  await check("shell scratch ls", /\.txt|\.log/, ["shell scratch ls"], undefined, "operator");
  const listing = await ctx.command("operator", "shell scratch ls");
  const file = listing.match(/(?:exec|output)[^\s]+\.(?:txt|log)/)?.[0];
  assert(file, listing);
  await check(
    `shell scratch cat ${file}`,
    /qa-shell-184/,
    ["shell scratch cat "],
    undefined,
    "operator",
  );
  await check(`shell scratch rm ${file}`, /Deleted/, ["shell scratch rm "], undefined, "operator");
  await Bun.sleep(5100);
  await check("run quiet printf qa-quiet-185", /exit 0/, ["run quiet "], undefined, "operator");
  await Bun.sleep(5100);
  await check("run raw printf qa-raw-186", /qa-raw-186/, ["run raw "], undefined, "operator");
  await check("shell deny printf", /removed/, ["shell deny "], undefined, "operator");
}
