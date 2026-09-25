// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Operator configuration surface, contiguous in the dispatch order: stored
// provider keys, the default model, the model endpoint posture, model
// discovery, chat adapters, roles/traits, the MCP info document and the .env
// editor. Reads never return secret plaintext (`projectEnvValueForRead`), and
// every write is behind `key.manage`, `adapter.enable` or `admin.destructive`.

import { join } from "node:path";
import { testKeyConnectivity } from "../../engine/commands/key";
import type { Engine } from "../../engine/engine";
import type { MarinaDB } from "../../persistence/database";
import { discoverModels } from "../model-discovery";
import { type EndpointConfig, getEndpointConfig, setEndpointConfig } from "../model-endpoint";
import {
  authorizePrivileged,
  type DashboardRouteContext,
  json,
  maskKey,
  PROJECT_ROOT,
} from "./shared";

// ─── Key API Handlers ───────────────────────────────────────────────────────

async function handleKeyAdd(req: Request, db: MarinaDB): Promise<Response> {
  const body = (await req.json()) as { name?: string; provider?: string; value?: string };
  if (!body.name || !body.provider || !body.value) {
    return json({ error: "name, provider, and value are required" }, 400);
  }

  db.saveApiKey({
    name: body.name,
    provider: body.provider,
    encryptedValue: body.value,
    isEncrypted: false,
    setBy: "dashboard",
  });

  return json({ ok: true, name: body.name, provider: body.provider });
}

function getMcpInfo(req: Request): object {
  const host = req.headers.get("Host") ?? "localhost:3300";
  const bare = host.replace(/:\d+$/, "");
  const mcpPort = Number(process.env.MCP_PORT) || 3301;

  return {
    url: `http://${bare}:${mcpPort}/mcp`,
    port: mcpPort,
    tools: {
      bootstrap: [
        { name: "login", description: "Log in with a character name" },
        { name: "auth", description: "Reconnect with a session token" },
      ],
      cognition: [
        { name: "think", description: "Notes, recall, reflect" },
        { name: "memory", description: "Core memory (set/get/list)" },
        { name: "next", description: "Context-aware guidance" },
        { name: "brief", description: "World orientation signal" },
        { name: "quest", description: "Tutorial & quest tracking" },
      ],
      world: [
        { name: "look", description: "Examine current room" },
        { name: "move", description: "Navigate between rooms" },
        { name: "say", description: "Speak to the room" },
        { name: "tell", description: "Private message" },
        { name: "who", description: "List online entities" },
        { name: "examine", description: "Inspect entity or item" },
      ],
      coordination: [
        { name: "channel", description: "Async messaging channels" },
        { name: "board", description: "Post to bulletin boards" },
        { name: "group", description: "Manage groups" },
        { name: "task", description: "Task management" },
      ],
      canvas: [{ name: "canvas", description: "Publish media, feeds, and interactive UIs" }],
      building: [{ name: "build", description: "Create rooms and exits" }],
      escape: [
        { name: "command", description: "Run any engine command" },
        { name: "batch", description: "Run multiple commands" },
      ],
      session: [
        { name: "help", description: "List available tools" },
        { name: "quit", description: "Disconnect session" },
      ],
    },
  };
}

// ─── Adapter API Handlers ──────────────────────────────────────────────────

const ADAPTER_ENV_MAP: Record<string, string> = {
  telegram: "TELEGRAM_TOKEN",
  discord: "DISCORD_TOKEN",
};

function getAdaptersWithEnv(db: MarinaDB, engine: Engine): Response {
  const dbAdapters = db.getAllAdapters();
  const mgr = engine.adapterManager;
  const result: Array<Record<string, unknown>> = [];

  // DB-stored adapters
  for (const a of dbAdapters) {
    result.push({ ...a, source: "db", running: mgr?.isRunning(a.platform) ?? false });
  }

  // Env-detected adapters (only add if not already in DB)
  const dbPlatforms = new Set(dbAdapters.map((a) => a.platform));
  for (const [platform, envVar] of Object.entries(ADAPTER_ENV_MAP)) {
    if (process.env[envVar] && !dbPlatforms.has(platform)) {
      result.push({
        platform,
        config: "{}",
        status: "active",
        set_by: "env",
        source: "env",
        envVar,
        running: mgr?.isRunning(platform) ?? false,
        created_at: 0,
        updated_at: 0,
      });
    }
  }

  return json(result);
}

async function handleAdapterSave(req: Request, db: MarinaDB, engine: Engine): Promise<Response> {
  const body = (await req.json()) as { platform?: string; config?: string };
  if (!body.platform) return json({ error: "platform is required" }, 400);

  const allowedPlatforms = ["telegram", "discord"];
  if (!allowedPlatforms.includes(body.platform)) {
    return json({ error: `Invalid platform. Allowed: ${allowedPlatforms.join(", ")}` }, 400);
  }

  db.saveAdapter({
    platform: body.platform,
    config: body.config ?? "{}",
    status: "active",
    setBy: "dashboard",
  });

  // Hot-start the adapter
  const mgr = engine.adapterManager;
  if (mgr && !mgr.isRunning(body.platform)) {
    try {
      await mgr.start(body.platform);
    } catch (err) {
      return json({
        ok: true,
        platform: body.platform,
        running: false,
        startError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({ ok: true, platform: body.platform, running: true });
}

async function handleAdapterUpdate(
  req: Request,
  platform: string,
  db: MarinaDB,
  engine: Engine,
): Promise<Response> {
  const dbAdapter = db.getAdapter(platform);
  // Allow updating env-sourced adapters that aren't in DB yet
  const envVar = ADAPTER_ENV_MAP[platform];
  if (!dbAdapter && !(envVar && process.env[envVar])) {
    return json({ error: "Adapter not found" }, 404);
  }

  const body = (await req.json()) as { status?: string };
  if (!body.status) return json({ error: "status is required" }, 400);

  const allowedStatuses = ["active", "disabled"];
  if (!allowedStatuses.includes(body.status)) {
    return json({ error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}` }, 400);
  }

  // Persist to DB
  if (dbAdapter) {
    db.updateAdapterStatus(platform, body.status);
  }

  // Hot-start or hot-stop the adapter
  const mgr = engine.adapterManager;
  if (mgr) {
    try {
      if (body.status === "active" && !mgr.isRunning(platform)) {
        await mgr.start(platform);
      } else if (body.status === "disabled" && mgr.isRunning(platform)) {
        await mgr.stop(platform);
      }
    } catch (err) {
      return json({
        ok: true,
        platform,
        status: body.status,
        running: mgr.isRunning(platform),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({ ok: true, platform, status: body.status, running: mgr?.isRunning(platform) });
}

async function handleAdapterDelete(
  platform: string,
  db: MarinaDB,
  engine: Engine,
): Promise<Response> {
  const adapter = db.getAdapter(platform);
  if (!adapter) return json({ error: "Adapter not found" }, 404);

  // Hot-stop if running
  const mgr = engine.adapterManager;
  if (mgr?.isRunning(platform)) {
    try {
      await mgr.stop(platform);
    } catch {
      // Best effort — remove config regardless
    }
  }

  db.deleteAdapter(platform);
  return json({ ok: true, platform });
}

// ─── Key Test Handler ──────────────────────────────────────────────────────

async function handleKeyTest(name: string, db: MarinaDB): Promise<Response> {
  const key = db.getApiKey(name);
  if (!key) return json({ error: "Key not found" }, 404);

  const result = await testKeyConnectivity(key.provider, key.encrypted_value);
  return json({ name, provider: key.provider, ...result });
}

// ─── Env Config Handlers ───────────────────────────────────────────────────

const SECRET_PATTERNS = [
  "API_KEY",
  "TOKEN",
  "PASSWORD",
  "SECRET",
  "MEM_API_KEYS",
  "MODEL_API_KEYS",
];

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((p) => key.includes(p));
}

/**
 * Security-relevant env keys that must never be edited through this route, even
 * by an operator: they control who is an admin, the dashboard password, the API
 * bearer tokens, and the auth mode / dev-open bypass. A misapplied edit here
 * could silently escalate privilege or open the instance, so changing them is
 * kept to out-of-band .env / shell provisioning only.
 */
const PROTECTED_ENV_KEYS = new Set([
  "MARINA_ADMINS",
  "MARINA_AUTH",
  "MARINA_AUTH_ADMIN_EMAILS",
  "MARINA_OPEN_API",
  "DASHBOARD_PASSWORD",
  "MARINA_DESKTOP_API_TOKEN",
  "GATEWAY_SECRET",
]);

/** True for keys whose plaintext must never leave the server (any secret, or a
 * protected security knob). */
function isProtectedEnvKey(key: string): boolean {
  return PROTECTED_ENV_KEYS.has(key) || key.endsWith("_API_KEYS");
}

/** Coarse length bucket for a secret value — a "how long is it" hint that leaks
 * no fragment of the plaintext. */
function envLengthBucket(len: number): "empty" | "short" | "medium" | "long" {
  if (len <= 0) return "empty";
  if (len < 16) return "short";
  if (len < 40) return "medium";
  return "long";
}

/**
 * Project a raw env value into what the GET panel is allowed to see. Secrets
 * never return any plaintext (not even a first4/last4 fragment) — only a coarse
 * length bucket. Non-secret operational vars return their real value so the
 * panel remains a usable editor. Exported for direct testing of the
 * no-secret-fragment guarantee.
 */
export function projectEnvValueForRead(
  key: string,
  rawValue: string,
  isSet: boolean,
): { value: string; lengthBucket?: "empty" | "short" | "medium" | "long" } {
  if (isSecretKey(key)) {
    return { value: "", lengthBucket: envLengthBucket(isSet ? rawValue.length : 0) };
  }
  return { value: rawValue };
}

interface EnvEntry {
  key: string;
  value: string;
  /** Coarse size hint for secret-classified keys (never a plaintext fragment). */
  lengthBucket?: "empty" | "short" | "medium" | "long";
  description: string;
  category: string;
  isSecret: boolean;
  isSet: boolean;
  /** False when the value comes from the live process environment (shell/docker)
   * rather than our managed .env file — editing it here can't override it. */
  editable: boolean;
  source: "env" | "file" | "unset";
}

function parseEnvExample(): Array<{ key: string; description: string; category: string }> {
  const examplePath = join(PROJECT_ROOT, ".env.example");
  let content: string;
  try {
    content = require("node:fs").readFileSync(examplePath, "utf-8");
  } catch {
    return [];
  }

  const result: Array<{ key: string; description: string; category: string }> = [];
  let currentCategory = "General";
  let pendingComments: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Section headers: # ─── Category ───
    const sectionMatch = trimmed.match(/^#\s*─+\s*(.+?)\s*─+$/);
    if (sectionMatch) {
      currentCategory = sectionMatch[1]!.trim();
      pendingComments = [];
      continue;
    }

    // Comment lines (accumulate as description for next var)
    if (trimmed.startsWith("#") && !sectionMatch) {
      pendingComments.push(trimmed.replace(/^#\s?/, ""));
      continue;
    }

    // Env var lines (KEY=value or # KEY=value for commented-out defaults)
    const varMatch = trimmed.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/);
    if (varMatch) {
      result.push({
        key: varMatch[1]!,
        description: pendingComments.join(" ").trim(),
        category: currentCategory,
      });
      pendingComments = [];
      continue;
    }

    // Blank lines reset pending comments
    if (!trimmed) {
      pendingComments = [];
    }
  }

  return result;
}

function parseEnvFile(): Map<string, string> {
  const envPath = join(PROJECT_ROOT, ".env");
  let content: string;
  try {
    content = require("node:fs").readFileSync(envPath, "utf-8");
  } catch {
    return new Map();
  }

  const vars = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

function handleEnvGet(): Response {
  const schema = parseEnvExample();
  const fileVars = parseEnvFile();

  const entries: EnvEntry[] = schema.map((s) => {
    const inFile = fileVars.has(s.key);
    const procVal = process.env[s.key];
    const inProc = procVal !== undefined && procVal !== "";

    // A value present in the live environment but NOT in our managed .env file
    // is set out-of-band (shell export, docker-compose, systemd). The panel
    // edits .env, but that external value shadows whatever we'd write — so
    // report it as set-but-read-only, with its live (masked) value, instead of
    // pretending it's unset and offering a futile editable field.
    const externallySet = inProc && !inFile;
    const rawValue = inFile ? (fileVars.get(s.key) ?? "") : (procVal ?? "");
    const isSet = inFile || inProc;

    return {
      key: s.key,
      ...projectEnvValueForRead(s.key, rawValue, isSet),
      description: s.description,
      category: s.category,
      isSecret: isSecretKey(s.key),
      isSet,
      editable: !externallySet,
      source: externallySet ? "env" : inFile ? "file" : "unset",
    };
  });

  return json(entries);
}

// Env vars that are read live from process.env on each access (safe to hot-reload)
const HOT_RELOADABLE_VARS = new Set([
  "ALLOWED_ORIGINS",
  "MODEL_API_KEYS",
  "MEM_API_KEYS",
  "DASHBOARD_PASSWORD",
  "MARINA_ADMINS",
  "START_ROOM",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HF_TOKEN",
  "TELEGRAM_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_CHANNEL_IDS",
  "TAVILY_API_KEY",
  "SEARXNG_URL",
  "AGENT_AUTORESPAWN",
  "MAX_AGENTS",
  "MAX_AGENT_UPTIME_MS",
]);

async function handleEnvPut(req: Request): Promise<Response> {
  const body = (await req.json()) as { vars?: Record<string, string> };
  if (!body.vars || typeof body.vars !== "object") {
    return json({ error: "vars object is required" }, 400);
  }

  // Reject security-relevant keys outright — even for a privileged caller, and
  // regardless of whether they appear in the schema. Editing who is an admin /
  // the auth mode / the API bearer tokens through a dashboard route is a
  // privilege-escalation footgun; keep them .env-only.
  const protectedEdits = Object.keys(body.vars).filter((k) => isProtectedEnvKey(k));
  if (protectedEdits.length > 0) {
    return json(
      {
        error: `These keys can only be changed by editing .env directly: ${protectedEdits.join(", ")}`,
      },
      403,
    );
  }

  // Validate against .env.example schema
  const schema = parseEnvExample();
  const allowedKeys = new Set(schema.map((s) => s.key));
  const invalid = Object.keys(body.vars).filter((k) => !allowedKeys.has(k));
  if (invalid.length > 0) {
    return json({ error: `Unknown env vars: ${invalid.join(", ")}` }, 400);
  }

  // Read current .env to preserve masked values and unmodified vars
  const currentVars = parseEnvFile();

  // Track what actually changed
  const reloaded: string[] = [];
  const restartRequired: string[] = [];

  // Merge: if value contains only mask characters, keep existing value
  const merged = new Map(currentVars);
  for (const [key, value] of Object.entries(body.vars)) {
    // Skip vars set in the live environment but not in our .env file: writing
    // .env would be shadowed by the external value, so accepting the edit would
    // be misleading. The UI disables these, this is the server-side backstop.
    if (process.env[key] !== undefined && !currentVars.has(key)) {
      continue;
    }

    if (/^\*+$/.test(value) || /^.{4}\*{4}.{4}$/.test(value)) {
      // Masked value — keep existing
      continue;
    }

    // Secrets are returned to the panel with an empty value (no plaintext
    // leaves the server), so a blank secret field means "unchanged" — never
    // interpret it as a request to delete the stored secret.
    if (isSecretKey(key) && value === "") continue;

    const oldValue = currentVars.get(key) ?? "";
    if (value === oldValue) continue; // No change

    if (value === "") {
      merged.delete(key);
    } else {
      merged.set(key, value);
    }

    // Apply to process.env if hot-reloadable
    if (HOT_RELOADABLE_VARS.has(key)) {
      if (value === "") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      reloaded.push(key);
    } else {
      restartRequired.push(key);
    }
  }

  // Write atomically
  const envPath = join(PROJECT_ROOT, ".env");
  const tmpPath = join(PROJECT_ROOT, ".env.tmp");
  const lines: string[] = [];

  // Preserve structure from .env.example
  for (const entry of schema) {
    const val = merged.get(entry.key);
    if (val !== undefined) {
      lines.push(`${entry.key}=${val}`);
    }
  }

  // Append any vars in current .env that aren't in schema (preserve custom vars)
  for (const [key, value] of merged) {
    if (!allowedKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  const fs = require("node:fs");
  try {
    fs.writeFileSync(tmpPath, `${lines.join("\n")}\n`, "utf-8");
    fs.renameSync(tmpPath, envPath);
  } catch (err) {
    return json({ error: `Failed to write .env: ${err}` }, 500);
  }

  return json({ ok: true, reloaded, restartRequired });
}

/** Keys, default model, endpoint posture, models, adapters, roles, MCP, env. */
export async function handleKeyRoutes(ctx: DashboardRouteContext): Promise<Response | undefined> {
  const { callerId, db, engine, method, req, url } = ctx;
  // ─── Key API ──────────────────────────────────────────────────────────
  if (url.pathname === "/api/keys" && method === "GET" && db) {
    const keys = db.getAllApiKeys().map((k) => ({
      name: k.name,
      provider: k.provider,
      masked: maskKey(k.encrypted_value),
      setBy: k.set_by,
      updatedAt: k.updated_at,
    }));
    return json(keys);
  }
  if (url.pathname === "/api/keys" && method === "POST" && db) {
    return authorizePrivileged(engine, db, callerId, "key.manage") ?? handleKeyAdd(req, db);
  }
  const keyDeleteMatch = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (keyDeleteMatch && method === "DELETE" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "key.manage");
    if (denied) return denied;
    const name = decodeURIComponent(keyDeleteMatch[1]!);
    const key = db.getApiKey(name);
    if (!key) return json({ error: "Key not found" }, 404);
    db.deleteApiKey(name);
    return json({ ok: true });
  }
  const keyTestMatch = url.pathname.match(/^\/api\/keys\/([^/]+)\/test$/);
  if (keyTestMatch && method === "POST" && db) {
    // Testing a stored provider key is privileged: it probes upstream with the
    // operator's credential (can trigger spend). Gate it like key add/delete.
    return (
      authorizePrivileged(engine, db, callerId, "key.manage") ??
      handleKeyTest(decodeURIComponent(keyTestMatch[1]!), db)
    );
  }

  // ─── Default model API ─────────────────────────────────────────────────
  // The model marina/default routes to and that new agents spawn with —
  // changeable at runtime (persisted in app_settings). `configured` is null when
  // falling back to the MARINA_DEFAULT_MODEL env/built-in value.
  if (url.pathname === "/api/default-model" && method === "GET" && db) {
    return json({
      model: db.getDefaultModel(),
      configured: db.getSetting("default_model") ?? null,
    });
  }
  if (url.pathname === "/api/default-model" && method === "PUT" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const model = body.model?.trim();
    if (!model) return json({ error: "model is required" }, 400);
    if (!/^[\w.-]+\/[\w./:-]+$/.test(model)) {
      return json(
        { error: 'model must be "provider/model-id" (e.g. openrouter/openai/gpt-4o)' },
        400,
      );
    }
    db.setSetting("default_model", model);
    return json({ ok: true, model: db.getDefaultModel(), configured: model });
  }
  if (url.pathname === "/api/default-model" && method === "DELETE" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    db.deleteSetting("default_model");
    return json({ ok: true, model: db.getDefaultModel(), configured: null });
  }

  // ─── Model Endpoint API ────────────────────────────────────────────────
  // How Marina behaves when consumed as an LLM (passthru / agents / open / panel).
  if (url.pathname === "/api/model-endpoint" && method === "GET" && db) {
    return json(getEndpointConfig(db));
  }
  if (url.pathname === "/api/model-endpoint" && method === "PUT" && db) {
    const denied = authorizePrivileged(engine, db, callerId, "admin.destructive");
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as Partial<EndpointConfig>;
    const result = setEndpointConfig(db, body);
    if ("error" in result) return json({ error: result.error }, 400);
    return json(result.config);
  }

  // ─── Model Discovery API ───────────────────────────────────────────────
  if (url.pathname === "/api/models" && method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const result = await discoverModels(db, { refresh });
    return json(result);
  }

  // ─── Adapter API ──────────────────────────────────────────────────────
  if (url.pathname === "/api/adapters" && method === "GET" && db) {
    return getAdaptersWithEnv(db, engine);
  }
  if (url.pathname === "/api/adapters" && method === "POST" && db) {
    return (
      authorizePrivileged(engine, db, callerId, "adapter.enable") ??
      handleAdapterSave(req, db, engine)
    );
  }
  const adapterMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)$/);
  if (adapterMatch && method === "PATCH" && db) {
    return (
      authorizePrivileged(engine, db, callerId, "adapter.enable") ??
      handleAdapterUpdate(req, decodeURIComponent(adapterMatch[1]!), db, engine)
    );
  }
  if (adapterMatch && method === "DELETE" && db) {
    return (
      authorizePrivileged(engine, db, callerId, "adapter.enable") ??
      handleAdapterDelete(decodeURIComponent(adapterMatch[1]!), db, engine)
    );
  }

  // ─── Roles & Traits API ───────────────────────────────────────────────
  if (url.pathname === "/api/roles" && method === "GET" && db) {
    return json(db.getAllRoles());
  }
  if (url.pathname === "/api/traits" && method === "GET" && db) {
    return json(db.getAllTraits());
  }

  // ─── MCP Info API ────────────────────────────────────────────────────
  if (url.pathname === "/api/mcp" && method === "GET") {
    return json(getMcpInfo(req));
  }

  // ─── Env Config API ────────────────────────────────────────────────────
  // The env panel reads/writes .env, which holds credentials and security
  // knobs. Both verbs require an operator capability; reads never expose secret
  // plaintext (only isSet + a coarse length bucket), and writes reject
  // security-relevant keys outright regardless of caller.
  if (url.pathname === "/api/env" && method === "GET") {
    return authorizePrivileged(engine, db, callerId, "key.manage") ?? handleEnvGet();
  }
  if (url.pathname === "/api/env" && method === "PUT") {
    return authorizePrivileged(engine, db, callerId, "admin.destructive") ?? handleEnvPut(req);
  }

  return undefined;
}
