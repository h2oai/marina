// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { MarinaClient } from "../../src/sdk/client";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseAliases(ctx: ExerciseContext) {
  const readArgs: Record<string, string> = {
    asset: "list",
    association: "list",
    benchmark: "list",
    bookmark: "list",
    canvas: "list",
    challenge: "stats",
    channel: "list",
    connect: "list",
    decision: "list",
    evolve: "loop",
    experiment: "list",
    forecast: "list",
    gate: "list",
    gateway: "list",
    genome: "list",
    group: "list",
    help: "catalog",
    ignore: "list",
    intellect: "list",
    inventory: "",
    journey: "list",
    look: "",
    ls: "rooms",
    market: "list",
    mesh: "list",
    mutation: "list",
    ops: "inbox",
    orient: "",
    outcome: "stats",
    pattern: "list",
    position: "list",
    productivity: "",
    project: "list",
    quest: "list",
    readiness: "",
    scenario: "status",
    schedule: "list",
    score: "",
    shell: "list",
    "system-prompt": "",
    time: "",
    trace: "list",
    usecase: "list",
    world: "list",
  };
  for (const command of ctx.inventory.commands) {
    if (!command.aliases?.length || !(command.name in readArgs)) continue;
    const canonical = `${command.name} ${readArgs[command.name]}`.trim();
    const baseline = await ctx.command("operator", canonical);
    const normalize = (output: string) => output.trim().split("\n")[0]!.replace(/\d+/g, "#");
    for (const alias of command.aliases) {
      const input = `${alias} ${readArgs[command.name]}`.trim();
      try {
        const output = await ctx.command("operator", input);
        assert(baseline.trim());
        assert.doesNotMatch(baseline, /^(Usage:|Unknown command|Error:|Refused:)/);
        assert.equal(normalize(output), normalize(baseline));
        ctx.record({
          id: `alias:${alias}`,
          status: "works",
          capabilities: [`alias:${command.name}:${alias}`],
          detail: JSON.stringify({
            canonical,
            input,
            baseline,
            output,
            assertion:
              "Canonical and alias execute the same valid read operation and return the same heading; arguments and optional branches are not exhaustively qualified.",
          }),
        });
      } catch (error) {
        ctx.record({
          id: `alias:${alias}`,
          status: "failed",
          capabilities: [`alias:${command.name}:${alias}`],
          detail: String(error),
        });
      }
    }
  }
  const { check } = exercises(ctx);
  await check("build room qa/alias-origin Alias origin", /Created/, ["build room "]);
  await check("build room qa/alias-target Alias destination", /Created/, ["build room "]);
  const movement = ctx.inventory.commands.find((c) => c.name === "move")!;
  for (const alias of movement.aliases ?? []) {
    const direction =
      alias === "go"
        ? "north"
        : ((
            {
              n: "north",
              s: "south",
              e: "east",
              w: "west",
              u: "up",
              d: "down",
              ne: "northeast",
              nw: "northwest",
              se: "southeast",
              sw: "southwest",
            } as Record<string, string>
          )[alias] ?? alias);
    await ctx.command("owner", `build link qa/alias-origin ${direction} qa/alias-target`);
    await ctx.command("owner", "goto qa/alias-origin");
    const input = alias === "go" ? "go north" : alias;
    const output = await ctx.command("owner", input);
    ctx.record({
      id: `alias:${alias}`,
      status: output.includes("Alias destination") ? "works" : "failed",
      capabilities: [`alias:move:${alias}`],
      detail: JSON.stringify({ input, output, expectedRoom: "qa/alias-target" }),
    });
  }
  for (const alias of ctx.inventory.commands.find((c) => c.name === "goto")!.aliases ?? []) {
    await ctx.command("owner", "goto qa/alias-target");
    const output = await ctx.command("owner", `${alias} qa/alias-origin`);
    ctx.record({
      id: `alias:${alias}`,
      status: output.includes("Alias origin") ? "works" : "failed",
      capabilities: [`alias:goto:${alias}`],
      detail: JSON.stringify({ input: `${alias} qa/alias-origin`, output }),
    });
  }
  for (const [name, input, expected] of [
    ["emote", "me checks qa-emote-189", /qa-emote-189/],
    ["shout", "yell qa-shout-189", /qa-shout-189/],
    ["tell", "whisper CleanWorker qa-whisper-189", /qa-whisper-189|CleanWorker/],
    ["tell", "msg CleanWorker qa-msg-189", /qa-msg-189|CleanWorker/],
    ["re", "reply qa-reply-alias-189", /qa-reply-alias-189|CleanWorker/],
  ] as const) {
    const output = await ctx.command("owner", input);
    ctx.record({
      id: `alias:${input.split(" ")[0]}`,
      status: expected.test(output) ? "works" : "failed",
      capabilities: [`alias:${name}:${input.split(" ")[0]}`],
      detail: JSON.stringify({ input, output }),
    });
  }
  for (const input of [
    "'qa-quote-alias-817",
    "@CleanWorker qa-mention-alias-818",
    "@CleanWorker,CleanOperator qa-many-mention-819",
    "@all qa-all-mention-820",
    "@@ qa-global-mention-821",
  ]) {
    const output = await ctx.command("owner", input);
    ctx.record({
      id: `prefix:${input.split(" ")[0]}`,
      status: "observed",
      detail: JSON.stringify({
        input,
        output,
        scope:
          "Runtime-only prefix outside the command registry; exact routing still requires recipient assertions.",
      }),
    });
  }
  await ctx.command("owner", "goto void/center");
}

export async function exerciseObjects(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  await check("build room qa/objects Object fixture", /Created/, ["build room "]);
  await check(
    'build code qa/objects export default {short:"Object fixture",long:"Pickup qualification",exits:{},onEnter(ctx){if(!ctx.findEntity("qa-token")){const id=ctx.spawn({name:"qa-token",short:"a qualification token",long:"qa-object-815"});ctx.getEntity(id).kind="object";}}}',
    /saved|compiled|updated/i,
    ["build code "],
    undefined,
    "operator",
  );
  await check("build reload qa/objects", /reload|loaded/i, ["build reload"], undefined, "operator");
  await check("goto qa/objects", /Object fixture/, ["goto "]);
  await check("goto qa/objects", /Object fixture/, ["goto "], undefined, "worker");
  await check("get qa-token", /pick up/, ["get "]);
  await check("inventory", /qa-token/, ["inventory"]);
  await check("give qa-token to CleanWorker", /give/, ["give "]);
  await check("inventory", /qa-token/, ["inventory"], undefined, "worker");
  await check("drop qa-token", /drop/, ["drop "], undefined, "worker");
  for (const alias of ["take", "pick"]) {
    const output = await ctx.command("owner", `${alias} qa-token`);
    ctx.record({
      id: `alias:${alias}`,
      status: /pick up/.test(output) ? "works" : "failed",
      capabilities: [`alias:get:${alias}`],
      detail: JSON.stringify({ input: `${alias} qa-token`, output }),
    });
    await check("drop qa-token", /drop/, ["drop "]);
  }
  await ctx.command("owner", "goto void/center");
  await ctx.command("worker", "goto void/center");
}

export async function exerciseChildWorld(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "world create qa-child empty | Verify a fresh child world without inherited legacy data",
    /Created child/,
    ["world create "],
  );
  await check("world list", /qa-child/, ["world list"]);
  await check(
    "world start qa-child",
    /running|started/i,
    ["world start "],
    "SELECT 1 FROM world_variants WHERE name='qa-child' AND status='running'",
  );
  try {
    await check("world run qa-child calc 19*23", /437/, ["world run "]);
    await check("role create qa-child-role Verify arithmetic fixtures", /created|saved/i, [
      "role create ",
    ]);
    await check("world seed-role qa-child qa-child-role", /seed|copied|import/i, [
      "world seed-role ",
    ]);
    await check("world run qa-child role show qa-child-role", /qa-child-role/, ["world run "]);
    const path = value("SELECT db_path FROM world_variants WHERE name='qa-child'");
    assert(path.startsWith(ctx.directory), "Child DB must remain inside isolated arm");
    const port = value("SELECT ws_port FROM world_variants WHERE name='qa-child'");
    const peer = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
      autoReconnect: false,
      pingInterval: 0,
      commandMode: "correlated",
      principal: "agent",
    });
    try {
      await peer.connect("RemotePeer");
      const received: string[] = [];
      peer.on("perception", (p) => received.push(JSON.stringify(p)));
      await check(
        `gateway add qa-peer ws://127.0.0.1:${port}/ws`,
        /connected/,
        ["gateway add "],
        undefined,
        "operator",
      );
      await check("gateway list", /qa-peer/, ["gateway list"], undefined, "operator");
      await check(
        "gateway status qa-peer",
        /connected/,
        ["gateway status "],
        undefined,
        "operator",
      );
      await check(
        "gateway send qa-peer RemotePeer qa-federation-437",
        /sent|Sent/,
        ["gateway send "],
        undefined,
        "operator",
      );
      await ctx.scenario("federation-recipient", async () => {
        const deadline = Date.now() + 5000;
        while (!received.some((p) => p.includes("qa-federation-437")) && Date.now() < deadline)
          await Bun.sleep(25);
        assert(
          received.some((p) => p.includes("qa-federation-437")),
          "Actual remote WebSocket client received the gateway message",
        );
        return JSON.stringify(received.filter((p) => p.includes("qa-federation-437")));
      });
      await ctx.command("operator", "channel join qa-federation");
      await peer.command("channel join qa-federation");
      await check(
        "gateway bridge qa-peer qa-federation",
        /bridg/i,
        ["gateway bridge "],
        undefined,
        "operator",
      );
      await check(
        "gateway unbridge qa-peer qa-federation",
        /unbridg|removed/i,
        ["gateway unbridge "],
        undefined,
        "operator",
      );
      await check("gateway remove qa-peer", /removed/, ["gateway remove "], undefined, "operator");
    } finally {
      peer.disconnect();
    }
  } finally {
    await check("world stop qa-child", /stopped|stop/i, ["world stop "]);
  }
}
