#!/usr/bin/env bun
/**
 * One-time generator: creates 24 non-center grid room files under worlds/default/world/.
 * The center room (2-2) is hand-written separately with Guide NPC logic.
 *
 * Usage: bun run scripts/generate-grid-rooms.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIZE = 5;
const DIR = join(import.meta.dir, "../worlds/default/world");

if (!existsSync(DIR)) {
  mkdirSync(DIR, { recursive: true });
}

function describeEdges(row: number, col: number): string {
  const edges: string[] = [];
  if (row === 0) edges.push("north");
  if (row === SIZE - 1) edges.push("south");
  if (col === 0) edges.push("west");
  if (col === SIZE - 1) edges.push("east");
  if (edges.length === 0) return "Open ground in every direction.";
  return `The ${edges.join(" and ")} edge of the world lies here.`;
}

let created = 0;

for (let r = 0; r < SIZE; r++) {
  for (let c = 0; c < SIZE; c++) {
    // Skip center — hand-written with Guide NPC
    if (r === 2 && c === 2) continue;

    const filename = `${r}-${c}.ts`;
    const filepath = join(DIR, filename);

    if (existsSync(filepath)) {
      console.log(`  skip ${filename} (exists)`);
      continue;
    }

    const exits: string[] = [];
    if (r > 0) exits.push(`    north: "world/${r - 1}-${c}" as RoomId,`);
    if (r < SIZE - 1) exits.push(`    south: "world/${r + 1}-${c}" as RoomId,`);
    if (c < SIZE - 1) exits.push(`    east: "world/${r}-${c + 1}" as RoomId,`);
    if (c > 0) exits.push(`    west: "world/${r}-${c - 1}" as RoomId,`);

    const source = `import type { RoomId, RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "Sector ${r}-${c}",
  long: "An empty sector at coordinates (${r}, ${c}). ${describeEdges(r, c)}",
  exits: {
${exits.join("\n")}
  },
};

export default room;
`;

    writeFileSync(filepath, source);
    created++;
    console.log(`  wrote ${filename}`);
  }
}

console.log(`\nDone: ${created} room files created in worlds/default/world/`);
