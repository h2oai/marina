// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { CoverageInventory, QualificationEvidence } from "./coverage";

export interface ExerciseContext {
  inventory: CoverageInventory;
  db: Database;
  directory: string;
  workspace: string;
  live: boolean;
  model?: string;
  freshParticipant: (name: string) => Promise<(input: string) => Promise<string>>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  record: (evidence: QualificationEvidence) => void;
  command: (actor: "owner" | "worker" | "operator", input: string) => Promise<string>;
  scenario: (id: string, run: () => Promise<string>, commands?: string[]) => Promise<void>;
}

/** Exact forms or explicit prefixes for equivalent declared spellings of one handler.
 * Each entry records its concrete input and asserted output/state; this does not
 * certify all values of an optional parameter. */
export function exercises(ctx: ExerciseContext) {
  let serial = 0;
  const row = (sql: string) => ctx.db.query(sql).get() as Record<string, unknown> | null;
  const value = (sql: string) => {
    const result = row(sql);
    assert(result, `Missing fixture: ${sql}`);
    return String(Object.values(result)[0]);
  };
  const check = async (
    input: string,
    expect: RegExp,
    selectors: string[],
    sql?: string,
    actor: "owner" | "worker" | "operator" = "owner",
  ) => {
    const forms = ctx.inventory.commands.flatMap((c) =>
      (c.forms ?? [])
        .filter((f) =>
          selectors.some((s) =>
            ctx.inventory.commands.some((c) => c.forms?.some((f) => f.syntax === s))
              ? f.syntax === s
              : f.syntax.startsWith(s),
          ),
        )
        .map((f) => f.syntax),
    );
    assert(forms.length, `No declared forms match ${JSON.stringify(selectors)}`);
    let observed = "";
    await ctx.scenario(
      `extended:${++serial}:${input.split(" ").slice(0, 2).join("-")}`,
      async () => {
        const output = await ctx.command(actor, input);
        observed = output;
        assert.doesNotMatch(
          output,
          /^(?:Usage:|Unknown subcommand|Error:|Refused:)|was not found or is ambiguous|Post #\d+ not found\.|No active watch #|Experiment .*not found\.|^Memory error|^Cannot |^schedule(?: add)?:/,
        );
        assert.match(output, expect);
        if (sql) assert(row(sql), `Persisted postcondition: ${sql}`);
        return JSON.stringify({ input, actor, expected: expect.source, sql, output });
      },
      forms,
    );
    return observed;
  };
  return { check, row, value };
}

export async function exerciseRecords(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "association create qa-association | Verify durable relations",
    /Association created/,
    ["association create "],
    "SELECT id FROM associations WHERE name='qa-association'",
  );
  await check(
    "association join qa-association | agent:CleanOwner | investigator",
    /Recorded.*joined/,
    ["association join "],
    "SELECT id FROM association_events WHERE kind='joined'",
  );
  await check(
    "association relate qa-association | agent:CleanOwner | directed | verifies | agent:CleanWorker",
    /Declared.*relation/,
    ["association relate "],
    "SELECT id FROM association_relations WHERE semantics='verifies'",
  );
  await check(
    `association revise qa-association | ${value("SELECT id FROM association_relations WHERE semantics='verifies'")} | agent:CleanOwner | reciprocal | reviews | agent:CleanWorker | {"checked":true}`,
    /Revised/,
    ["association revise "],
    "SELECT id FROM association_relations WHERE semantics='reviews' AND supersedes_id IS NOT NULL",
  );
  await check(
    "association link qa-association | project:cleanroom | work",
    /Linked/,
    ["association link "],
    "SELECT id FROM association_links WHERE relationship='work'",
  );
  await check(
    "association event qa-association observed | relation independently reviewed",
    /Recorded.*event/,
    ["association event "],
  );
  await check("association show qa-association", /reviews/, ["association show "]);
  await check("association list", /qa-association/, ["association list"]);
  await check(
    "association leave qa-association | agent:CleanOwner | finished",
    /Recorded.*left/,
    ["association leave "],
    "SELECT id FROM association_events WHERE kind='left'",
  );

  await check(
    "intellect create qa-intellect | preserve identity",
    /Intellect created/,
    ["intellect create "],
    "SELECT id FROM intellects WHERE display_name='qa-intellect'",
  );
  const intellect = value("SELECT id FROM intellects WHERE display_name='qa-intellect'");
  await check(
    `intellect instance ${intellect} | | qualification-model | websocket | fresh-world`,
    /Declared instance/,
    ["intellect instance "],
    "SELECT id FROM intellect_instances WHERE model_ref='qualification-model'",
  );
  await check(
    `intellect descend ${intellect} qa-descendant | child identity`,
    /descend|created/i,
    ["intellect descend "],
    "SELECT id FROM intellects WHERE display_name='qa-descendant'",
  );
  await check(
    `intellect event ${intellect} dormant | checkpoint saved`,
    /Recorded|dormant/,
    ["intellect event "],
    "SELECT id FROM intellect_events WHERE kind='dormant'",
  );
  await check(`intellect show ${intellect}`, /preserve identity/, ["intellect show "]);
  await check("intellect list", /qa-intellect/, ["intellect list"]);

  await check(
    "journey create Qualify durable coordination",
    /journey|Journey/,
    ["journey create "],
    "SELECT id FROM journeys WHERE expression='Qualify durable coordination'",
  );
  await check(
    "journey link latest project cleanroom evidence",
    /Correlated/i,
    ["journey link "],
    "SELECT id FROM journey_links WHERE ref='cleanroom'",
  );
  await check(
    "journey record latest evidence | durable coordination checked | project:cleanroom",
    /record/i,
    ["journey record "],
  );
  await check("journey steer latest Preserve the checked evidence", /steer|context|record/i, [
    "journey steer ",
  ]);
  for (const sub of ["show", "progress", "changes", "result"])
    await check(`journey ${sub} latest`, /Qualify|journey|Journey|evidence|result|Result|change/i, [
      `journey ${sub} `,
    ]);
  await check("journey list", /Qualify durable coordination/, ["journey list "]);

  await check(
    "experiment create qa-exp arms A,B metric accuracy goal higher",
    /created/i,
    ["experiment create "],
    "SELECT id FROM experiments WHERE name='qa-exp'",
  );
  await check("experiment join qa-exp", /join/i, ["experiment join "], undefined, "worker");
  await check(
    "experiment start qa-exp",
    /start/i,
    ["experiment start "],
    "SELECT id FROM experiments WHERE name='qa-exp' AND status='active'",
  );
  await check("experiment record qa-exp A accuracy 0.5", /Recorded: A.*0.5/, [
    "experiment record <name> <arm> <metric> <value>",
  ]);
  await check(
    "experiment record qa-exp B accuracy 1",
    /Recorded: B.*1/,
    ["experiment record <name> <arm> <metric> <value>"],
    undefined,
    "worker",
  );
  await check("experiment status qa-exp", /qa-exp|active/, ["experiment status "]);
  await check("experiment results qa-exp", /B:.*1\.000/, ["experiment results "]);
  await check(
    "experiment complete qa-exp",
    /completed.*winner.*B/,
    ["experiment complete "],
    "SELECT id FROM experiments WHERE name='qa-exp' AND status='completed'",
  );
  await check("experiment list", /qa-exp/, ["experiment list", "experiment"]);

  await check(
    "group create qa-group QualificationGroup",
    /created/i,
    ["group create "],
    "SELECT id FROM groups_ WHERE id='qa-group'",
  );
  await check("group invite CleanWorker qa-group", /invit/i, ["group invite "]);
  await check("group join qa-group", /join|already in/i, ["group join "], undefined, "worker");
  await check("group promote CleanWorker qa-group", /promot/i, ["group promote "]);
  await check("group demote CleanWorker qa-group", /demot/i, ["group demote "]);
  await check("group info QualificationGroup", /Members \(2\)/, ["group info "]);
  await check("group list", /QualificationGroup/, ["group list", "group list [args]"]);
  await check("group leave qa-group", /left|leave/i, ["group leave "], undefined, "worker");

  const post = value("SELECT id FROM board_posts WHERE body='Board-violet-7319'");
  await check(
    `board reply ${post} qa-reply-9281`,
    /reply|posted/i,
    ["board reply "],
    "SELECT id FROM board_posts WHERE body='qa-reply-9281'",
    "worker",
  );
  await check(
    `board vote ${post} up score 8`,
    /vote|score/i,
    ["board vote <postId> up "],
    undefined,
    "worker",
  );
  await check(
    `board vote ${post} down score 2`,
    /vote|score/i,
    ["board vote <postId> down "],
    undefined,
    "worker",
  );
  await check(`board scores ${post}`, /2|score/i, ["board scores "]);
  await check(
    `board pin ${post}`,
    /pin/i,
    ["board pin "],
    `SELECT id FROM board_posts WHERE id=${post} AND pinned=1`,
  );
  await check("board list", /cleanroom/, ["board list", "board list [args]"]);
  await check("export cleanroom json", /Board-violet-7319/, ["export "]);

  await check(
    "pool create qa-pool",
    /created/i,
    ["pool create "],
    "SELECT name FROM memory_pools WHERE name='qa-pool'",
  );
  await check("pool qa-pool add qa-pool-marker-527 importance:7", /added|note|stored/i, [
    "pool <name> add <text> ",
  ]);
  await check("share qa-pool qa-shared-marker-528", /shared|stored|added/i, ["share "]);
  for (const sub of ["list", "recall", "audit", "status"])
    await check(
      `pool qa-pool ${sub}${sub === "recall" ? " qa-pool-marker" : ""}`,
      /qa-pool|527|notes|pool/i,
      [`pool <name> ${sub}`],
    );
  await check("pool list", /qa-pool/, ["pool list"]);

  await check("memory kv set qa-delete-marker 823", /823|set|saved/i, ["memory kv set "]);
  await check("memory kv set qa-delete-marker 824", /824|set|saved/i, ["memory kv set "]);
  await check("memory kv history qa-delete-marker", /823/, ["memory kv history "]);
  await check("memory kv list", /qa-delete-marker/, ["memory kv list"]);
  await check(
    "memory kv delete qa-delete-marker",
    /delete|removed/i,
    ["memory kv delete "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM core_memory WHERE key='qa-delete-marker')",
  );
  await check("memory remember qa-canonical-memory-998", /record|saved|remember|id/i, [
    "memory remember ",
  ]);
  await check('memory query {"text":"qa-canonical-memory-998"}', /qa-canonical-memory-998/, [
    "memory query ",
  ]);
  await check("memory retrieve qa-canonical-memory-998", /qa-canonical-memory-998/, [
    "memory retrieve ",
  ]);

  await check(
    "watch create echoing payload:qa-watch-317 cadence:1s",
    /watch|created/i,
    ["watch create "],
    "SELECT id FROM notes WHERE content LIKE '%qa-watch-317%'",
  );
  const watch = value(
    "SELECT id FROM numeric_notes WHERE note_type='watch' AND content LIKE '%qa-watch-317%' ORDER BY id DESC LIMIT 1",
  );
  await check(`watch show ${watch}`, /echoing|qa-watch-317/, ["watch show "]);
  await check("watch list", /echoing/, ["watch list"]);
  await check("watch due", /watch|due|none/i, ["watch due "]);
  await check(`watch retire ${watch} reason:qualification-complete`, /retir/i, ["watch retire "]);

  await check(
    "schedule add qa-repeat every:1m max-runs:1 -- memory kv set qa-natural-tick 917",
    /schedule|created|added/i,
    ["schedule add <name> every:"],
  );
  await check("schedule pause qa-repeat", /pause/i, ["schedule pause "]);
  await check("schedule resume qa-repeat", /resum/i, ["schedule resume "]);
  await check(
    `schedule add qa-natural at:${new Date(Date.now() + 2000).toISOString()} -- memory kv set qa-natural-tick 917`,
    /schedule qa-natural: at/i,
    ["schedule add <name> at:"],
  );
  await ctx.scenario("extended:natural-due-schedule", async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (
        ctx.db.query("SELECT 1 FROM core_memory WHERE key='qa-natural-tick' AND value='917'").get()
      )
        return "Natural due-time scheduling persisted the expected checkpoint without schedule run.";
      await Bun.sleep(25);
    }
    throw new Error("Natural schedule did not persist expected checkpoint");
  });
  await check("schedule show qa-repeat", /qa-repeat/, ["schedule show "]);
  await check("schedule list", /qa-repeat/, ["schedule [list]"]);
  await check(
    "schedule delete qa-repeat",
    /delete|removed/i,
    ["schedule delete "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schedules WHERE name='qa-repeat')",
  );
}
