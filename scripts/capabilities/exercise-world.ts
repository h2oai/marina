// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseWorld(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "build room qa/room Qualification chamber",
    /Created room/,
    ["build room "],
    "SELECT room_id FROM room_sources WHERE room_id='qa/room'",
  );
  await check("build modify qa/room long A durable qualification room", /Modified|Updated|long/i, [
    "build modify [room] ",
  ]);
  await check("build link void/center north qa/room", /Linked|exit/i, ["build link "]);
  await check("goto qa/room", /Qualification chamber/, ["goto "]);
  await check("build modify item compass qa-compass-marker", /item|Updated/i, [
    "build modify item ",
  ]);
  await check("look compass", /qa-compass-marker/, ["look [target]"]);
  await check("build link qa/room south void/center", /Linked|exit/i, ["build link "]);
  await check("move south", /Void/, ["move "]);
  await check("goto qa/room", /Qualification chamber/, ["goto "]);
  await check("build access qa/room private", /private/, ["build access <room> private|public"]);
  await check("build invite qa/room CleanWorker", /invit/i, ["build invite "]);
  await check("goto qa/room", /Qualification chamber/, ["goto "], undefined, "worker");
  await check("build uninvite qa/room CleanWorker", /no longer invited|revok|removed|uninvited/i, [
    "build uninvite ",
  ]);
  await check("build access qa/room public", /public/, ["build access <room> private|public"]);
  await check("build access qa/room", /public/, ["build access <room>"]);
  await check("build formation qa/room verification", /verification/, ["build formation [room] <"]);
  await check("build formation qa/room", /verification/, ["build formation [room]"]);
  await check("build formation qa/room off", /cleared|off|removed/i, ["build formation [room] <"]);
  await check("build template save qa/room qa-template Qualification template", /saved|template/i, [
    "build template save ",
  ]);
  await check("build template list", /qa-template/, [
    "build template list ",
    "build template",
    "build template [args]",
  ]);
  await check(
    "build template apply qa-template qa/copy",
    /created|applied/i,
    ["build template apply "],
    "SELECT room_id FROM room_sources WHERE room_id='qa/copy'",
  );
  for (const [cmd, expect, sel] of [
    ["ls rooms", /qa\/room/, ["ls rooms"]],
    ["ls qa/room", /compass|Qualification/, ["ls <room-id>"]],
    ["ls entities", /CleanOwner/, ["ls entities"]],
    ["ls", /compass|CleanWorker|Qualification/, ["ls"]],
    ["map", /qa\/room|Qualification|Void/, ["map"]],
    ["source qa/room", /Qualification/, ["source [here|room/id]"]],
    ["source command calc", /calc|expression/, ["source command "]],
    ["build diff qa/room", /qa\/room|diff|version|change/i, ["build diff", "build diff [args]"]],
    ["build audit", /qa\/room|audit|Audit/, ["build audit", "build audit [args]"]],
    ["build validate qa/room", /valid/i, ["build validate", "build validate [args]"]],
  ] as Array<[string, RegExp, string[]]>)
    await check(cmd, expect, sel);
  await check(
    'build code qa/copy export default {short:"qa-executable-room",long:"compiled fixture",exits:{},commands:{qa:(ctx,input)=>ctx.send(input.entity,"qa-handler-991")}}',
    /compiled|saved|updated|valid/i,
    ["build code "],
    undefined,
    "operator",
  );
  await check(
    "build reload qa/copy",
    /reload|loaded/i,
    ["build reload", "build reload [args]"],
    undefined,
    "operator",
  );
  await check("goto qa/copy", /qa-executable-room/, ["goto "]);
  await ctx.scenario("world:compiled-handler", async () => {
    const output = await ctx.command("owner", "qa");
    if (!output.includes("qa-handler-991")) throw new Error(output);
    return "Operator-authored room code compiled and its installed handler returned the fixture marker to an agent.";
  });
  await check(
    "build reload qa/copy",
    /reload|loaded/i,
    ["build reload", "build reload [args]"],
    undefined,
    "operator",
  );
  await check("build revert qa/copy", /revert|restor/i, ["build revert "], undefined, "operator");
  await check(
    "build command create qacmd",
    /created/i,
    ["build command create "],
    undefined,
    "operator",
  );
  for (const sub of ["list", "code", "validate", "audit"])
    await check(
      `build command ${sub} qacmd`,
      /qacmd|valid|source|history|export/i,
      [`build command ${sub} <name>`],
      undefined,
      "operator",
    );
  await check(
    'build command code qacmd export default {name:"qacmd",minRank:0,help:"qualification command",handler:(ctx,input)=>ctx.send(input.entity,"qa-command-772")}',
    /saved|updated|compiled/i,
    ["build command code <name> [source]"],
    undefined,
    "operator",
  );
  await check(
    "build command reload qacmd",
    /reload|loaded/i,
    ["build command reload "],
    undefined,
    "operator",
  );
  await ctx.scenario("world:dynamic-command", async () => {
    const output = await ctx.command("owner", "qacmd");
    if (!output.includes("qa-command-772")) throw new Error(output);
    return "Dynamic command authored, compiled, reloaded and invoked through the real agent connection.";
  });
  await check(
    "build command destroy qacmd",
    /destroy|removed|delete/i,
    ["build command destroy "],
    undefined,
    "operator",
  );
  await check("goto void/center", /Void/, ["goto "]);
  await check("goto void/center", /Void/, ["goto "], undefined, "worker");
  await check("build unlink qa/room south", /unlink|removed/i, ["build unlink "]);
  await check(
    "build destroy qa/copy",
    /destroy|removed/i,
    ["build destroy "],
    undefined,
    "operator",
  );

  await check(
    "trait create qa-trait discipline Check persisted results strengths verification domains testing behaviors inspect successSignals evidence",
    /created/i,
    ["trait create "],
    "SELECT name FROM traits WHERE name='qa-trait'",
  );
  await check("trait create qa-other discipline Record checked results", /created/i, [
    "trait create ",
  ]);
  for (const sub of ["view", "lint", "history"])
    await check(`trait ${sub} qa-trait`, /qa-trait|verification|history|issues|edit/i, [
      `trait ${sub} `,
    ]);
  await check("trait diff qa-trait qa-other", /Check persisted|Record checked/, ["trait diff "]);
  await check("trait list", /qa-trait/, ["trait list"]);
  await check(
    "role create qa-role traits qa-trait guidelines Check results | Preserve evidence focus qualification tone precise",
    /created/i,
    ["role create "],
    "SELECT name FROM roles WHERE name='qa-role'",
  );
  await check("role create qa-other-role traits qa-other", /created/i, ["role create "]);
  for (const sub of ["view", "lint", "history"])
    await check(`role ${sub} qa-role`, /qa-role|qualification|history|issues|edit/i, [
      `role ${sub} `,
    ]);
  await check("role view qa-role goal verify arithmetic", /qa-role|Check results/, ["role view "]);
  await check("role diff qa-role qa-other-role", /qa-role|qa-trait/, ["role diff "]);
  await check("role list", /qa-role/, ["role list"]);
  await check(
    "system-prompt role qa-role goal verify arithmetic",
    /verify arithmetic|Check results/,
    ["system-prompt "],
  );
  await check("role edit qa-other-role tone concise", /updated|edited|saved/i, ["role edit "]);
  await check("role reload qa-role", /reload|no.*agents/i, ["role reload "]);
  await check(
    "role delete qa-other-role",
    /delet/i,
    ["role delete "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM roles WHERE name='qa-other-role')",
  );
  await check(
    "trait delete qa-other",
    /delet/i,
    ["trait delete "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM traits WHERE name='qa-other')",
  );

  await check(
    "canvas create qa-canvas Qualification canvas",
    /created/i,
    ["canvas create "],
    "SELECT id FROM canvases WHERE name='qa-canvas'",
  );
  await check("canvas post on:qa-canvas qa-canvas-message-551", /post|publish|node/i, [
    "canvas post ",
  ]);
  await check("canvas post on:qa-canvas qa-canvas-message-552", /post|publish|node/i, [
    "canvas post ",
  ]);
  const nodes = ctx.db
    .query(
      "SELECT n.id FROM canvas_nodes n JOIN canvases c ON c.id=n.canvas_id WHERE c.name='qa-canvas' ORDER BY n.created_at",
    )
    .all() as Array<{ id: string }>;
  if (nodes.length < 2) throw new Error("Canvas posting did not create two nodes");
  await check(
    `canvas connect ${nodes[0]!.id} ${nodes[1]!.id} supports qa-canvas`,
    /connect|edge/i,
    ["canvas connect "],
    "SELECT id FROM canvas_edges WHERE relationship='supports'",
  );
  await check("canvas edges qa-canvas", /supports/, ["canvas edges "]);
  for (const layout of ["grid", "timeline", "feed"])
    await check(`canvas layout ${layout} qa-canvas`, new RegExp(layout), ["canvas layout "]);
  await check("canvas info qa-canvas", /Qualification canvas/, ["canvas info "]);
  await check("canvas nodes qa-canvas", /\[text\]/, ["canvas nodes "]);
  await check("canvas list", /qa-canvas/, ["canvas list"]);
  await check("canvas visit qa-canvas", /qa-canvas|Qualification canvas/, ["canvas visit "]);
  await check(
    `canvas disconnect ${value("SELECT id FROM canvas_edges WHERE relationship='supports'")}`,
    /disconnect|removed/i,
    ["canvas disconnect "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM canvas_edges WHERE relationship='supports')",
  );
  await check("canvas resources", /resource|memory|task/i, ["canvas resources "]);
  await check(
    "canvas delete qa-canvas",
    /delet/i,
    ["canvas delete "],
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM canvases WHERE name='qa-canvas')",
  );
}
