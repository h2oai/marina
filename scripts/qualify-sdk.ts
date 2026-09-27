// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
async function run(argv: string[], cwd: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0)
    throw new Error(`SDK qualification failed: ${argv[0]} ${argv[1]}`);
}
await run(["bun", "run", "build:sdk"], root);
const directory = mkdtempSync(join(tmpdir(), "marina-sdk-consumer-"));
try {
  await run(
    [
      "npm",
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      directory,
      "--cache",
      join(directory, "cache"),
    ],
    join(root, "src/sdk"),
  );
  const archive = readdirSync(directory).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("SDK tarball was not produced");
  const installed = join(directory, "node_modules/@marina/agent-sdk");
  mkdirSync(installed, { recursive: true });
  await run(
    ["tar", "-xzf", join(directory, archive), "--strip-components=1", "-C", installed],
    directory,
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const consumer = `
import { MarinaAgent, MarinaClient, compileCommandForms, composeCommand, commandInputSchema } from "@marina/agent-sdk";
import { MarinaMemoryClient } from "@marina/agent-sdk/memory";
import { MarinaRoutingClient } from "@marina/agent-sdk/routing";
const memory = new MarinaMemoryClient("http://fixture.invalid", "fixture-token", 1000, async (req) => {
  if (req.headers.get("authorization") !== "Bearer fixture-token") throw new Error("Missing credential");
  return Response.json({ id: "record-1", content: "portable", version: 1 });
});
const record = await memory.get("space-1", "record-1");
if (record.content !== "portable") throw new Error("Memory response mismatch");
if (![MarinaAgent, MarinaClient, MarinaRoutingClient].every(x => typeof x === "function")) throw new Error("Missing exports");
const [form] = compileCommandForms([{ syntax: "sample <count>", fields: { count: { kind: "number", min: 1, max: 4 } } }]);
if (!form) throw new Error("Missing command form");
if (JSON.stringify(form.inputSchema) !== JSON.stringify(commandInputSchema(form))) throw new Error("Schema drift");
if (composeCommand(form, { "field-0": "3" }, {}).command !== "sample 3") throw new Error("Portable composition failed");
if (!composeCommand(form, { "field-0": "5" }, {}).errors["field-0"]) throw new Error("Missing input validation");
console.log("Packed SDK consumer passed");
`;
  writeFileSync(join(directory, "consumer.mjs"), consumer);
  writeFileSync(join(directory, "consumer.mts"), consumer);
  await run(["bun", "consumer.mjs"], directory);
  await run(["node", "consumer.mjs"], directory);
  await run(
    [
      "bun",
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--lib",
      "ES2022,DOM,DOM.Iterable",
      "consumer.mts",
    ],
    directory,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
