// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Actual installed coding applications, explicit local MCP configuration,
 * disposable workspace, independently checked file patch and durable checkpoint. */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveMemory } from "../../src/memory/server";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    directory: { type: "string" },
    client: { type: "string" },
    task: { type: "string", default: "rook" },
    "budget-usd": { type: "string" },
  },
});
const budget = Number(values["budget-usd"]);
if (
  !values.directory ||
  !["claude", "codex"].includes(values.client ?? "") ||
  !["rook", "marina-sdk"].includes(values.task) ||
  !Number.isFinite(budget) ||
  budget <= 0 ||
  budget > 5
)
  throw new Error("Use --directory PATH --client claude|codex --budget-usd 0..5");
const directory = resolve(values.directory),
  workspace = `${directory}/workspace`;
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const memory = serveMemory({ dbPath: `${directory}/memory.db`, port: 0 });
const credential = memory.db.issueMemoryCredential(
  memory.db.ensurePrincipal({ type: "service", displayName: "coding-client" }).principal_id,
);
const client = new MarinaMemoryClient(`http://127.0.0.1:${memory.server.port}`, credential.token);
const space = (await client.createSpace("coding-task")).id;
const code = `client-${crypto.randomUUID().slice(0, 8)}`;
const sdkTask = values.task === "marina-sdk";
const filename = sdkTask ? "memory-answer.ts" : "retry-after.ts";
const checkpointName = sdkTask ? "sdk-complete" : "rook-complete";
const source = await client.capture(
  space,
  sdkTask
    ? `Rook Marina SDK contract ${code}: append an exported function createMemoryCitation(evidence: MemoryEvidence, quote: string): MemoryCitation to the existing memory-answer.ts module. It must throw RangeError when quote is empty/whitespace or is not an exact substring of evidence.text. It returns a fresh citation containing only kind, space_id, id, quote and the record version OR source text_hash/start/end as appropriate. Preserve the exact quote, never trim or change it. Do not mutate evidence. Do not include text or freshness in the citation. This constructs a caller-selected quotation, not a truth or freshness judgment. Preserve all existing exports and behavior.`
    : `Rook parser acceptance contract ${code}: parseRetryAfter(value, nowMs) returns delay milliseconds. Decimal digits are seconds (trim whitespace); HTTP date is milliseconds until that date, clamped to zero. Invalid values return null. Values must be strings; do not coerce numbers/null. Never return NaN or Infinity.`,
);
await client.remember(space, {
  content: `Rook ${values.task} contract ${code}. Read original source ${source.id} before implementing.`,
  source_ids: [source.id],
});
let seed = sdkTask
  ? readFileSync(resolve("src/sdk/memory-answer.ts"), "utf8")
  : "export function parseRetryAfter(value: unknown, nowMs: number): number | null {\n  return null;\n}\n";
if (sdkTask) {
  // Recreate the missing-helper task after its implementation has been adopted
  // in Marina. Only this disposable copy changes; a no-op cannot pass the task.
  const marker = "\n/** Creates a caller-selected quotation";
  const start = seed.indexOf(marker);
  if (start >= 0) {
    assert.equal((seed.slice(start).match(/export /g) ?? []).length, 1);
    assert.ok(seed.slice(start).includes("export function createMemoryCitation("));
    seed = `${seed.slice(0, start).trimEnd()}\n`;
  }
  assert.ok(!seed.includes("export function createMemoryCitation("));
}
writeFileSync(`${workspace}/${filename}`, seed);
writeFileSync(
  `${workspace}/README.md`,
  `Implement ${filename}. Requirements are in Marina memory under Rook. Preserve existing exported signatures.\n`,
);
const credentials = `${directory}/memory-credentials.json`;
writeFileSync(credentials, JSON.stringify({ token: credential.token, spaceId: space }), {
  mode: 0o600,
});
const mcpArgs = [
  resolve("scripts/memory-mcp.ts"),
  "--url",
  client.url,
  "--credentials",
  credentials,
];
const mcpConfig = `${directory}/mcp.json`;
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: { marina: { type: "stdio", command: process.execPath, args: mcpArgs } },
  }),
  { mode: 0o600 },
);
const prompt = `Use the configured Marina MCP memory service to discover the Rook specification and read its original source. Implement ${filename} in this workspace. Then save a durable checkpoint named ${checkpointName} using memory_service operation save_checkpoint, id ${checkpointName}, input {expected_version:0,data:{file:'${filename}',source_id:SOURCE_ID},source_ids:[SOURCE_ID]}. Finish by identifying the source ID and what changed. You may read and edit workspace files. The independent harness runs functional tests after you finish; do not create or modify tests. Memory tools are already configured; use them directly.`;
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  MARINA_MEMORY_URL: client.url,
  MARINA_MEMORY_SPACE: space,
  MARINA_MEMORY_TOKEN: credential.token,
  NO_COLOR: "1",
};
let reserved = 0,
  attempts = 0;
const upstream: { status: number; bytes: number }[] = [];
let gate: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {
  schema: "marina.memory.coding-client.v1",
  client: values.client,
  task: values.task,
  source_id: source.id,
  source_text: (await client.sourceRange(space, source.id)).text,
  budget_usd: budget,
  seed,
  passed: false,
};
try {
  let args: string[];
  if (values.client === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is missing");
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    env.CLAUDE_CONFIG_DIR = `${directory}/claude-config`;
    args = [
      "claude",
      "--bare",
      "--restricted",
      "--print",
      "--model",
      "claude-haiku-4-5-20251001",
      "--max-budget-usd",
      String(budget),
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--tools",
      "Read,Edit,Write",
      "--allowedTools",
      "Read,Edit,Write,mcp__marina__*",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--",
      prompt,
    ];
    report.model = "claude-haiku-4-5-20251001";
  } else {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
    const token = crypto.randomUUID();
    gate = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 512 * 1024,
      idleTimeout: 120,
      async fetch(request) {
        if (request.headers.get("Authorization") !== `Bearer ${token}`)
          return new Response("Unauthorized", { status: 401 });
        if (new URL(request.url).pathname !== "/v1/responses" || request.method !== "POST")
          return new Response("Unapproved endpoint", { status: 403 });
        const body = (await request.json()) as Record<string, unknown>;
        if (body.model !== "gpt-5.6-luna") return new Response("Unapproved model", { status: 403 });
        body.max_output_tokens = 2048;
        body.reasoning = { effort: "none" };
        body.store = false;
        const text = JSON.stringify(body),
          bytes = Buffer.byteLength(text);
        const bound = ((bytes + 4096) * 0.5 + 2048 * 1.8) / 1e6;
        if (attempts >= 60 || reserved + bound > budget)
          return new Response("Qualification budget exhausted", { status: 429 });
        reserved += bound;
        attempts++;
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: text,
          redirect: "error",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(90000)]),
        });
        upstream.push({ status: response.status, bytes });
        if (!response.ok) {
          const detail = await response.text();
          writeFileSync(`${directory}/upstream-error-${attempts}.json`, detail, { mode: 0o600 });
          return new Response(detail, { status: response.status, headers: response.headers });
        }
        return response;
      },
    });
    env.MARINA_QUALIFICATION_KEY = token;
    args = [
      "codex",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'model_provider="qualification"',
      "-c",
      'model_providers.qualification.name="Qualification"',
      "-c",
      `model_providers.qualification.base_url="http://127.0.0.1:${gate.port}/v1"`,
      "-c",
      'model_providers.qualification.wire_api="responses"',
      "-c",
      'model_providers.qualification.env_key="MARINA_QUALIFICATION_KEY"',
      "-c",
      'model_reasoning_effort="none"',
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.marina.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.marina.args=${JSON.stringify(mcpArgs)}`,
      "-c",
      "mcp_servers.marina.startup_timeout_sec=30",
      "-c",
      'mcp_servers.marina.default_tools_approval_mode="approve"',
      prompt,
    ];
    report.model = "gpt-5.6-luna";
  }
  const version = Bun.spawn([args[0]!, "--version"], { env, stdout: "pipe", stderr: "pipe" });
  report.version = (await new Response(version.stdout).text()).trim();
  await version.exited;
  const child = Bun.spawn(args, { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
  const start = performance.now();
  const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
  let stdout: string, stderr: string, exit: number;
  try {
    [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  writeFileSync(`${directory}/client.jsonl`, stdout, { mode: 0o600 });
  writeFileSync(`${directory}/client.stderr`, stderr, { mode: 0o600 });
  report.exit_code = exit;
  report.elapsed_ms = performance.now() - start;
  assert.equal(exit, 0, `Client failed: ${stderr.slice(-1500)}`);
  const checkpoint = await client.checkpoint(space, checkpointName);
  assert.equal(checkpoint.data.source_id, source.id);
  report.checkpoint = checkpoint;
  const patch = readFileSync(`${workspace}/${filename}`, "utf8");
  assert.notEqual(patch, seed, "The client must implement a file change");
  report.patch = patch;
  // Functional checks are outside the client workspace and supplied only after
  // completion. A new process imports the generated patch with a scrubbed env.
  const test = `${directory}/verify.ts`;
  writeFileSync(
    test,
    sdkTask
      ? `import {strict as assert} from 'node:assert'; import {createMemoryCitation, validateMemoryAnswer} from ${JSON.stringify(`${workspace}/${filename}`)};
const record={kind:'record',id:'r',space_id:'s',version:2,text:' Original α🙂 evidence ',freshness:'historical'} as const;
const source={kind:'source',id:'s',space_id:'s',text_hash:'hash',start:7,end:33,text:' Original α🙂 evidence '} as const;
const before=JSON.stringify([record,source]);
assert.deepEqual(createMemoryCitation(record,' α🙂 '),{kind:'record',id:'r',space_id:'s',version:2,quote:' α🙂 '});
assert.deepEqual(createMemoryCitation(source,'α🙂'),{kind:'source',id:'s',space_id:'s',text_hash:'hash',start:7,end:33,quote:'α🙂'});
for(const bad of ['', '   ', 'fabricated']) for(const row of [record,source]) assert.throws(()=>createMemoryCitation(row,bad),RangeError);
assert.equal(JSON.stringify([record,source]),before);
assert.equal(validateMemoryAnswer({schema:{type:'string'},evidence:'required'}, {status:'answered',answer:'yes',citations:[createMemoryCitation(source,'α🙂')]},[source]).ok,true);
console.log('10 SDK behavior checks passed');
`
      : `import {strict as assert} from 'node:assert';\nimport {parseRetryAfter} from ${JSON.stringify(`${workspace}/${filename}`)};\nconst now=Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');\nfor(const [value,expected] of [['120',120000],[' 2 ',2000],['0',0],['Wed, 21 Oct 2015 07:28:00 GMT',60000],['Wed, 21 Oct 2015 07:26:00 GMT',0],['nonsense',null],[null,null],[2,null],[{},null]]) assert.equal(parseRetryAfter(value,now),expected,String(value));\nconsole.log('9 functional cases passed');\n`,
  );
  const verify = Bun.spawn([process.execPath, test], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const verifyTimer = setTimeout(() => verify.kill("SIGKILL"), 5000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(verify.stdout).text(),
      new Response(verify.stderr).text(),
      verify.exited,
    ]);
    report.verification = { code, stdout: out, stderr: err };
    assert.equal(code, 0, err);
  } finally {
    clearTimeout(verifyTimer);
  }
  assert.ok(
    stdout.includes("memory_service") || stdout.includes("memory_search"),
    "Client log must contain an actual MCP operation",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Coding client qualification failed";
  process.exitCode = 1;
} finally {
  report.upstream = upstream;
  report.reserved_upper_bound_usd = values.client === "codex" ? reserved : null;
  report.upstream_attempts = attempts;
  report.limits = `${sdkTask ? "A disposable copy of Marina's answer module with its quotation helper removed; ten behavior checks." : "One disposable TypeScript parser module and nine functional cases."} Local MCP stdio service; no app-wide or large-repository claim. Claude uses its CLI budget limit; Codex uses a per-upstream-attempt conservative reservation. Generated code is executed on the host in a separate scrubbed process, not an OS sandbox.`;
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  gate?.stop(true);
  await memory.close();
  console.log(JSON.stringify(report));
}
