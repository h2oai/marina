// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { type ExerciseContext, exercises } from "./exercise";
import { receipt } from "./exercise-memory-advanced";

export async function exerciseDependent(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const probe = async (input: string, prefixes: string[], prerequisite?: string) => {
    let output: string;
    try {
      output = await ctx.command("operator", input);
    } catch (error) {
      output = String(error);
    }
    ctx.record({
      id: `dependent:${input}`,
      status: prerequisite ? "blocked" : "observed",
      commands: ctx.inventory.commands.flatMap((c) =>
        (c.forms ?? [])
          .filter((f) =>
            prefixes.some((p) =>
              ctx.inventory.commands.some((c) => c.forms?.some((f) => f.syntax === p))
                ? f.syntax === p
                : f.syntax.startsWith(p),
            ),
          )
          .map((f) => f.syntax),
      ),
      detail: JSON.stringify({
        input,
        output,
        prerequisite,
        scope: "Actual dependent operation; no positive final-outcome credit from this probe.",
      }),
    });
    return output;
  };
  const a = receipt(await ctx.command("owner", 'memory claim qa:conflict location "Paris"'));
  const b = receipt(await ctx.command("owner", 'memory claim qa:conflict location "Rome"'));
  await check(
    `memory resolve ${b.id} keep_both ${JSON.stringify({ competing: [a.id], rationale: "Both are deliberately conflicting fixture assertions; no factual winner asserted." })}`,
    /applied|kept|pending|resolution|keep_both/,
    ["memory resolve "],
  );
  await check("experiment create qa-short-record 1", /created/i, ["experiment create "]);
  await ctx.command("owner", "experiment join qa-short-record");
  await ctx.command("owner", "experiment start qa-short-record");
  await check("experiment record qa-short-record accuracy 1", /record/i, [
    "experiment record <name> <metric> <value>",
  ]);
  await ctx.command("operator", "board create qa-scenario");
  await ctx.command(
    "operator",
    "board post qa-scenario RAW: Qualification | Alice checks437; Bob reviews the result.",
  );
  for (const input of [
    "scenario extract board qa-scenario",
    "scenario extract https://example.com",
    "scenario inject qa-result=437",
    "scenario personas",
    "scenario report",
    "scenario status",
  ])
    await probe(input, [
      input.startsWith("scenario extract board")
        ? "scenario extract board "
        : input.startsWith("scenario extract")
          ? "scenario extract <url>"
          : input.startsWith("scenario inject")
            ? "scenario inject "
            : input,
    ]);
  await probe("shell save canvas qa-media", ["shell save canvas "]);
  await ctx.command("owner", "bankroll set 1000");
  await ctx.command("owner", "bankroll cap 10");
  await ctx.command("owner", "bankroll floor 10");
  const proposal = await ctx.command(
    "owner",
    'position propose {"items":[{"venue":"kalshi","ticker":"QA-CONFIRM","side":"yes","count":1,"price":50}]}',
  );
  const id = ctx.db
    .query("SELECT id FROM board_posts WHERE body LIKE '%QA-CONFIRM%' ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | null;
  assert(id, proposal);
  await check(
    `position confirm ${id.id}`,
    /paper|confirmed|opened/i,
    ["position confirm "],
    "SELECT id FROM board_posts WHERE body LIKE '%QA-CONFIRM%' AND body LIKE '%paper%'",
    "owner",
  );
  for (const sub of ["ack", "resolve"]) {
    const alert = ctx.db
      .query("SELECT id FROM operational_alerts ORDER BY last_seen_at DESC LIMIT 1")
      .get() as { id: string } | null;
    if (alert) await probe(`ops ${sub} ${alert.id}`, [`ops ${sub} `]);
    else
      await probe(
        "ops inbox",
        [`ops ${sub} `],
        "No operational alert exists in this fresh world; an actual inbox read confirms no eligible ID.",
      );
  }
  const run = ctx.db
    .query("SELECT id FROM evolution_runs ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | null;
  if (run) {
    for (const [input, prefix] of [
      [
        `evolve trial qa-evolution ${run.id} incumbent:qa-child-role benchmark:smoke limit:1 timeout:10s`,
        "evolve trial <experiment> <run-id> [",
      ],
      [`evolve trial qa-evolution ${run.id} result`, "evolve trial <experiment> <run-id> result"],
      [`evolve replicate qa-evolution ${run.id} n:1 budget:1`, "evolve replicate "],
    ])
      await probe(
        input!,
        [prefix!],
        "The actual candidate is inconclusive, has no independently earned trial win, and this is the parent world. Replication must remain unavailable.",
      );
  }
  await probe("world start qa-child", ["world start "]);
  await probe(
    "world adopt qa-child qa-child-role",
    ["world adopt <child>"],
    "The freshly seeded role has no accepted held-out trial win; adoption cannot legitimately be approved.",
  );
  await probe(
    "world adopt list",
    ["world adopt approve ", "world adopt reject "],
    "Actual adoption request produced no eligible offer; no approval/rollback ID exists. No synthetic win is inserted.",
  );
  await ctx.command("operator", "world stop qa-child");
  for (const [read, dependent, reason] of [
    [
      "challenge",
      ["challenge approve ", "challenge deny ", "decision approve ", "decision deny "],
      "No held challenge in the local profile. These commands require a real pending token and a separate approval-enabled identity.",
    ],
    [
      "witness queue",
      ["witness attest ", "witness reject "],
      "No pending independently attestable witness row exists in this fresh local world.",
    ],
    [
      "arena rounds 1",
      ["arena show "],
      "No downloaded arena round ID is available after the real remote discovery attempt.",
    ],
    [
      "market list",
      ["market show ", "market forecast "],
      "Empty world has no seeded market IDs; the actual market-live request did not install local markets.",
    ],
  ] as Array<[string, string[], string]>)
    await probe(read, dependent, reason);
  const tracked = ctx.db
    .query(
      "SELECT id FROM forecast_answers WHERE entity_name='CleanOperator' AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: number } | null;
  if (tracked)
    await probe(
      `forecast track ${tracked.id} kalshi/QA-NONRESOLVING`,
      ["forecast track "],
      "Fixture ticker has no real settlement oracle; tracking acceptance is not resolved-forecast qualification.",
    );
  else
    await probe(
      "forecast list",
      ["forecast track "],
      "The actual forecast attempts produced no eligible persisted forecast to track.",
    );
  await ctx.command("operator", "code start Dependent admission fixture");
  const attempt = ctx.db
    .query(
      "SELECT id,session_id FROM coding_artifacts WHERE kind='task_run' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { id: string; session_id: string } | null;
  if (attempt) {
    await ctx.command("operator", `code resume ${attempt.session_id}`);
    await probe(
      `code review accept-unverified ${attempt.id} Qualification records this as unverified, never successful.`,
      ["code review accept-unverified "],
      "Explicit unverified acceptance requires an active/submitted attempt with a saved worker summary; it cannot qualify verified correctness.",
    );
  } else
    await probe(
      "code review",
      ["code review accept-unverified "],
      "No real coding task attempt exists after the provider admission refusal; no fabricated attempt is inserted.",
    );
  await probe(
    "code workspace runner container image:qualification-unavailable:local sync:mount",
    ["code workspace runner container "],
    "No qualified container image/runtime fixture was provisioned; this checks configuration/admission only.",
  );
  await ctx.command("operator", "code workspace runner local");
  const spawned = await ctx.command(
    "operator",
    "code spawn qa-child-role Report437 and rest without spawning agents.",
  );
  const spawnId = spawned.match(/spawn_request_[a-z0-9-]+/)?.[0];
  if (spawnId) {
    await ctx.command("operator", `code approve ${spawnId}`);
    await probe(
      `code spawn run ${spawnId}`,
      ["code spawn run "],
      ctx.live ? undefined : "No provider for an approved resident spawn.",
    );
  }
  for (const input of [
    "code exec-approve qa-no-pending-token once",
    "code exec-deny qa-no-pending-token controlled-refusal",
  ])
    await probe(
      input,
      [input.startsWith("code exec-approve") ? "code exec-approve " : "code exec-deny "],
      "No pending interactive execution token exists. The explicit auto/off modes were tested; interactive approval completion remains unqualified.",
    );
  await ctx.command("operator", "code stop");
  await ctx.command("operator", "code exit");
  const rows = ctx.db
    .query(
      "SELECT r.id,r.metadata,n.content FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.metadata LIKE '%lesson%' AND r.status='active'",
    )
    .all() as Array<{ id: string; metadata: string; content: string }>;
  ctx.record({ id: "lessons:before-curation", status: "observed", detail: JSON.stringify(rows) });
  if (rows.length) {
    await probe(
      `lessons supersede ${rows[0]!.id} reason:qualification-scope -- Only a checked terminal artifact is evidence of successful completion.`,
      ["lessons supersede "],
    );
    const target = rows[1]?.id ?? rows[0]!.id;
    await probe(`lessons retire ${target} reason:qualification-fixture`, ["lessons retire <id>"]);
  } else
    await probe(
      "lessons",
      ["lessons retire <id>", "lessons supersede "],
      "No current lesson was produced in this arm; no fabricated lesson inserted to make curation appear successful.",
    );
  await probe(
    "lessons retire source:qa-controlled-fixture confirm:yes reason:qualification-fixture",
    ["lessons retire source:"],
  );
  await probe(
    "lessons retire match:qa-controlled-fixture confirm:yes reason:qualification-fixture",
    ["lessons retire match:"],
  );
  // Confirm the real stored helper states rather than inventing an expired ID.
  const job = ctx.db
    .query("SELECT id FROM memory_assistance_jobs WHERE state='expired' LIMIT 1")
    .get() as { id: string } | null;
  if (job) await probe(`ops assistance restore ${job.id}`, ["ops assistance restore "]);
  else
    await probe(
      "ops assistance",
      ["ops assistance restore "],
      "No expired assistance job exists. Completed/cancelled jobs cannot be restored as expired work.",
    );
  await probe("reflect via CleanWorker qa-assistance-fact-421", ["reflect via "]);
  const reflection = ctx.db
    .query(
      "SELECT id,state FROM memory_assistance_jobs WHERE role='memory-reflector' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { id: string; state: string } | null;
  if (reflection)
    await probe(
      `reflect adopt ${reflection.id}`,
      ["reflect adopt "],
      reflection.state === "completed"
        ? undefined
        : "The actual reflection helper job has not completed with a cited result; adoption is not qualified.",
    );
  else
    await probe(
      "memory jobs",
      ["reflect adopt "],
      "The actual reflection request produced no eligible helper job.",
    );
  for (const row of ctx.db.query("SELECT name FROM agent_configs").all() as Array<{ name: string }>)
    await ctx.command("operator", `agent stop ${row.name}`);
}
