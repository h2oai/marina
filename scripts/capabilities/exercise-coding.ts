// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseCoding(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "code start Qualification session",
    /session|started/i,
    ["code start "],
    "SELECT id FROM coding_sessions WHERE title='Qualification session'",
  );
  const session = value("SELECT id FROM coding_sessions WHERE title='Qualification session'");
  for (const [input, expected, selectors] of [
    ["code status", /Qualification session/, ["code status "]],
    ["code list", /Qualification session/, ["code list"]],
    ["code files", /README.md/, ["code files "]],
    ["code read README.md", /cobalt-317/, ["code read "]],
    ["code search cobalt-317", /README.md/, ["code search "]],
    ["code workspace", /workspace/, ["code workspace"]],
    ["code workspace list", /workspace/, ["code workspace list"]],
    ["code workspace show", /workspace/, ["code workspace show"]],
    ["code workspace discover", /workspace|project|discover/i, ["code workspace discover"]],
    ["code workspace runner", /local/, ["code workspace runner"]],
    ["code workspace runner local", /local|host/, ["code workspace runner local"]],
    [`code workspace use ${ctx.workspace}`, /workspace|Selected/i, ["code workspace use "]],
    ["code doctor", /workspace|Workspace/, ["code doctor"]],
    ["code onboard", /workspace|Workspace/, ["code onboard"]],
    ["code roles", /role|Role/, ["code roles"]],
    ["code run allowlist", /bun|git|Allowed/, ["code run allowlist"]],
    ["code sandbox providers", /local|provider|sandbox/i, ["code sandbox providers"]],
    ["code sandbox status", /local|sandbox|configured/i, ["code sandbox status"]],
    ["code sandbox network status", /network|sandbox|configured/i, ["code sandbox network status"]],
    ["code sandbox credentials", /credential|sandbox|configured/i, ["code sandbox credentials"]],
    ["code sandbox local", /local/i, ["code sandbox local"]],
    ["code profile", /marina/, ["code profile"]],
    ["code profile list", /marina/, ["code profile list"]],
    ["code profile compare", /marina|Marina/, ["code profile compare"]],
    ["code profile help marina", /marina|Marina/, ["code profile help "]],
    ["code profile show", /marina|Marina/, ["code profile show"]],
    ["code profile use marina", /marina|Marina/, ["code profile use "]],
    [
      "code profile alias qaread read",
      /qaread/,
      ["code profile alias <a> ", "code profile alias <alias> "],
    ],
    ["code profile aliases", /qaread/, ["code profile aliases"]],
    ["code profile alias clear qaread", /clear|removed/i, ["code profile alias clear "]],
    ["code model", /model|target/i, ["code model"]],
    ["code model set direct", /direct/, ["code model set "]],
    ["code writer", /CleanOwner|unassigned|Write Lock/i, ["code writer "]],
    ["code recipe", /test/, ["code recipe"]],
    ["code recipe list", /test/, ["code recipe list"]],
    ["code recipe save qa-check bun test", /qa-check/, ["code recipe save "]],
    ["code recipe show qa-check", /bun test/, ["code recipe show "]],
    ["code plan Check arithmetic and preserve results", /plan|artifact|saved/i, ["code plan "]],
    ["code decision Use deterministic arithmetic", /decision|artifact|saved/i, ["code decision "]],
    ["code observe Cobalt fixture is readable", /observ|artifact|saved/i, ["code observe "]],
    ["code steer Keep the fixture isolated", /steer|record|saved/i, ["code steer "]],
    [
      "code summary The fixture contains one arithmetic test",
      /summary|artifact|saved/i,
      ["code summary "],
    ],
    [
      "code handoff Run the stored verification recipe",
      /handoff|artifact|saved/i,
      ["code handoff "],
    ],
    ["code skill add qa-skill Read the fixture then run bun test", /qa-skill/, ["code skill add "]],
    ["code skill", /qa-skill/, ["code skill"]],
    ["code skill list", /qa-skill/, ["code skill list"]],
    ["code skill use qa-skill", /qa-skill/, ["code skill use "]],
    ["code external link other qualification-928", /qualification-928/, ["code external link "]],
    ["code external", /qualification-928/, ["code external"]],
    ["code external show", /qualification-928/, ["code external show"]],
    ["code external unlink", /unlink|removed|archived/i, ["code external unlink"]],
    ["code task QA linked task", /task|Task/, ["code task "]],
    ["code artifacts", /plan|decision|summary/, ["code artifacts"]],
    ["code artifacts recent", /plan|decision|summary/, ["code artifacts recent"]],
    ["code artifacts kind plan", /Check arithmetic/, ["code artifacts kind "]],
    ["code thread", /plan|decision|summary/, ["code thread"]],
    ["code history", /Qualification|session|plan/i, ["code history "]],
    ["code show last", /artifact|Artifact|QA|qualification|task/i, ["code show "]],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, expected, selectors);
  await check(
    "code write generated.txt\nqa-write-781",
    /Created generated.txt|wrote|written|saved/i,
    ["code write "],
  );
  await ctx.scenario("coding:host-file-effect", async () => {
    assert.equal(readFileSync(join(ctx.workspace, "generated.txt"), "utf8").trim(), "qa-write-781");
    return "The requested host workspace file has exactly the supplied contents.";
  });
  await check("code read generated.txt", /qa-write-781/, ["code read "]);
  await check(
    "code edit README.md\n<<<<<<< OLD\ncobalt-317\n=======\ncobalt-318\n>>>>>>> NEW",
    /edit|replac|applied/i,
    ["code edit "],
  );
  await check("code diff", /cobalt-318/, ["code diff "]);
  await check("code checkpoint qa-checkpoint", /checkpoint/i, ["code checkpoint "]);
  const checkpoint = value(
    "SELECT id FROM coding_artifacts WHERE kind='checkpoint' ORDER BY created_at DESC LIMIT 1",
  );
  await check(`code revert ${checkpoint}`, /revert|revers/i, ["code revert "]);
  await ctx.scenario("coding:checkpoint-effect", async () => {
    assert.match(readFileSync(join(ctx.workspace, "README.md"), "utf8"), /cobalt-317/);
    return "Checkpoint reverse application restored the original tracked file contents.";
  });
  await check("code approval request other qa-reviewed-action", /approval|request/i, [
    "code approval request ",
  ]);
  for (const sub of ["approval", "approval list", "approvals"])
    await check(`code ${sub}`, /pending other/, [`code ${sub}`]);
  const approval = value(
    "SELECT id FROM coding_artifacts WHERE kind='approval' ORDER BY created_at DESC LIMIT 1",
  );
  await check(`code deny ${approval}`, /denied|reject/i, ["code deny "]);
  await check("code approval request other qa-accepted-action", /approval|request/i, [
    "code approval request ",
  ]);
  const accepted = value(
    "SELECT id FROM coding_artifacts WHERE kind='approval' ORDER BY created_at DESC LIMIT 1",
  );
  await check(`code approve ${accepted}`, /approved/i, ["code approve "]);
  const decision = value(
    "SELECT id FROM coding_artifacts WHERE kind='decision' ORDER BY created_at DESC LIMIT 1",
  );
  for (const [verb, pattern] of [
    ["pin", /pinned/],
    ["unpin", /unpinned/],
    ["archive", /archived/],
    ["supersede", /superseded/],
  ] as const)
    await check(`code ${verb} ${decision}`, pattern, [`code ${verb} `]);
  const patch =
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Qualification fixture: cobalt-317\n+Qualification fixture: cobalt-319\n";
  await check(`code patch qa-patch-319\n${patch}`, /Patch proposed/, ["code patch "]);
  await check("code patches pending", /qa-patch-319/, [
    "code patches pending",
    "code patches [status]",
  ]);
  await check("code reject last patch", /rejected/i, ["code reject "]);
  await check("code patches rejected", /qa-patch-319/, ["code patches rejected"]);
  await check(`code patch qa-applied-319\n${patch}`, /Patch proposed/, ["code patch "]);
  await check("code apply last patch", /applied/i, ["code apply "]);
  await check("code patches applied", /qa-applied-319/, ["code patches applied"]);
  await ctx.scenario("coding:applied-patch", async () => {
    assert.match(readFileSync(join(ctx.workspace, "README.md"), "utf8"), /cobalt-319/);
    return "An independently checked unified diff changed the tracked workspace file after apply; the rejected proposal did not apply.";
  });
  await check("code artifacts status approved", /approved|qa-accepted-action/i, [
    "code artifacts status ",
  ]);
  await check("code artifacts failed", /failed|No /, ["code artifacts failed"]);
  await check("code exec-mode off", /disabled/, ["code exec-mode "]);
  await check("code verify", /passed|1 pass|exit.*0|verification/i, ["code verify"]);
  await check("code worktree on", /worktree/i, ["code worktree on"]);
  await check("code worktree status", /worktree/i, ["code worktree", "code worktree status"]);
  await check("code worktree merge", /merge|merged|clean|changes/i, ["code worktree merge"]);
  await check("code worktree off", /worktree|disabled/i, ["code worktree off"]);
  for (const cmd of [
    "code test",
    "code lint",
    "code typecheck",
    "code recipe run qa-check",
    "code run bun test",
    'code run --argv ["bun","test"]',
  ])
    await check(cmd, /1 pass|passed|exit.*0/i, [
      cmd.startsWith("code recipe")
        ? "code recipe run "
        : cmd.startsWith("code run --argv")
          ? "code run --argv "
          : cmd.startsWith("code run")
            ? "code run <"
            : cmd,
    ]);
  await check(
    "code branch qa-branch",
    /branch|session/i,
    ["code branch "],
    "SELECT id FROM coding_sessions WHERE title='qa-branch'",
  );
  await check("code tree", /qa-branch/, ["code tree"]);
  await check(`code resume ${session}`, new RegExp(session), ["code resume "]);
  await check(
    "code done Qualification complete",
    /complete|done/i,
    ["code done "],
    `SELECT id FROM coding_sessions WHERE id='${session}' AND status='complete'`,
  );
  await check("code exit", /exit|left|world/i, ["code exit"]);
}
