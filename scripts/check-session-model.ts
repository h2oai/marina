// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    jar: { type: "string" },
    java: { type: "string", default: "java" },
    output: { type: "string", default: "/tmp/marina-session-model" },
  },
  strict: true,
});
const output = resolve(values.output!);
await mkdir(output, { recursive: true });
// Official stable release asset. `v1.8.0` is a rolling pre-release whose jar is rebuilt in place,
// so pinning its checksum breaks whenever upstream republishes; stable releases do not change.
const url = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const sha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const jar = resolve(values.jar ?? `${output}/tla2tools.jar`);
if (!values.jar) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `TLC download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, "TLC release checksum");
  await writeFile(jar, bytes);
}
assert.equal(
  createHash("sha256")
    .update(await readFile(jar))
    .digest("hex"),
  sha256,
  "TLC checksum",
);
const source = await readFile(new URL("../specs/McpSession.tla", import.meta.url), "utf8");
const config = await readFile(new URL("../specs/McpSession.cfg", import.meta.url), "utf8");
const variants = [
  ["normal", undefined, undefined],
  ["session-capacity", undefined, undefined],
  ["early-release", "EarlyRelease", "SlotsOwned"],
  ["stale-identity", "SkipIdentity", "AuthorizedStart"],
  ["out-of-order", "SkipFifo", "FIFO"],
  ["cancelled-write", "SkipCancellation", "AuthorizedStart"],
] as const;
const results = [];
for (const [name, fault, invariant] of variants) {
  const directory = `${output}/${name}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/McpSession.tla`, source);
  const boundedConfig =
    name === "session-capacity"
      ? config
          .replace("Sessions = {s1, s2}", "Sessions = {s1}")
          .replace("RequestCount = 2", "RequestCount = 3")
          .replace("GlobalLimit = 2", "GlobalLimit = 3")
      : config;
  await writeFile(
    `${directory}/McpSession.cfg`,
    fault ? boundedConfig.replace(`${fault} = FALSE`, `${fault} = TRUE`) : boundedConfig,
  );
  const child = Bun.spawn(
    [
      values.java!,
      "-XX:+UseParallelGC",
      "-Xmx1g",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "2",
      "-config",
      "McpSession.cfg",
      "McpSession.tla",
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const log = stdout + stderr;
  await writeFile(`${directory}/tlc.log`, log);
  if (fault) {
    assert.notEqual(code, 0, `${name}: broken model unexpectedly passed`);
    assert(
      log.includes(`Invariant ${invariant} is violated`),
      `${name}: expected ${invariant}, see ${directory}/tlc.log`,
    );
  } else {
    assert.equal(code, 0, `TLC failed: see ${directory}/tlc.log`);
    assert(log.includes("Model checking completed. No error has been found."));
  }
  const states = log.match(/(\d+) distinct states found/g)?.at(-1);
  results.push({ name, expected: invariant ?? "all invariants hold", states, passed: true });
  console.log(`${name}: ${invariant ? `counterexample for ${invariant} detected` : states}`);
}
await writeFile(
  `${output}/report.json`,
  JSON.stringify({ checker: "TLC 1.7.4", sha256, results }, null, 2),
);
