// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { WORLDS } from "../src/bun/worlds";

/** Bundle only external room directories. World definitions and seeds already
 * belong to the main bundle; copying their sources loses server dependencies. */
export async function prepareRooms(project: string): Promise<void> {
  const output = join(project, "dist/rooms");
  // Rebuild this generated directory so a deleted room cannot ship from cache.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const directories = new Set(
    Object.values(WORLDS)
      .map((world) => world.roomsDir)
      .filter((dir): dir is string => !!dir),
  );
  for (const directory of directories) {
    const entrypoints = [
      ...new Bun.Glob("**/*.ts").scanSync({ cwd: directory, absolute: true }),
    ].filter((file) => !basename(file).startsWith("_"));
    if (!entrypoints.length) throw new Error(`No room modules found in ${directory}`);
    const result = await Bun.build({
      entrypoints,
      root: directory,
      outdir: join(project, "dist/rooms", basename(directory)),
      target: "bun",
      splitting: true,
      naming: { entry: "[dir]/[name].js", chunk: "_shared-[hash].js" },
    });
    if (!result.success)
      throw new AggregateError(result.logs, `Could not bundle rooms in ${directory}`);
  }
}
