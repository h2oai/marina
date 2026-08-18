#!/usr/bin/env bun
// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prune leftover `users` rows left behind by agents.
 *
 * Every login — including internal agents — creates a row in the `users`
 * table (it doubles as the "already onboarded this name" marker). When an
 * agent is removed, disabled, or a crew count is reduced, its `users` row
 * lingers and shows up in the user list. This prunes those orphaned rows.
 *
 * SAFETY: a row with a verified auth identity (auth_subject set) is a real
 * human and is NEVER deleted. A name that still has a live agent_config is an
 * active agent and is skipped (deleting it would just be recreated on next
 * login, losing its stored rank). Dry-run by default — pass --apply to delete.
 *
 * Usage (or via the `bun run prune-agent-users` alias):
 *   bun run prune-agent-users                      # list candidates (orphaned answerer-crew rows), dry-run
 *   bun run prune-agent-users --orphaned --apply   # delete orphaned answerer-crew rows
 *   bun run prune-agent-users Answerer2 Answerer3   # target explicit names (dry-run)
 *   bun run prune-agent-users Answerer2 --apply     # delete explicit names
 *   DB_PATH=/path/to/marina.db bun run prune-agent-users ...
 */
import { listDisabledSeedAgents } from "../src/agent/seed-registry";
import { MarinaDB } from "../src/persistence/database";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const names = args.filter((a) => !a.startsWith("--"));

const apply = flags.has("--apply");
const dbPath = process.env.DB_PATH ?? "marina.db";

/** Answerer-crew naming convention (mirrors worlds/seed.ts isAnswererCrewAgent),
 *  the canonical source of the leftover rows this script targets. */
function isAnswererCrewName(name: string): boolean {
  return /^Answerer\d*$/.test(name) || ["Mathematician", "Reflector", "Translator"].includes(name);
}

const db = new MarinaDB(dbPath);

const users = db.listUsers();
const configuredAgents = new Set(db.getAllAgentConfigs().map((c) => c.name));
const disabledAgents = new Set(listDisabledSeedAgents(db));

// Candidate selection:
//   - explicit names → exactly those rows
//   - otherwise → orphaned agent rows: answerer-crew-pattern OR disabled-seed
//     names that no longer have a live config.
const explicit = names.length > 0;
const candidates = users.filter((u) => {
  if (explicit) return names.includes(u.name);
  const looksLikeAgent = isAnswererCrewName(u.name) || disabledAgents.has(u.name);
  return looksLikeAgent && !configuredAgents.has(u.name);
});

const skipped: string[] = [];
const toDelete = candidates.filter((u) => {
  if (u.auth_subject) {
    skipped.push(`${u.name} — has a verified auth identity (human), never pruned`);
    return false;
  }
  if (configuredAgents.has(u.name)) {
    skipped.push(`${u.name} — still has a live agent_config (active agent), skipped`);
    return false;
  }
  return true;
});

console.log(`DB: ${dbPath}`);
console.log(`Mode: ${explicit ? `explicit (${names.join(", ")})` : "orphaned answerer-crew rows"}`);
console.log(`Users total: ${users.length}\n`);

if (skipped.length > 0) {
  console.log("Skipped (protected):");
  for (const s of skipped) console.log(`  - ${s}`);
  console.log("");
}

if (toDelete.length === 0) {
  console.log("No matching user rows to prune.");
  db.close();
  process.exit(0);
}

console.log(`${apply ? "Deleting" : "Would delete"} ${toDelete.length} user row(s):`);
for (const u of toDelete) {
  const last = new Date(u.last_login).toISOString().slice(0, 19);
  console.log(`  - ${u.name} (rank ${u.rank}, last login ${last})`);
}

if (apply) {
  for (const u of toDelete) db.deleteUser(u.id);
  console.log(`\nDeleted ${toDelete.length} row(s).`);
} else {
  console.log("\nDry run — re-run with --apply to delete.");
}

db.close();
