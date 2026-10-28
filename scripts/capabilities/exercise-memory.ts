// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseMemory(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "note qa-evidence-red-445 importance 8 type fact",
    /noted|saved|note/i,
    ["note <text> "],
    "SELECT id FROM numeric_notes WHERE content='qa-evidence-red-445' AND importance=8 AND note_type='fact'",
  );
  await check("note qa-evidence-blue-446 importance 6 type fact", /noted|saved|note/i, [
    "note <text> ",
  ]);
  const red = value("SELECT id FROM numeric_notes WHERE content='qa-evidence-red-445'");
  const blue = value("SELECT id FROM numeric_notes WHERE content='qa-evidence-blue-446'");
  await check(
    `note link ${red} ${blue} supports`,
    /link/i,
    ["note link "],
    `SELECT 1 FROM note_links WHERE source_id=${red} AND target_id=${blue}`,
  );
  await check(
    `note source ${red} note:${blue} type fact credibility 0.8 observed 2026-10-25`,
    /source|added|recorded/i,
    ["note source "],
  );
  await check(`note derive ${red} ${blue}`, /deriv|link|source/i, ["note derive "]);
  for (const sub of ["explain", "trace"])
    await check(`note ${sub} ${red}`, /qa-evidence-red-445/, [`note ${sub} `]);
  await check(`note verify ${red} disputed 0.6 pending-review`, /disputed/, [
    "note verify <your-note-id> disputed ",
  ]);
  await check(`note verify ${red} unverified 0.5 review-incomplete`, /unverified/, [
    "note verify <your-note-id> unverified ",
  ]);
  await check(
    `note correct ${red} qa-evidence-red-corrected-447`,
    /superseding|correct|updated|saved/i,
    ["note correct "],
  );
  await check("note search qa-evidence-red-corrected-447", /447/, ["note search "]);
  await check("note list", /qa-evidence-red-corrected-447/, ["note list"]);
  await check("note graph", /supports|derived|qa-evidence/, ["note graph"]);
  await check(`note unlink ${red} ${blue} supports`, /unlink|removed/i, ["note unlink "]);
  await check(
    "note claim qa-evidence claim is testable confidence:0.8 source:https://example.invalid/fixture observed:2026-10-25",
    /claim|noted|saved/i,
    ["note claim "],
  );
  await check(`note evolve ${red}`, /evolv|reflection|summar|qa-evidence/i, ["note evolve "]);
  await check(
    `note delete ${blue}`,
    /delet/i,
    ["note delete "],
    `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM numeric_notes WHERE id=${blue})`,
  );
  await check("recall qa-evidence trusted budget 1000", /Recall \(evidence\)|No matching/, [
    "recall <query> [recent|important|trusted|explain|evidence|all] ",
  ]);
  await check("recap qa-evidence", /qa-evidence/, ["recap <topic>"]);
  await check("context qa-evidence", /qa-evidence/, ["context <query>"]);
  await check('context api {"query":"qa-evidence"}', /qa-evidence/, ["context api "]);
  await check('memory claim project:qa status "active"', /record|id|version/i, ["memory claim "]);
  await check("memory relate project:qa runtime runtime:bun", /record|id|version/i, [
    "memory relate ",
  ]);
  await check("memory graph project:qa", /runtime:bun/, ["memory graph "]);
  await check('memory query {"subject":"project:qa","predicate":"status"}', /active/, [
    "memory query ",
  ]);
  await check(
    'memory join {"patterns":[{"subject":"project:qa","predicate":"status","object":{"variable":"state","type":"string"}}]}',
    /active|bindings/,
    ["memory join "],
  );
  await check("memory plan Check project qa status", /plan|query|project/i, ["memory plan "]);
  const start = await check(
    "memory start Recover qa-evidence-red-corrected-447",
    /Task .*version/,
    ["memory start "],
  );
  const match = start.match(/Task (\S+) — .*version (\d+)/);
  assert(match, "Workflow returned task and version");
  const task = match[1]!;
  const ran = await check(`memory run ${task} ${match[2]}`, /ready|qa-evidence/, ["memory run "]);
  const version = ran.match(/version (\d+)/)?.[1];
  assert(version, "Workflow run returned a version");
  await check(
    `memory finish ${task} ${version} interrupted Resume and verify current evidence`,
    /interrupted/,
    ["memory finish "],
  );
  const resumed = await check(`memory resume ${task}`, /Resume and verify|interrupted/, [
    "memory resume ",
  ]);
  const resumedVersion = resumed.match(/version (\d+)/)?.[1];
  assert(resumedVersion);
  const rerun = await check(`memory run ${task} ${resumedVersion}`, /ready/, ["memory run "]);
  const readyVersion = rerun.match(/version (\d+)/)?.[1];
  assert(readyVersion);
  await check(
    `memory finish ${task} ${readyVersion} completed Verified qa-evidence-red-corrected-447`,
    /completed/,
    ["memory finish "],
  );
  await check(`memory feedback ${task} helpful Retrieved the current corrected evidence`, /"id":/, [
    "memory feedback ",
  ]);
  await check("memory tasks", new RegExp(task), ["memory tasks "]);
  await check("memory watch qa-watch", /qa-watch/, ["memory watch "]);
  await check("memory remember qa-watched-event-744", /id|record|version/i, ["memory remember "]);
  const poll = await check("memory poll qa-watch", /After processing: memory ack/, [
    "memory poll ",
  ]);
  const ack = poll.match(/After processing: (memory ack .+)/)?.[1];
  assert(ack);
  const ackOut = await check(ack, /qa-watch|version|cursor/, ["memory ack "]);
  const watchVersion = ackOut.match(/"version":\s*(\d+)/)?.[1];
  if (watchVersion)
    await check(`memory unwatch qa-watch ${watchVersion}`, /deleted|removed|version|qa-watch/, [
      "memory unwatch ",
    ]);
  for (const [input, pattern, selectors] of [
    ["memory changes", /cursor|events|changes/i, ["memory changes "]],
    ["memory review", /records|results|findings|review/i, ["memory review "]],
    ["memory usage", /bytes|records|storage/i, ["memory usage"]],
    ["memory service", /capabilit|operation|memory/i, ["memory service"]],
    ["memory vocabulary", /predicate|vocabular|namespace/i, ["memory vocabulary"]],
    ["memory recipes", /results/i, ["memory recipes"]],
    ["memory jobs", /jobs|results/i, ["memory jobs "]],
    ["memory transfers", /transfers|results/i, ["memory transfers "]],
    ["memory federation", /mounts/i, ["memory federation"]],
    ["memory sources qa-evidence", /sources|results/i, ["memory sources "]],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, pattern, selectors);

  await check(
    "task goal qa-goal | Verify a long-lived obligation priority:7",
    /created|goal/i,
    ["task goal "],
    "SELECT id FROM tasks WHERE title='qa-goal' AND priority=7",
  );
  const goal = value("SELECT id FROM tasks WHERE title='qa-goal'");
  await check(
    `task progress ${goal} +25`,
    /25/,
    ["task progress "],
    `SELECT id FROM tasks WHERE id=${goal} AND progress=25`,
  );
  await check(
    "task bundle qa-bundle | Group checked obligations",
    /bundle|created/i,
    ["task bundle "],
    "SELECT id FROM tasks WHERE title='qa-bundle'",
  );
  const bundle = value("SELECT id FROM tasks WHERE title='qa-bundle'");
  await check(`task assign ${goal} ${bundle}`, /assign/i, ["task assign "]);
  await check(`task children ${bundle}`, /qa-goal/, ["task children "]);
  await check(`task info ${goal}`, /qa-goal/, ["task info "]);
  await check("task create qa-cancel | Cancel an open fixture", /created/i, ["task create "]);
  const cancel = value("SELECT id FROM tasks WHERE title='qa-cancel'");
  await check(
    `task cancel ${cancel}`,
    /cancel/i,
    ["task cancel "],
    `SELECT id FROM tasks WHERE id=${cancel} AND status='cancelled'`,
  );
  await check(
    "task create qa-rejected | Deliberately submit an incorrect result standing:2 bounty",
    /created/i,
    ["task create "],
  );
  const rejected = value("SELECT id FROM tasks WHERE title='qa-rejected'");
  await check(`task claim ${rejected}`, /claim/i, ["task claim "], undefined, "worker");
  await check(
    `task submit ${rejected} Incorrect fixture answer`,
    /submit/i,
    ["task submit "],
    undefined,
    "worker",
  );
  await check(
    `task reject ${rejected} CleanWorker`,
    /reject/i,
    ["task reject "],
    `SELECT task_id FROM task_claims WHERE task_id=${rejected} AND status='rejected'`,
  );
  for (const [input, pattern, selectors] of [
    ["task recover", /recover|expired|lease/i, ["task recover", "task recover [args]"]],
    ["task standing", /standing|bount|task/i, ["task standing", "task standing [args]"]],
    ["task list", /qa-bundle/, ["task list", "task list [args]"]],
    ["outcome", /task|outcome/i, ["outcome"]],
    ["outcome stats", /task|resolved|outcome/i, ["outcome stats"]],
    ["outcome evidence", /task|evidence|mechanical/i, ["outcome evidence "]],
    ["outcome agreement", /agreement|judge|mechanical/i, ["outcome agreement"]],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, pattern, selectors);
}
