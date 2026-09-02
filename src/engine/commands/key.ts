// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { requiresPersistence } from "./command-messages";

// ─── Provider Connectivity Testing ─────────────────────────────────────────

interface TestResult {
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

const PROVIDER_TEST_ENDPOINTS: Record<
  string,
  { url: string; method?: string; authStyle?: string }
> = {
  anthropic: { url: "https://api.anthropic.com/v1/models", method: "GET" },
  openai: { url: "https://api.openai.com/v1/models", method: "GET" },
  google: { url: "https://generativelanguage.googleapis.com/v1/models", authStyle: "query" },
  groq: { url: "https://api.groq.com/openai/v1/models" },
  openrouter: { url: "https://openrouter.ai/api/v1/models" },
  cerebras: { url: "https://api.cerebras.ai/v1/models" },
  xai: { url: "https://api.x.ai/v1/models" },
  mistral: { url: "https://api.mistral.ai/v1/models" },
  deepseek: { url: "https://api.deepseek.com/v1/models" },
};

export async function testKeyConnectivity(provider: string, value: string): Promise<TestResult> {
  const endpoint = PROVIDER_TEST_ENDPOINTS[provider];
  if (!endpoint) {
    return { ok: false, detail: `Unknown provider "${provider}" — cannot test.` };
  }

  const start = performance.now();
  try {
    let url = endpoint.url;
    const headers: Record<string, string> = {};

    if (endpoint.authStyle === "query") {
      url = `${url}?key=${encodeURIComponent(value)}`;
    } else if (provider === "anthropic") {
      headers["x-api-key"] = value;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${value}`;
    }

    const res = await fetch(url, {
      method: endpoint.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const latencyMs = Math.round(performance.now() - start);

    if (res.ok) {
      return { ok: true, detail: `Valid (HTTP ${res.status}, ${latencyMs}ms)`, latencyMs };
    }

    // 401/403 means the key is invalid; other errors may be transient
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `Authentication failed (HTTP ${res.status}, ${latencyMs}ms)` };
    }

    return {
      ok: false,
      detail: `Unexpected response (HTTP ${res.status}, ${latencyMs}ms)`,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Connection failed: ${msg} (${latencyMs}ms)`, latencyMs };
  }
}

export function keyCommand(deps: {
  db?: MarinaDB;
  getEntity: (id: EntityId) => Entity | undefined;
  logEvent: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "key",
    aliases: [],
    minRank: 8,
    gate: "key.manage",
    help: `Manage LLM API keys.
Requires rank 8 and the key.manage gate.
Gated capability: earn it via \`witness request key.manage\` or an operator grant (see \`standing\`).
Usage:
  key list                          — show all keys (masked)
  key add <name> <provider> <value> — store a named key
  key delete <name>                 — remove a key
  key test <name>                   — test key connectivity

Providers: anthropic, openai, google, groq, openrouter, cerebras, xai, mistral, deepseek`,
    handler: async (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("key management"));
        return;
      }
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const db = deps.db;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const keys = db.getAllApiKeys();

        // Also show env var keys
        const envKeys = detectEnvKeys();

        if (keys.length === 0 && envKeys.length === 0) {
          ctx.send(
            input.entity,
            "No API keys configured.\n\n" +
              "Add a key:  key add <name> <provider> <api-key>\n" +
              "Or set env: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY",
          );
          return;
        }

        const lines = [header("API Keys"), separator()];

        if (envKeys.length > 0) {
          lines.push(bold("From environment:"));
          for (const ek of envKeys) {
            lines.push(`  ${bold(ek.provider)} ${dim(`(${ek.envVar})`)}`);
          }
        }

        if (keys.length > 0) {
          if (envKeys.length > 0) lines.push("");
          lines.push(bold("From database:"));

          const byProvider = new Map<string, typeof keys>();
          for (const k of keys) {
            if (!byProvider.has(k.provider)) byProvider.set(k.provider, []);
            byProvider.get(k.provider)!.push(k);
          }

          for (const [provider, providerKeys] of byProvider) {
            lines.push(`  ${bold(provider)}`);
            for (const k of providerKeys) {
              const masked = maskKey(k.encrypted_value);
              lines.push(`    ${k.name} ${dim(masked)} ${dim(`set by ${k.set_by}`)}`);
            }
          }
        }

        lines.push(separator(), dim(`${keys.length} db key(s), ${envKeys.length} env key(s)`));
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      switch (sub) {
        case "add": {
          const name = tokens[1];
          const provider = tokens[2]?.toLowerCase();
          const value = tokens[3];

          if (!name || !provider || !value) {
            ctx.send(input.entity, "Usage: key add <name> <provider> <value>");
            return;
          }

          db.saveApiKey({
            name,
            provider,
            encryptedValue: value,
            isEncrypted: false,
            setBy: entity.name,
          });

          deps.logEvent({
            type: "key_change",
            provider,
            action: "set",
            actor: input.entity,
            timestamp: Date.now(),
          });

          ctx.send(input.entity, `Key "${name}" saved for provider ${provider}.`);
          return;
        }

        case "delete": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: key delete <name>");
            return;
          }
          const key = db.getApiKey(name);
          if (!key) {
            ctx.send(input.entity, `Key "${name}" not found.`);
            return;
          }

          db.deleteApiKey(name);

          deps.logEvent({
            type: "key_change",
            provider: key.provider,
            action: "delete",
            actor: input.entity,
            timestamp: Date.now(),
          });

          ctx.send(input.entity, `Key "${name}" deleted.`);
          return;
        }

        case "test": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: key test <name>");
            return;
          }
          const key = db.getApiKey(name);
          if (!key) {
            ctx.send(input.entity, `Key "${name}" not found.`);
            return;
          }
          ctx.send(input.entity, `Testing "${name}" (${key.provider})...`);
          const result = await testKeyConnectivity(key.provider, key.encrypted_value);
          const icon = result.ok ? bold("PASS") : bold("FAIL");
          ctx.send(input.entity, `${icon} ${key.provider}/${name}: ${result.detail}`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: key list | key add <name> <provider> <value> | key delete <name> | key test <name>",
          );
      }
    },
  };
}

function maskKey(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function detectEnvKeys(): Array<{ provider: string; envVar: string }> {
  const mapping: Array<{ envVar: string; provider: string }> = [
    { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
    { envVar: "OPENAI_API_KEY", provider: "openai" },
    { envVar: "GEMINI_API_KEY", provider: "google" },
    { envVar: "GOOGLE_API_KEY", provider: "google" },
    { envVar: "GROQ_API_KEY", provider: "groq" },
    { envVar: "OPENROUTER_API_KEY", provider: "openrouter" },
    { envVar: "CEREBRAS_API_KEY", provider: "cerebras" },
    { envVar: "XAI_API_KEY", provider: "xai" },
    { envVar: "MISTRAL_API_KEY", provider: "mistral" },
    { envVar: "DEEPSEEK_API_KEY", provider: "deepseek" },
  ];

  return mapping.filter((m) => !!process.env[m.envVar]);
}
