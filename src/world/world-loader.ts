// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MARINA_ROOT } from "../runtime-paths";
import type { WorldDefinition } from "./world-definition";

/** Builtin slug, explicit local path or already-installed npm package; never downloads code. */
export async function loadWorld(
  specifier: string,
  cwd = process.cwd(),
  builtinDirectory = resolve(MARINA_ROOT, "worlds"),
): Promise<WorldDefinition> {
  let entry: string;
  if (specifier.startsWith("npm:")) {
    const name = specifier.slice(4);
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(name))
      throw new Error("Expected a preinstalled npm package name");
    entry = Bun.resolveSync(name, cwd);
  } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
    entry = resolve(cwd, specifier);
    if (statSync(entry).isDirectory()) {
      const manifest = resolve(entry, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          marinaWorld?: string;
          main?: string;
        };
        entry = resolve(entry, pkg.marinaWorld ?? pkg.main ?? "index.ts");
      } else entry = resolve(entry, "index.ts");
    }
  } else {
    if (!/^[a-z][a-z0-9-]*$/.test(specifier)) throw new Error("Invalid builtin world name");
    entry = resolve(builtinDirectory, `${specifier}.ts`);
  }
  const module = await import(pathToFileURL(entry).href);
  const world = module.default as WorldDefinition;
  if (
    !world ||
    typeof world.name !== "string" ||
    !world.name.trim() ||
    typeof world.startRoom !== "string" ||
    !world.rooms ||
    Array.isArray(world.rooms) ||
    typeof world.rooms !== "object" ||
    !Array.isArray(world.quests) ||
    !Array.isArray(world.guideNotes)
  )
    throw new Error("Invalid WorldDefinition export");
  if (!world.rooms[world.startRoom] && !world.roomsDir)
    throw new Error("World startRoom is not defined");
  for (const [id, room] of Object.entries(world.rooms)) {
    // `long` may be a function of the viewer (RoomModule), as in craft, demos and markets.
    const long = typeof room?.long;
    if (
      !id ||
      !room ||
      typeof room.short !== "string" ||
      (long !== "string" && long !== "function")
    )
      throw new Error(`Invalid room: ${id}`);
  }
  return {
    ...world,
    ...(world.roomsDir ? { roomsDir: resolve(dirname(entry), world.roomsDir) } : {}),
  };
}
