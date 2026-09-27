// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sdk = join(root, "src/sdk");
rmSync(join(sdk, "dist"), { recursive: true, force: true });
mkdirSync(join(sdk, "dist"), { recursive: true });
const types = Bun.spawn(["bun", "x", "--no-install", "tsc", "-p", join(sdk, "tsconfig.json")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await types.exited) !== 0) process.exit(1);
// NodeNext consumers require explicit JS extensions, even for declaration imports.
for (const file of readdirSync(join(sdk, "dist"))) {
  if (!file.endsWith(".d.ts")) continue;
  const path = join(sdk, "dist", file);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      /(["'])(\.\/[^"']+)(["'])/g,
      (_match, quote, specifier, end) =>
        `${quote}${specifier.endsWith(".js") ? specifier : `${specifier}.js`}${end}`,
    ),
  );
}
for (const name of ["index", "routing-client", "memory"]) {
  const result = await Bun.build({
    entrypoints: [join(sdk, `${name}.ts`)],
    target: "browser",
    format: "esm",
    outdir: join(sdk, "dist"),
    naming: `${name}.js`,
  });
  if (!result.success) throw new AggregateError(result.logs, `SDK build failed: ${name}`);
}
