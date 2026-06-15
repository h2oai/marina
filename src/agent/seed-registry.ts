/**
 * Seeded-entity disable registry.
 *
 * Marina re-seeds its system entities on every boot — persistent agent configs
 * (Chronicler, the Answerer/orchestration crews) and lazy room-agent hosts
 * (Meridian, Oracle, the evolve/demos NPCs). Without a durable opt-out, stopping
 * or deleting one only lasts until the next reseed (agents) or room entry (room
 * agents), so it always comes back.
 *
 * This is the single source of truth for "an operator retired this entity."
 * Every seeder, the autorespawn init, and the room-agent spawn path consult
 * `isSeedDisabled` before (re)creating an entity, so a disable sticks across
 * reboots and room entries uniformly.
 *
 * Markers live in `app_settings` under `seed.disabled.<name>` (no migration).
 * `MARINA_DISABLED_AGENTS` is a declarative env overlay for ops — names listed
 * there are disabled regardless of the DB.
 */

import type { MarinaDB } from "../persistence/database";

const PREFIX = "seed.disabled.";

/** Names disabled via the `MARINA_DISABLED_AGENTS` env (comma-separated). */
function envDisabled(): Set<string> {
  const raw = process.env.MARINA_DISABLED_AGENTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True if `name` has been retired (env overlay or persisted marker). */
export function isSeedDisabled(db: MarinaDB | undefined, name: string): boolean {
  if (envDisabled().has(name)) return true;
  return db?.getSetting(`${PREFIX}${name}`) === "1";
}

/** Persist (or clear) a disable marker for `name`. */
export function setSeedDisabled(db: MarinaDB, name: string, disabled: boolean): void {
  if (disabled) db.setSetting(`${PREFIX}${name}`, "1");
  else db.deleteSetting(`${PREFIX}${name}`);
}

/** All currently-disabled names (persisted markers ∪ env overlay), sorted. */
export function listDisabledSeedAgents(db: MarinaDB | undefined): string[] {
  const names = envDisabled();
  if (db) {
    for (const { key, value } of db.listSettingsByPrefix(PREFIX)) {
      if (value === "1") names.add(key.slice(PREFIX.length));
    }
  }
  return [...names].sort();
}
