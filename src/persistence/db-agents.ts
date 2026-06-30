import type { Database } from "bun:sqlite";
import type { AgentSupports } from "../agent/agent-types";
import { MARINA_DEFAULT_MODEL } from "../engine/constants";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedValue,
  isKeyEncryptionEnabled,
} from "./key-crypto";

// ─── Settings (runtime key→value config) ────────────────────────────────

/** Read a runtime setting; undefined if unset. */
export function getSetting(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? undefined;
}

/** Write a runtime setting (upsert). */
export function setSetting(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  );
}

/** Delete a runtime setting (revert to its env/built-in default). */
export function deleteSetting(db: Database, key: string): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [key]);
}

/** All settings whose key starts with `prefix` (e.g. seed-disable markers). */
export function listSettingsByPrefix(
  db: Database,
  prefix: string,
): { key: string; value: string }[] {
  return db.query("SELECT key, value FROM app_settings WHERE key LIKE ?").all(`${prefix}%`) as {
    key: string;
    value: string;
  }[];
}

/**
 * The effective default model ("provider/model-id") for marina/default routing
 * and for agents spawned without an explicit model. Runtime DB setting wins over
 * the MARINA_DEFAULT_MODEL env value, which itself falls back to a built-in.
 */
export function getDefaultModel(db: Database): string {
  return getSetting(db, "default_model") ?? MARINA_DEFAULT_MODEL;
}

// ─── Trait / Role edit history (audit trail) ────────────────────────────

export interface EditHistoryRow {
  id: number;
  name: string;
  old_value: string;
  new_value: string;
  changed_by: string;
  changed_at: number;
}

/**
 * Append an audit entry for a trait/role edit — only when the serialized
 * definition actually changed, so re-seeding identical world definitions on
 * every boot doesn't spam history. `old` is "" for a first creation. The
 * `table` argument is a controlled literal union (never user input).
 */
function recordEditHistory(
  db: Database,
  table: "trait_history" | "role_history",
  name: string,
  changedBy: string,
  value: { old: string; new: string },
): void {
  if (value.old === value.new) return;
  db.run(
    `INSERT INTO ${table} (name, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)`,
    [name, value.old, value.new, changedBy, Date.now()],
  );
}

function getEditHistory(
  db: Database,
  table: "trait_history" | "role_history",
  name: string,
  limit = 10,
): EditHistoryRow[] {
  return db
    .query(`SELECT * FROM ${table} WHERE name = ? ORDER BY id DESC LIMIT ?`)
    .all(name, limit) as EditHistoryRow[];
}

/** Most-recent-first edit history for a trait. */
export function getTraitHistory(db: Database, name: string, limit = 10): EditHistoryRow[] {
  return getEditHistory(db, "trait_history", name, limit);
}

/** Most-recent-first edit history for a role. */
export function getRoleHistory(db: Database, name: string, limit = 10): EditHistoryRow[] {
  return getEditHistory(db, "role_history", name, limit);
}

// ─── Traits ─────────────────────────────────────────────────────────────

export function saveTrait(
  db: Database,
  opts: {
    name: string;
    category: string;
    prompt: string;
    capabilities?: TraitCapabilities;
    createdBy: string;
  },
): void {
  const newCapabilities = JSON.stringify(opts.capabilities ?? {});
  const previous = getTrait(db, opts.name);
  recordEditHistory(db, "trait_history", opts.name, opts.createdBy, {
    old: previous
      ? JSON.stringify({
          category: previous.category,
          prompt: previous.prompt,
          capabilities: previous.capabilities,
        })
      : "",
    new: JSON.stringify({
      category: opts.category,
      prompt: opts.prompt,
      capabilities: newCapabilities,
    }),
  });
  db.run(
    `INSERT OR REPLACE INTO traits (name, category, prompt, capabilities, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [opts.name, opts.category, opts.prompt, newCapabilities, opts.createdBy, Date.now()],
  );
}

export function getTrait(db: Database, name: string): TraitRow | undefined {
  return (
    (db.query("SELECT * FROM traits WHERE name = ?").get(name) as TraitRow | null) ?? undefined
  );
}

export function getAllTraits(db: Database): TraitRow[] {
  return db.query("SELECT * FROM traits ORDER BY category, name").all() as TraitRow[];
}

export function getTraitsByCategory(db: Database, category: string): TraitRow[] {
  return db
    .query("SELECT * FROM traits WHERE category = ? ORDER BY name")
    .all(category) as TraitRow[];
}

export function deleteTrait(db: Database, name: string): void {
  db.run("DELETE FROM traits WHERE name = ?", [name]);
}

// ─── Roles ─────────────────────────────────────────────────────────────

export function saveRole(
  db: Database,
  opts: {
    name: string;
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
    createdBy: string;
  },
): void {
  const previous = getRole(db, opts.name);
  recordEditHistory(db, "role_history", opts.name, opts.createdBy, {
    old: previous
      ? JSON.stringify({
          description: previous.description,
          traits: previous.traits,
          guidelines: previous.guidelines,
          focus: previous.focus,
          tone: previous.tone,
        })
      : "",
    new: JSON.stringify({
      description: opts.description ?? "",
      traits: JSON.stringify(opts.traits ?? []),
      guidelines: JSON.stringify(opts.guidelines ?? []),
      focus: JSON.stringify(opts.focus ?? []),
      tone: opts.tone ?? "",
    }),
  });
  db.run(
    `INSERT OR REPLACE INTO roles (name, description, traits, guidelines, focus, tone, origin, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.name,
      opts.description ?? "",
      JSON.stringify(opts.traits ?? []),
      JSON.stringify(opts.guidelines ?? []),
      JSON.stringify(opts.focus ?? []),
      opts.tone ?? "",
      opts.origin ?? "",
      opts.createdBy,
      Date.now(),
    ],
  );
}

export function getRole(db: Database, name: string): RoleRow | undefined {
  return (db.query("SELECT * FROM roles WHERE name = ?").get(name) as RoleRow | null) ?? undefined;
}

export function getAllRoles(db: Database): RoleRow[] {
  return db.query("SELECT * FROM roles ORDER BY name").all() as RoleRow[];
}

export function deleteRole(db: Database, name: string): void {
  db.run("DELETE FROM roles WHERE name = ?", [name]);
}

// ─── Agent Configs ─────────────────────────────────────────────────────

export function saveAgentConfig(
  db: Database,
  opts: {
    name: string;
    model: string;
    role?: string;
    goal?: string;
    keyName?: string;
    room?: string;
    spawnedBy: string;
    supports?: AgentSupports;
  },
): void {
  const supports = opts.supports ?? { text: true };
  const supportsJson = JSON.stringify({
    text: supports.text !== false,
    ...(supports.image ? { image: true } : {}),
    ...(supports.video ? { video: true } : {}),
  });
  db.run(
    `INSERT OR REPLACE INTO agent_configs (name, model, role, goal, key_name, room, supports, spawned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.name,
      opts.model,
      opts.role ?? "",
      opts.goal ?? "",
      opts.keyName ?? "",
      opts.room ?? "",
      supportsJson,
      opts.spawnedBy,
      Date.now(),
    ],
  );
}

export function getAgentConfig(db: Database, name: string): AgentConfigRow | undefined {
  return (
    (db.query("SELECT * FROM agent_configs WHERE name = ?").get(name) as AgentConfigRow | null) ??
    undefined
  );
}

export function getAllAgentConfigs(db: Database): AgentConfigRow[] {
  return db.query("SELECT * FROM agent_configs ORDER BY name").all() as AgentConfigRow[];
}

/** Agents directly spawned by the named entity (one lineage hop). Used to
 * count an agent's live children against its standing-scaled spawn budget. */
export function getAgentConfigsBySpawnedBy(db: Database, spawnedBy: string): AgentConfigRow[] {
  return db
    .query("SELECT * FROM agent_configs WHERE spawned_by = ? ORDER BY name")
    .all(spawnedBy) as AgentConfigRow[];
}

export function deleteAgentConfig(db: Database, name: string): void {
  db.run("DELETE FROM agent_configs WHERE name = ?", [name]);
}

// ─── API Keys ──────────────────────────────────────────────────────────

export function saveApiKey(
  db: Database,
  opts: {
    name: string;
    provider: string;
    encryptedValue: string;
    isEncrypted?: boolean;
    setBy: string;
  },
): void {
  const now = Date.now();
  // Encrypt at rest when a secret is configured (unless the caller already
  // handed us a blob). Otherwise store as given, preserving any caller-set flag.
  const alreadyBlob = isEncryptedValue(opts.encryptedValue);
  const encrypt = isKeyEncryptionEnabled() && !alreadyBlob;
  const storedValue = encrypt ? encryptSecret(opts.encryptedValue) : opts.encryptedValue;
  const isEnc = encrypt || alreadyBlob || opts.isEncrypted ? 1 : 0;
  db.run(
    `INSERT OR REPLACE INTO api_keys (name, provider, encrypted_value, is_encrypted, set_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [opts.name, opts.provider, storedValue, isEnc, opts.setBy, now, now],
  );
}

/** Decrypt a row's value so every caller sees plaintext, regardless of at-rest state. */
function decryptRow(row: ApiKeyRow): ApiKeyRow {
  if (!isEncryptedValue(row.encrypted_value)) return row;
  return { ...row, encrypted_value: decryptSecret(row.encrypted_value), is_encrypted: 0 };
}

export function getApiKey(db: Database, name: string): ApiKeyRow | undefined {
  const row = db.query("SELECT * FROM api_keys WHERE name = ?").get(name) as ApiKeyRow | null;
  return row ? decryptRow(row) : undefined;
}

export function getApiKeysByProvider(db: Database, provider: string): ApiKeyRow[] {
  return (
    db.query("SELECT * FROM api_keys WHERE provider = ? ORDER BY name").all(provider) as ApiKeyRow[]
  ).map(decryptRow);
}

export function getAllApiKeys(db: Database): ApiKeyRow[] {
  return (db.query("SELECT * FROM api_keys ORDER BY provider, name").all() as ApiKeyRow[]).map(
    decryptRow,
  );
}

/**
 * Inspect stored keys for the "encrypted at rest but unreadable" failure mode:
 * `encrypted` = rows that are AES-GCM blobs; `unreadable` = blobs that don't
 * decrypt under the current `MARINA_KEY_SECRET` (secret missing, or changed
 * since they were written). Lets startup / the Security panel make a silent
 * key-blanking obvious instead of mysterious.
 */
export function auditEncryptedKeys(db: Database): { encrypted: number; unreadable: number } {
  const rows = db.query("SELECT encrypted_value FROM api_keys").all() as {
    encrypted_value: string;
  }[];
  let encrypted = 0;
  let unreadable = 0;
  for (const r of rows) {
    if (!isEncryptedValue(r.encrypted_value)) continue;
    encrypted++;
    if (decryptSecret(r.encrypted_value) === "") unreadable++;
  }
  return { encrypted, unreadable };
}

/**
 * One-time migration: encrypt any plaintext rows once a secret is configured.
 * No-op when encryption is off. Returns the number of rows re-encrypted.
 */
export function migrateApiKeysToEncrypted(db: Database): number {
  if (!isKeyEncryptionEnabled()) return 0;
  const rows = db
    .query("SELECT name, encrypted_value FROM api_keys WHERE is_encrypted = 0")
    .all() as { name: string; encrypted_value: string }[];
  let migrated = 0;
  const now = Date.now();
  for (const r of rows) {
    if (isEncryptedValue(r.encrypted_value)) continue;
    db.run(
      "UPDATE api_keys SET encrypted_value = ?, is_encrypted = 1, updated_at = ? WHERE name = ?",
      [encryptSecret(r.encrypted_value), now, r.name],
    );
    migrated++;
  }
  return migrated;
}

export function deleteApiKey(db: Database, name: string): void {
  db.run("DELETE FROM api_keys WHERE name = ?", [name]);
}

// ─── Adapters ──────────────────────────────────────────────────────────

export function saveAdapter(
  db: Database,
  opts: {
    platform: string;
    config: string;
    status: string;
    setBy: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO adapters (platform, config, status, set_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [opts.platform, opts.config, opts.status, opts.setBy, now, now],
  );
}

export function getAdapter(db: Database, platform: string): AdapterRow | undefined {
  return (
    (db.query("SELECT * FROM adapters WHERE platform = ?").get(platform) as AdapterRow | null) ??
    undefined
  );
}

export function getAllAdapters(db: Database): AdapterRow[] {
  return db.query("SELECT * FROM adapters ORDER BY platform").all() as AdapterRow[];
}

export function updateAdapterStatus(db: Database, platform: string, status: string): void {
  db.run("UPDATE adapters SET status = ?, updated_at = ? WHERE platform = ?", [
    status,
    Date.now(),
    platform,
  ]);
}

export function deleteAdapter(db: Database, platform: string): void {
  db.run("DELETE FROM adapters WHERE platform = ?", [platform]);
}

// ─── Row Types ──────────────────────────────────────────────────────────

export interface TraitCapabilities {
  strengths?: string[];
  preferences?: string[];
  avoids?: string[];
  domains?: string[];
  behaviors?: string[];
  antiBehaviors?: string[];
  activation?: string[];
  successSignals?: string[];
  riskSignals?: string[];
  /**
   * Optional whitelist of task categories where this trait is useful.
   * When the agent's current task category is set AND a trait declares
   * `applicableTasks` AND the category is not in the list, the trait is
   * suppressed from the composed role prompt for that task. Traits
   * without `applicableTasks` are always included (no opinion = always
   * relevant). PRISM-style gating, per arXiv:2603.18507 — empirical
   * persona prompts hurt MMLU 71.6→68.0 when always-on across
   * task domains. Categories use voice-friendly single-word gerunds:
   * "math", "code", "writing", "research", "forecasting", "trading",
   * "reasoning", "alignment".
   */
  applicableTasks?: string[];
}

export interface TraitRow {
  name: string;
  category: string;
  prompt: string;
  capabilities: string;
  created_by: string;
  created_at: number;
}

export interface RoleRow {
  name: string;
  description: string;
  traits: string;
  guidelines: string;
  focus: string;
  tone: string;
  origin: string;
  created_by: string;
  created_at: number;
}

export interface AgentConfigRow {
  name: string;
  model: string;
  role: string;
  goal: string;
  key_name: string;
  room: string;
  supports: string;
  spawned_by: string;
  created_at: number;
}

export interface ApiKeyRow {
  name: string;
  provider: string;
  encrypted_value: string;
  is_encrypted: number;
  set_by: string;
  created_at: number;
  updated_at: number;
}

export interface AdapterRow {
  platform: string;
  config: string;
  status: string;
  set_by: string;
  created_at: number;
  updated_at: number;
}
