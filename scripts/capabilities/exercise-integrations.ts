// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseConnectors(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  const path = join(ctx.directory, "mcp-fixture.ts");
  // Independent protocol peer, not a replacement for Marina's connector runtime.
  writeFileSync(
    path,
    `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
for await(const line of lines){const m=JSON.parse(line);if(m.id===undefined)continue;
let result;
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'qualification-peer',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'multiply',description:'Multiply two fixture integers',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:String(m.params.arguments.a*m.params.arguments.b)}]};
else result={};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}
`,
  );
  await ctx.scenario("stdio-connect", async () => {
    const out = await ctx.command(
      "operator",
      `connect add qa-mcp stdio ${process.execPath} --no-env-file ${path}`,
    );
    assert.match(out, /added \(stdio/);
    return out;
  });
  await check(
    "connect list",
    /qa-mcp/,
    ["connect list", "connect list [args]"],
    undefined,
    "operator",
  );
  await check("connect tools qa-mcp", /multiply/, ["connect tools "], undefined, "operator");
  await check(
    'connect call qa-mcp multiply {"a":19,"b":23}',
    /\b437\b/,
    ["connect call "],
    undefined,
    "operator",
  );
  // These deliberately non-secret fixture values test storage; stdio has no HTTP authentication.
  await check(
    "connect auth qa-mcp bearer qualification-synthetic",
    /Set bearer auth/,
    ["connect auth <name> bearer "],
    undefined,
    "operator",
  );
  await check(
    "connect auth qa-mcp header X-Qualification synthetic",
    /Set|header/i,
    ["connect auth <name> header "],
    undefined,
    "operator",
  );
  await check("connect remove qa-mcp", /removed/, ["connect remove "], undefined, "operator");
  const out = await ctx.command("operator", "connect add qa-http http://127.0.0.1:1/mcp");
  ctx.record({
    id: "connector-http-loopback",
    status: "blocked",
    commands: ["connect add <name> <url>"],
    detail: JSON.stringify({
      input: "connect add qa-http http://127.0.0.1:1/mcp",
      out,
      scope:
        "HTTP connector needs an allowed reachable MCP URL. The actual stdio call above qualifies only stdio transport.",
    }),
  });
}

export async function exerciseTrace(ctx: ExerciseContext) {
  const { check } = exercises(ctx);
  for (const [input, pattern, selectors] of [
    ["trace list 5", /Recent Traces|No traced/, ["trace [list]"]],
    ["trace stats 20", /Trace|trace/, ["trace stats "]],
    ["trace find limit=5", /Recent Traces|No traces/, ["trace find "]],
    ["trace dataset 5", /dataset|Dataset|trace|Trace/, ["trace dataset ["]],
    [
      "trace dataset verify 5",
      /verified|Verified|dataset|Dataset|verification/i,
      ["trace dataset verify "],
    ],
    ["trace otel", /otel|OTEL|OpenTelemetry|export/i, ["trace otel"]],
    ["trace compare models 20", /model|Model|trace|Trace/, ["trace compare "]],
    ["trace advise models 20", /advice|Advice|model|Model/, ["trace advise <models"]],
    [
      "trace advise evidence smoke 1",
      /evidence|Evidence|eligible|Eligible/,
      ["trace advise evidence "],
    ],
  ] as Array<[string, RegExp, string[]]>)
    await check(input, pattern, selectors);
  const row = ctx.db
    .query(
      "SELECT json_extract(data,'$.traceId') AS id FROM event_log WHERE json_extract(data,'$.traceId') IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: string } | null;
  assert(row, "A real command/model trace must exist");
  await check(`trace show ${row.id}`, new RegExp(row.id), ["trace show "]);
  await check(`trace eval ${row.id}`, /Evaluation|evaluator|integrity/i, ["trace eval "]);
  await check(
    `trace judge ${row.id} inconclusive qualification | This participant annotation is not an independent correctness verdict.`,
    /recorded|judgment/i,
    ["trace judge "],
    "SELECT id FROM trace_judgments WHERE criterion='qualification'",
  );
  await check(`trace judgments ${row.id}`, /qualification/, ["trace judgments "]);
  const input = `trace choose models ${ctx.model ?? "openrouter/deepseek/deepseek-v4.1-flash"}`;
  const out = await ctx.command("owner", input);
  ctx.record({
    id: "trace:choose-small-sample",
    status: "observed",
    commands: ctx.inventory.commands
      .find((c) => c.name === "trace")!
      .forms!.filter((f) => f.syntax.startsWith("trace choose "))
      .map((f) => f.syntax),
    detail: JSON.stringify({
      input,
      out,
      scope:
        "Fresh history cannot establish model-selection quality; actual bounded evidence query only.",
    }),
  });
}

export async function exerciseMiscellaneous(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check("group create qa-disband", /created|formed/i, ["group create "]);
  await check("group join qa-disband", /join/i, ["group join "], undefined, "worker");
  await check("group kick CleanWorker qa-disband", /kick|removed/i, ["group kick "]);
  await check("group disband qa-disband", /disband/i, ["group disband "]);
  await check("project create qa-short | Pipe syntax project", /created/i, [
    "project create <name> | <desc>",
  ]);
  await check("link unlink telegram", /unlink|No|not linked/i, ["link unlink "]);
  await check("reflect --template qualification", /Reflection|reflect|template/i, [
    "reflect --template ",
  ]);
  await check("reflect qualification --no-spawn", /Reflection|reflect|template/i, [
    "reflect [topic]",
  ]);
  await check(
    "reflect failure The controlled fixture lacked a provider --no-spawn",
    /Reflection|reflect|template/i,
    ["reflect failure "],
  );
  await check("inheritance list", /Shared Marina Inheritance/, ["inheritance [list]"]);
  await ctx.command("owner", "pool create tradition:qa");
  const note = await ctx.command(
    "owner",
    "note The tradition:qa fixture requires an explicit check before claiming success.",
  );
  const id = note.match(/#(\d+)/)?.[1];
  assert(id, note);
  await ctx.command(
    "owner",
    "pool tradition:qa add The fixture requires an explicit check before claiming success.",
  );
  const exported = await check("inheritance export tradition:qa", /Inheritance bundle/, [
    "inheritance export ",
  ]);
  const token = exported.match(/\ninherit (\S+)/)?.[1];
  if (token) {
    await check(
      `inheritance import ${token}`,
      /imported|already imported/i,
      ["inheritance import "],
      undefined,
      "worker",
    );
    const out = await ctx.command("worker", `inherit ${token}`);
    ctx.record({
      id: "alias:inherit-valid-token",
      status: /already imported/.test(out) ? "works" : "failed",
      capabilities: ["alias:inheritance:inherit"],
      detail: JSON.stringify({
        out,
        scope: "Legacy import-only alias, intentionally not a list alias.",
      }),
    });
  }
  await ctx.command("owner", "board create qa-archive");
  await ctx.command("owner", "board post qa-archive QA archive | Dedicated archival fixture");
  const post = value(
    "SELECT id FROM board_posts WHERE title='QA archive' ORDER BY id DESC LIMIT 1",
  );
  await check(`board archive ${post}`, /archiv/i, ["board archive "], undefined, "owner");
  await check("admin reload qa/objects", /reload/i, ["admin reload "], undefined, "operator");
  for (const input of ["quest start First Steps", "quest complete", "quest abandon"]) {
    const out = await ctx.command("owner", input);
    ctx.record({
      id: `empty-world:${input}`,
      status: "blocked",
      commands: ctx.inventory.commands
        .find((c) => c.name === "quest")!
        .forms!.filter((f) => f.syntax.startsWith(input.split(" ").slice(0, 2).join(" ")))
        .map((f) => f.syntax),
      detail: JSON.stringify({
        input,
        out,
        prerequisite:
          "The empty world's quest registry contains no objectives. These lifecycle paths need an installed quest, not imported legacy progress.",
      }),
    });
  }
}
