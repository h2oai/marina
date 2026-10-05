// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared fixtures for the extension's own checks (run with `bun run check`). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLearnedKeyPair, type PinnedKey } from "../../../src/learned/sign";
import { keyIdOfPublicKey } from "../../../src/net/federation-crypto";
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

/** A fresh publisher key (base64 PKCS#8 DER, the core learned-bundle format) and its pin. */
export function publisherKey(label = "acme"): { key: string; pinned: PinnedKey } {
  const { privateKey, publicKey } = generateLearnedKeyPair();
  return { key: privateKey, pinned: { label, publicKey, keyId: keyIdOfPublicKey(publicKey) } };
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

/** A small but complete world payload. */
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
    join(dir, "conventions.jsonl"),
    `${JSON.stringify({ id: "c1", pool: "guide", text: "Check the citation before trusting a claim." })}\n`,
  );
  writeFileSync(
    join(dir, "contributions.jsonl"),
    `${JSON.stringify({
      item_id: "c1",
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
    description: "Lab world with a paid curated tier",
    version: "1.2.0",
    generation: 3,
    publisher: { name: "acme" },
    tiers: [
      { id: "tier:core", access: "open", include: ["world/world.json"] },
      {
        id: "tier:standard",
        access: "token",
        include: ["world/", "roles/", "conventions.jsonl"],
      },
    ],
    ...overrides,
  };
}

export const UPSTREAM_ON = { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv;
