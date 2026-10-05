// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared fixtures for the extension's own checks (run with `bun run check`). */

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PinnedKey } from "../src/envelope";
import type { WorldPublishSpec } from "../src/world";

const dirs: string[] = [];
export function tempDir(prefix = "marina-market-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export function cleanupTemp(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function publisherKey(name = "acme"): { pem: string; pinned: PinnedKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    pinned: {
      name,
      public_key: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
    },
  };
}

export const ROLE_BUNDLE = {
  v: 1,
  role: {
    name: "lab-scout",
    description: "Scouts the lab",
    traits: ["curious"],
    guidelines: ["Cite sources"],
    focus: ["research"],
    tone: "plain",
    origin: "fixture",
  },
  traits: [{ name: "curious", category: "cognition", prompt: "Ask why.", capabilities: {} }],
};

/** Write a small but complete world payload: core (open) + standard (paid) tiers. */
export function writeWorldPayload(dir: string, opts: { roomCode?: boolean } = {}): void {
  mkdirSync(join(dir, "world/rooms"), { recursive: true });
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(
    join(dir, "world/world.json"),
    JSON.stringify({
      name: "Research Lab",
      description: "A small lab world.",
      start_room: "lab/lobby",
      rooms: [
        { id: "lab/lobby", short: "Lobby", long: "A quiet lobby.", exits: { north: "lab/bench" } },
        { id: "lab/bench", short: "Bench", exits: { south: "lab/lobby" } },
      ],
      guide_notes: [{ content: "Start at the bench.", importance: 5, type: "guide" }],
    }),
  );
  if (opts.roomCode)
    writeFileSync(join(dir, "world/rooms/bench.ts"), "export default { short: 'Bench' };\n");
  writeFileSync(join(dir, "roles/lab-scout.json"), JSON.stringify(ROLE_BUNDLE));
  writeFileSync(
    join(dir, "lessons.jsonl"),
    `${JSON.stringify({ item_key: "l1", text: "Check the citation before trusting a claim." })}\n`,
  );
  writeFileSync(
    join(dir, "contributions.jsonl"),
    `${JSON.stringify({
      item_key: "l1",
      participants: [
        { id: "pseud:agent-7", kind: "agent", role: "author", weight: 0.7, method: "provenance" },
        { id: "anon:judge", kind: "model", role: "judge", weight: 0.3, method: "provenance" },
      ],
    })}\n`,
  );
}

export function publishSpec(overrides: Partial<WorldPublishSpec> = {}): WorldPublishSpec {
  return {
    name: "research-lab",
    description: "Lab world with a paid curated memory tier",
    version: "1.2.0",
    generation: 3,
    publisher: { name: "acme" },
    tiers: [
      { id: "core", access: "open", include: ["world/", "roles/"] },
      { id: "standard", access: "token", include: ["lessons.jsonl", "contributions.jsonl"] },
    ],
    ...overrides,
  };
}
