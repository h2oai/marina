import { existsSync } from "node:fs";
import { relative } from "node:path";
import { Glob } from "bun";
import type { Engine } from "../../../src/engine/engine";
import type { RoomId, RoomModule } from "../../../src/types";

/**
 * Load room modules from a configurable directory.
 * Same glob+import logic as src/world/room-loader.ts but takes roomsDir
 * as a parameter instead of hardcoding the path.
 *
 * Room ID is derived from the file path relative to roomsDir, minus .ts.
 * e.g. {roomsDir}/world/2-2.ts → "world/2-2"
 * Gracefully skips if the directory does not exist.
 */
export async function loadRooms(engine: Engine, roomsDir: string): Promise<void> {
  if (!existsSync(roomsDir)) return;
  const glob = new Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: roomsDir, absolute: true })) {
    // Skip files starting with underscore
    const basename = file.split("/").pop() ?? "";
    if (basename.startsWith("_")) continue;

    const rel = relative(roomsDir, file).replace(/\.ts$/, "");
    const id = rel as RoomId;

    try {
      const mod = await import(file);
      const room: RoomModule = mod.default ?? mod;

      if (!room.short || !room.long) {
        console.warn(`[desktop] Skipping ${rel}: missing short or long`);
        continue;
      }

      engine.registerRoom(id, room);
    } catch (err) {
      console.error(`[desktop] Failed to load room ${rel}:`, err);
    }
  }
}
