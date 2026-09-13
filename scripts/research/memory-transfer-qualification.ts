// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveMemory } from "../../src/memory/server";
import { MarinaMemoryClient } from "../../src/sdk/memory-client";
import { snapshotMemoryQualification } from "./memory-qualification-sources";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Supply an output directory outside the public repository");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sources = snapshotMemoryQualification(directory);
const source = serveMemory({ dbPath: `${directory}/source.db`, port: 0 });
let destination = serveMemory({ dbPath: `${directory}/destination.db`, port: 0 });
const identity = async (runtime: ReturnType<typeof serveMemory>, name: string) => {
  const token = runtime.db.issueMemoryCredential(
    runtime.db.ensurePrincipal({ type: "service", displayName: name }).principal_id,
  ).token;
  const client = new MarinaMemoryClient(`http://127.0.0.1:${runtime.server.port}`, token),
    space = (await client.createSpace(name)).id;
  writeFileSync(
    `${directory}/${name}-credentials.json`,
    JSON.stringify({ token, spaceId: space }),
    { mode: 0o600 },
  );
  return { client, space, token };
};
const src = await identity(source, "source"),
  dst = await identity(destination, "destination");
const cli = async (command: string, ...args: string[]) => {
  const process = Bun.spawn(
    [
      Bun.argv[0]!,
      resolve("scripts/memory.ts"),
      command,
      "--url",
      `http://127.0.0.1:${destination.server.port}`,
      "--credentials",
      `${directory}/destination-credentials.json`,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", env: { PATH: globalThis.process.env.PATH ?? "" } },
  );
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  assert.equal(code, 0, err);
  return JSON.parse(out);
};
try {
  const text = "CLI original α🙂 evidence. ".repeat(35000),
    saved = await src.client.capture(src.space, text);
  const first = await src.client.exportTransferPage(src.space),
    started = await dst.client.beginTransfer(dst.space, first.header);
  await dst.client.appendTransfer(dst.space, started.id, first);
  await destination.close();
  destination = serveMemory({ dbPath: `${directory}/destination.db`, port: 0 });
  const discovered = await cli("transfer-list", "--state", "receiving");
  assert.equal(discovered.transfers.length, 1);
  const id = discovered.transfers[0].id;
  assert.equal((await cli("transfer-status", "--transfer", id)).position, first.fragments.length);
  const resumed = await cli(
    "transfer-resume",
    "--transfer",
    id,
    "--source-url",
    src.client.url,
    "--source-credentials",
    `${directory}/source-credentials.json`,
  );
  assert.equal(resumed.state, "committed");
  const client = new MarinaMemoryClient(`http://127.0.0.1:${destination.server.port}`, dst.token);
  const headers = await client.sourceHeaders(dst.space);
  assert.equal(headers.sources.length, 1);
  assert(!Object.hasOwn(headers.sources[0]!, "body"));
  let observed = "",
    start = 0;
  for (;;) {
    const range = await client.sourceRange(dst.space, saved.id, { start });
    observed += range.text;
    if (range.next_start === null) break;
    start = range.next_start;
  }
  assert.equal(observed, text);
  const cleanupSpace=(await client.createSpace("abandoned")).id;
  const abandoned = await client.beginTransfer(cleanupSpace, first.header);
  await cli("transfer-abort", "--space",cleanupSpace,"--transfer", abandoned.id);
  assert.equal((await cli("transfer-status", "--space",cleanupSpace,"--transfer", abandoned.id)).state, "aborted");
  const report = {
    passed: true,
    bytes: Buffer.byteLength(text),
    checks: [
      "CLI lost-ID discovery",
      "restart status",
      "resumable publication",
      "metadata-only source listing",
      "exact UTF-8 source ranges",
      "explicit CLI abort",
    ],
    sources,
  };
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, bytes: report.bytes }));
} finally {
  await destination.close();
  await source.close();
}
