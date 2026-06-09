import type { Database } from "bun:sqlite";
import { MARINA_DEFAULT_MODEL } from "../engine/constants";

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

/**
 * The effective default model ("provider/model-id") for marina/default routing
 * and for agents spawned without an explicit model. Runtime DB setting wins over
 * the MARINA_DEFAULT_MODEL env value, which itself falls back to a built-in.
 */
export function getDefaultModel(db: Database): string {
  return getSetting(db, "default_model") ?? MARINA_DEFAULT_MODEL;
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
  db.run(
    `INSERT OR REPLACE INTO traits (name, category, prompt, capabilities, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.name,
      opts.category,
      opts.prompt,
      JSON.stringify(opts.capabilities ?? {}),
      opts.createdBy,
      Date.now(),
    ],
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
  },
): void {
  db.run(
    `INSERT OR REPLACE INTO agent_configs (name, model, role, goal, key_name, room, spawned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.name,
      opts.model,
      opts.role ?? "",
      opts.goal ?? "",
      opts.keyName ?? "",
      opts.room ?? "",
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
  db.run(
    `INSERT OR REPLACE INTO api_keys (name, provider, encrypted_value, is_encrypted, set_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [opts.name, opts.provider, opts.encryptedValue, opts.isEncrypted ? 1 : 0, opts.setBy, now, now],
  );
}

export function getApiKey(db: Database, name: string): ApiKeyRow | undefined {
  return (
    (db.query("SELECT * FROM api_keys WHERE name = ?").get(name) as ApiKeyRow | null) ?? undefined
  );
}

export function getApiKeysByProvider(db: Database, provider: string): ApiKeyRow[] {
  return db
    .query("SELECT * FROM api_keys WHERE provider = ? ORDER BY name")
    .all(provider) as ApiKeyRow[];
}

export function getAllApiKeys(db: Database): ApiKeyRow[] {
  return db.query("SELECT * FROM api_keys ORDER BY provider, name").all() as ApiKeyRow[];
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
