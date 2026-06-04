import { unlinkSync } from "node:fs";
import { grant, listGates } from "../src/engine/safety-gates";
import type { MarinaDB } from "../src/persistence/database";
import type { Connection, EntityId, Perception, RoomModule } from "../src/types";

/** Strip ANSI escape codes from a string. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control chars
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Canonical test room factory. */
export function makeTestRoom(overrides?: Partial<RoomModule>): RoomModule {
  return {
    short: "Test Room",
    long: "A plain room for testing.",
    exits: {},
    ...overrides,
  };
}

/** Remove a SQLite database and its WAL/SHM sidecar files. */
export function cleanupDb(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
  try {
    unlinkSync(`${path}-wal`);
  } catch {}
  try {
    unlinkSync(`${path}-shm`);
  } catch {}
}

/**
 * Test convenience: grant every safety gate to an entity so tests that
 * exercise high-tier commands (shell, admin, key, gateway, etc.) don't
 * have to seed standing + demonstrations. The production path is
 * `safetyGates.grant(db, entityId, gateId)` per gate, called from world
 * seeds for the bootstrap operator.
 */
export function grantAllGates(db: MarinaDB, entityId: string): void {
  for (const gate of listGates()) {
    grant(db, entityId, gate);
  }
}

/** Mock connection for testing engine interactions. */
export class MockConnection implements Connection {
  id: string;
  protocol = "websocket" as const;
  entity: EntityId | null = null;
  connectedAt = Date.now();
  messages: Perception[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(perception: Perception): void {
    this.messages.push(perception);
  }

  close(): void {}

  lastText(): string {
    const last = this.messages[this.messages.length - 1];
    return (last?.data?.text as string) ?? "";
  }

  /** All received text messages as an array. */
  allText(): string[] {
    return this.messages.map((m) => (m.data?.text as string) ?? "");
  }

  /** All received text messages joined with newlines. */
  allTextJoined(): string {
    return this.messages.map((m) => (m.data?.text as string) ?? "").join("\n");
  }

  clear(): void {
    this.messages = [];
  }
}
