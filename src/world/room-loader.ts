// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import type { Engine } from "../engine/engine";
import type { RoomId, RoomModule } from "../types";

const DEFAULT_ROOMS_DIR = join(import.meta.dir, "../../rooms");

/**
 * Scan a rooms directory and import each .ts file as a RoomModule.
 * Room ID is derived from the file path relative to the dir, minus the extension.
 * e.g. rooms/hub/crossroads.ts → "hub/crossroads"
 * Gracefully skips if the directory does not exist.
 */
export async function loadRooms(engine: Engine, roomsDir?: string): Promise<void> {
  const dir = roomsDir ?? DEFAULT_ROOMS_DIR;
  if (!existsSync(dir)) return;
  const glob = new Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    // Skip files starting with underscore
    const basename = file.split("/").pop() ?? "";
    if (basename.startsWith("_")) continue;

    const rel = relative(dir, file).replace(/\.ts$/, "");
    const id = rel as RoomId;

    try {
      const mod = await import(file);
      const room: RoomModule = mod.default ?? mod;

      if (!room.short || !room.long) {
        console.warn(`[rooms] Skipping ${rel}: missing short or long`);
        continue;
      }

      engine.registerRoom(id, room);
    } catch (err) {
      console.error(`[rooms] Failed to load room ${rel}:`, err);
    }
  }
}
