// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
// Build @marina/agent-sdk and write an installable tarball to dist/sdk/ (no registry needed).
// Install it elsewhere with `bun add <path>.tgz`, `npm install <path>.tgz` or `pnpm add <path>.tgz`.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sdk from "../src/sdk/package.json";

const root = join(import.meta.dir, "..");
const destination = join(root, "dist", "sdk");
const tarball = join(destination, `marina-agent-sdk-${sdk.version}.tgz`);

async function run(argv: string[], cwd: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`SDK pack failed: ${argv.join(" ")}`);
}

await run(["bun", "run", "build:sdk"], root);
mkdirSync(destination, { recursive: true });
rmSync(tarball, { force: true });
const cache = mkdtempSync(join(tmpdir(), "marina-sdk-pack-cache-"));
try {
  await run(
    ["npm", "pack", "--ignore-scripts", "--pack-destination", destination, "--cache", cache],
    join(root, "src/sdk"),
  );
} finally {
  rmSync(cache, { recursive: true, force: true });
}
if (!(await Bun.file(tarball).exists()))
  throw new Error(`SDK tarball was not produced: ${tarball}`);
console.log(`SDK tarball: ${tarball}`);
