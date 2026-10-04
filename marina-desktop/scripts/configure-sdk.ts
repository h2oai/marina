// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** TS 7 removed baseUrl. Derive relative paths from the verified v2 export map,
 * leaving Hutch's generated devkit untouched. Bun uses these aliases for tests. */
export function sdkPaths(exports: Record<string, unknown>): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const root = resolve("devkit");
  const api = resolve(root, "api");
  for (const [key, value] of Object.entries(exports)) {
    if (
      (key !== "." && !key.startsWith("./")) ||
      typeof value !== "string" ||
      !value.startsWith("./api/")
    )
      throw new Error(`Invalid Electrobun SDK export: ${key}`);
    const child = relative(api, resolve(root, value));
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`Electrobun SDK export escapes api/: ${key}`);
    paths[key === "." ? "electrobun" : `electrobun/${key.slice(2)}`] = [
      `./devkit/${value.slice(2)}`,
    ];
  }
  return paths;
}

export function configureSdk(directory = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const manifestPath = resolve(directory, ".hutch/devkit/package.json");
  if (!existsSync(manifestPath))
    throw new Error("Electrobun SDK missing. Run `bun run sync` in marina-desktop first.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  if (manifest.version !== pkg.devDependencies.electrobun)
    throw new Error("Electrobun SDK is stale. Run `bun run sync` in marina-desktop.");
  const config = { compilerOptions: { paths: sdkPaths(manifest.exports) } };
  writeFileSync(
    resolve(directory, ".hutch/tsconfig.sdk.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

if (import.meta.main) configureSdk();
