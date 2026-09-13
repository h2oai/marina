// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Live sockets, persistent restart, and paired fresh agents. Write reports only
 * outside the public checkout. No secrets or databases belong in evidence archives. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveMemory } from "../../src/memory/server";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import { expandMemoryQuery, type MemoryQueryVocabulary } from "../../src/sdk/memory-expansion";
import { createLiveMemoryRuntime } from "./memory-live-runtime";
import { snapshotMemoryQualification } from "./memory-qualification-sources";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    directory: { type: "string" },
    "budget-usd": { type: "string" },
  },
});
if (!values.directory)
  throw new Error("Use --directory outside the public checkout --budget-usd 0..20");
const directory = resolve(values.directory);
if (directory === process.cwd() || directory.startsWith(`${process.cwd()}/`))
  throw new Error("Reports belong outside the public checkout");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = {
  schema: "marina.memory.extensions.v1",
  started_at: new Date().toISOString(),
  passed: false,
  source_hashes: snapshotMemoryQualification(directory),
  limits:
    "Bounded functional qualification; clean restarts, not power loss. Four task pairs, one model, one run per condition; no statistical superiority claim. Vocabulary is caller-authored and only changes search dispatch. No embedding provider configured or invoked in this run.",
};
const publish = () =>
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
const runtime = createLiveMemoryRuntime(directory, Number(values["budget-usd"]));
let peer = serveMemory({ dbPath: `${directory}/peer.db`, port: 0 });
try {
  const local = runtime.client;
  const owner = peer.db.ensurePrincipal({ type: "service", displayName: "peer" }).principal_id;
  const peerToken = peer.db.issueMemoryCredential(owner).token;
  let remote = new MarinaMemoryClient(`http://127.0.0.1:${peer.server.port}`, peerToken);
  const sourceSpace = (await remote.createSpace("transfer-origin")).id;
  const text = "Portable original α🙂\n".repeat(35000);
  const source = await remote.capture(sourceSpace, text);
  const record = await remote.remember(sourceSpace, {
    content: "Authored cargo answer",
    source_ids: [source.id],
  });
  const target = (await local.createSpace("transfer-target")).id;
  const page = await remote.exportTransferPage(sourceSpace);
  const transfer = await local.beginTransfer(target, page.header);
  let staged = await local.appendTransfer(target, transfer.id, page, "first-page");
  assert.equal((await local.query(target)).results.length, 0);
  // Close/reopen the importer with exactly its persisted credentials and state.
  const importPort = runtime.memory.server.port;
  await runtime.memory.close();
  const importer = serveMemory({ dbPath: `${directory}/memory.db`, port: importPort });
  // Runtime close must target the reopened handle; the old handle is already closed.
  runtime.memory.close = () => importer.close();
  const restored = await local.transferStatus(target, transfer.id);
  for (const key of Object.keys(restored) as (keyof typeof restored)[])
    assert.deepEqual(restored[key], staged[key]);
  assert.deepEqual(await local.appendTransfer(target, transfer.id, page, "first-page"), staged);
  let cursor = page.next_cursor,
    pages = 1;
  while (cursor) {
    const next = await remote.exportTransferPage(sourceSpace, cursor);
    staged = await local.appendTransfer(target, transfer.id, next);
    cursor = next.next_cursor;
    pages++;
  }
  await local.commitTransfer(target, transfer.id, staged.sha256!, "commit");
  let start = 0,
    recovered = "";
  while (true) {
    const range = await local.sourceRange(target, source.id, { start });
    recovered += range.text;
    if (range.next_start === null) break;
    start = range.next_start;
  }
  assert.equal(recovered, text);
  assert.equal((await local.get(target, record.id)).content, "Authored cargo answer");
  report.transfer = {
    pages,
    bytes: Buffer.byteLength(text),
    restarted_importer: true,
    exact_source: true,
    id_preserved: true,
    receipt_replayed: true,
  };

  const reader = peer.db.ensurePrincipal({ type: "service", displayName: "reader" }).principal_id;
  const readerToken = peer.db.issueMemoryCredential(reader).token;
  await remote.grant(sourceSpace, reader, "reader");
  const mounted = new MarinaMemoryClient(remote.url, readerToken, 1000);
  importer.service.federation.mount(runtime.credential.principalId, "peer", mounted, sourceSpace);
  const cacheSpace = (await local.createSpace("cache")).id;
  const input = {
    inputs: { question: "cargo" },
    model: "caller",
    policy: "v1",
    value: { answer: "Authored cargo answer" },
    expires_at: Date.now() + 600000,
    federated: [
      { kind: "record" as const, mount: "peer", space_id: sourceSpace, id: record.id, version: 1 },
    ],
  };
  await local.cachePut(cacheSpace, input, "cache");
  assert.equal((await local.cacheGet(cacheSpace, input)).hit, true);
  const peerPort = peer.server.port;
  await peer.close();
  assert.equal((await local.cacheGet(cacheSpace, input)).hit, false);
  await local.cachePut(cacheSpace, input, "cache");
  peer = serveMemory({ dbPath: `${directory}/peer.db`, port: peerPort });
  remote = new MarinaMemoryClient(mounted.url, peerToken);
  assert.equal((await local.cacheGet(cacheSpace, input)).hit, true);
  await remote.grant(sourceSpace, reader, null);
  assert.equal((await local.cacheGet(cacheSpace, input)).hit, false);
  await remote.grant(sourceSpace, reader, "reader");
  // Grant changes also invalidate the peer generation; repin explicitly.
  await local.cachePut(cacheSpace, input, "repin");
  await remote.revise(sourceSpace, record.id, 1, {
    content: "Corrected cargo answer",
    source_ids: [source.id],
  });
  assert.equal((await local.cacheGet(cacheSpace, input)).hit, false);
  report.cache = {
    live_hit: true,
    outage_miss: true,
    restart_hit: true,
    revoked_grant_miss: true,
    revised_record_miss: true,
    outage_receipt_replay: true,
  };
  publish();

  const vocabulary: MemoryQueryVocabulary = {
    policy: "qualification-glossary:v1",
    rules: [
      { term: "shipping", alternatives: ["dispatch"] },
      { term: "recovery", alternatives: ["recuperación"] },
      { term: "bill", alternatives: ["invoice"] },
    ],
  };
  const nonce = crypto.randomUUID().slice(0, 8);
  const tasks = [
    {
      query: "shipping",
      source: `Dispatch release label: D-${nonce}.`,
      expected: `D-${nonce}`,
      task: "What is the shipping release label?",
    },
    {
      query: "recovery",
      source: `La etiqueta de recuperación aprobada es R-${nonce}.`,
      expected: `R-${nonce}`,
      task: "What is the approved recovery label?",
    },
    {
      query: "bill",
      source: `Invoice remittance label: I-${nonce}.`,
      expected: `I-${nonce}`,
      task: "What is the bill remittance label?",
    },
    {
      query: "license",
      source: "Instrument catalog. No license serial has been recorded.",
      expected: null,
      task: "What is the license serial? Abstain if it has not been recorded.",
    },
  ];
  const rows: unknown[] = [],
    retrieval: unknown[] = [];
  report.agents = rows;
  report.retrieval = retrieval;
  report.vocabulary = vocabulary;
  for (const [index, task] of tasks.entries()) {
    const space = (await local.createSpace(`case-${index}`)).id;
    const source = await local.capture(space, task.source);
    await local.remember(space, { content: task.source, source_ids: [source.id] });
    for (const condition of index % 2 ? ["expanded", "lexical"] : ["lexical", "expanded"]) {
      const query =
        condition === "expanded"
          ? expandMemoryQuery(task.query, vocabulary)
          : { query: task.query };
      const [sources, records] = await Promise.all([
        local.sourceSearch(space, query),
        local.search(space, query),
      ]);
      retrieval.push({ case: index, condition, sources, records });
      const result = await runtime.run(
        {
          task: `${task.task} Return {label:string} when answerable.`,
          contract: {
            schema: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              additionalProperties: false,
            },
            evidence: "required",
          },
          instructions:
            "Use source_search with input {query:string,match:'any',limit:5} to discover evidence, then source_range with id and input {start:0}. Read original sources before answering. Search excerpts are not citations.",
          operations: ["source_search", "source_range"],
          maxTurns: 12,
          ...(condition === "expanded" ? { expansionVocabulary: vocabulary } : {}),
        },
        space,
      );
      const correct =
        task.expected === null
          ? result.status === "abstained"
          : result.completion?.status === "answered" &&
            (result.completion.answer as { label?: string })?.label === task.expected;
      rows.push({
        case: index,
        condition,
        source: task.source,
        expected: task.expected,
        correct,
        result,
      });
      publish();
      console.error(
        `case=${index} condition=${condition} correct=${correct} turns=${result.turns}`,
      );
    }
  }
  const expanded = rows as { condition: string; correct: boolean }[];
  assert.ok(
    expanded.filter((row) => row.condition === "expanded").every((row) => row.correct),
    "Expanded agent tasks did not all pass",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Qualification failed";
  process.exitCode = 1;
} finally {
  report.spending = runtime.spending;
  report.finished_at = new Date().toISOString();
  publish();
  await peer.close();
  await runtime.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      report: `${directory}/report.json`,
    }),
  );
}
