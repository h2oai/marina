#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import { join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { isSecretKey, parseEnvironment, writeEnvironment } from "../src/config/environment";
import { configurationPreset, validateConfiguration } from "../src/config/presets";
import { dailySpendCapUsd } from "../src/engine/spend-ledger";

const ROOT = `${import.meta.dirname}/..`;
const WORLDS_DIR = `${ROOT}/worlds`;

/** Files in worlds/ that are shared helpers, not loadable world definitions. */
export const NON_WORLD_FILES = new Set(["seed.ts", "focused-example.ts", "index.ts", "helpers.ts"]);

/** Hand-written one-liners for the worlds we ship; anything else falls back to its name. */
const WORLD_BLURBS: Record<string, string> = {
  default: "Workbench — 4 rooms, intent-first; the default",
  showcase: "25-room capability showcase (projects, markets, benchmarks, crews)",
  commons: "coordination-ready shared grid",
  research: "research lab",
  personal: "self-evolving personal agent",
  evolve: "8 capability benchmarks",
  craft: "spec-driven development (interview, spec, verify, ship)",
  markets: "prediction markets with Brier scoring",
  demos: "interactive demonstrations (lobby, workshop, bridge)",
  "prediction-lab": "focused: one forecast from question to resolution",
  "deep-research": "focused: one deep research question",
  "red-team": "focused: adversarial review of one artifact",
  "due-diligence": "focused: one due-diligence assessment",
  "data-investigation": "focused: one data investigation",
  empty: "blank canvas, build from scratch",
};

/**
 * Loadable world slugs from `worlds/*.ts` (what MARINA_WORLD accepts), `default`
 * first, then alphabetical. Excludes the shared helper modules.
 */
export function listWorldSlugs(dir = WORLDS_DIR): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return ["default"];
  }
  const slugs = files
    .filter((f) => f.endsWith(".ts") && !NON_WORLD_FILES.has(f))
    .map((f) => f.slice(0, -3))
    .sort();
  const rest = slugs.filter((s) => s !== "default");
  return slugs.includes("default") ? ["default", ...rest] : rest;
}

/**
 * The `name` of the WorldDefinition a world file exports, read textually (the
 * files are heavy to import — they pull in the engine). Falls back to the slug.
 */
export function readWorldName(slug: string, dir = WORLDS_DIR): string {
  try {
    const src = fs.readFileSync(`${dir}/${slug}.ts`, "utf8");
    const m = src.match(/:\s*WorldDefinition\s*=\s*\{\s*\n\s*name:\s*"([^"]+)"/);
    return m?.[1] ?? slug;
  } catch {
    return slug;
  }
}

/** Menu rows: [slug, description] — blurb when we have one, else the exported world name. */
export function worldMenu(dir = WORLDS_DIR): [string, string][] {
  return listWorldSlugs(dir).map((slug) => [slug, WORLD_BLURBS[slug] ?? readWorldName(slug, dir)]);
}

const PROVIDERS: { name: string; env: string; url: string; model: string; authHeader: string }[] = [
  {
    name: "anthropic",
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-5",
    authHeader: "x-api-key",
  },
  {
    name: "openai",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-6-luna",
    authHeader: "Bearer",
  },
  {
    name: "google",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.1-flash-lite",
    authHeader: "Bearer",
  },
  {
    name: "groq",
    env: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    authHeader: "Bearer",
  },
  {
    name: "openrouter",
    env: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-6-luna",
    authHeader: "Bearer",
  },
];

/**
 * A stdout wrapper that swallows every write while `muted` is set. Readline
 * echoes typed characters through its output stream, so muting the stream is
 * what actually hides an API key as it is pasted — printing "(input will not
 * be displayed)" above a plain `rl.question` did not.
 */
export class MutableOutput extends Writable {
  muted = false;
  constructor(private readonly target: NodeJS.WritableStream = process.stdout) {
    super();
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, cb: () => void): void {
    if (!this.muted) this.target.write(chunk);
    cb();
  }
}

async function testKey(provider: (typeof PROVIDERS)[number], key: string): Promise<string | null> {
  const isAnthropic = provider.name === "anthropic";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  // OpenAI's current models reject the legacy `max_tokens` field
  // ("Use 'max_completion_tokens' instead"); every other probe keeps it.
  const tokenField = provider.name === "openai" ? "max_completion_tokens" : "max_tokens";
  const body = JSON.stringify({
    model: provider.model,
    [tokenField]: 16,
    messages: [{ role: "user", content: "Say OK" }],
  });
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `HTTP ${res.status}${text ? ` — ${text.slice(0, 120)}` : ""}`;
    }
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * What agents may spend, said once at setup: the default world starts its
 * seeded agents on a local install once a provider key exists, bounded by the
 * daily spend cap.
 */
export function spendCapNotice(cfg: Record<string, string>): string {
  const raw = (cfg.MARINA_DAILY_SPEND_CAP_USD ?? process.env.MARINA_DAILY_SPEND_CAP_USD)?.trim();
  const cap = dailySpendCapUsd({ MARINA_DAILY_SPEND_CAP_USD: raw });
  const limit =
    cap === undefined
      ? "Upstream model spend is UNCAPPED (MARINA_DAILY_SPEND_CAP_USD=0)."
      : `Upstream model spend is capped at $${cap} per UTC day${raw ? "" : " (default)"}; at the cap model calls are refused and agents pause until 00:00 UTC.`;
  return `${limit} Change it with MARINA_DAILY_SPEND_CAP_USD=<usd> in .env (0 = no cap). Seeded agents start on boot on a local install with a provider key; set AGENT_AUTORESPAWN=false to keep them off.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runInit(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      directory: { type: "string" },
      preset: { type: "string" },
      yes: { type: "boolean" },
      check: { type: "boolean" },
      print: { type: "boolean" },
    },
  });
  const directory = resolve(values.directory ?? process.cwd());
  const ENV_PATH = join(directory, ".env");
  const existing = fs.existsSync(ENV_PATH)
    ? parseEnvironment(fs.readFileSync(ENV_PATH, "utf8"))
    : {};
  const saveChanges = (cfg: Record<string, string>) =>
    writeEnvironment(
      ENV_PATH,
      Object.fromEntries(Object.entries(cfg).filter(([key, value]) => value !== existing[key])),
    );
  if (values.yes || values.check || values.print) {
    const selected = values.check ? {} : configurationPreset(values.preset ?? "workbench");
    const cfg = { ...selected, ...existing };
    if (cfg.MARINA_AUTH === "better-auth" && !cfg.BETTER_AUTH_SECRET && !values.check)
      cfg.BETTER_AUTH_SECRET =
        process.env.BETTER_AUTH_SECRET ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const problems = validateConfiguration(cfg);
    if (problems.length) throw new Error(problems.join("\n"));
    if (values.print || values.check) {
      console.log(
        JSON.stringify(
          {
            valid: true,
            directory,
            settings: Object.fromEntries(
              Object.entries(cfg).map(([key, value]) => [key, isSecretKey(key) ? "[set]" : value]),
            ),
          },
          null,
          2,
        ),
      );
    } else {
      saveChanges(cfg);
      console.log(`Wrote ${ENV_PATH}. Run marina start from ${directory}.`);
      console.log(spendCapNotice(cfg));
    }
    return;
  }
  const output = new MutableOutput(process.stdout);
  const rl = readline.createInterface({ input: process.stdin, output });
  const cleanup = () => {
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);

  async function ask(prompt: string, fallback = ""): Promise<string> {
    const answer = (await rl.question(prompt)).trim();
    return answer || fallback;
  }

  /** Ask without echoing the typed characters (secrets). */
  async function askHidden(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    output.muted = true;
    try {
      const answer = (await rl.question("")).trim();
      process.stdout.write("\n");
      return answer;
    } finally {
      output.muted = false;
    }
  }

  const cfg: Record<string, string> = {
    ...(values.preset ? configurationPreset(values.preset) : {}),
    ...existing,
  };

  console.log(`
╔══════════════════════════════╗
║       Marina Setup         ║
╚══════════════════════════════╝`);

  if (fs.existsSync(ENV_PATH)) {
    const existing = fs.readFileSync(ENV_PATH, "utf-8");
    const vals = existing
      .split("\n")
      .filter((l) => l.match(/^\w+=/))
      .map((l) => `  ${l.split("=")[0]} = [set]`);
    if (vals.length) {
      console.log("\nExisting .env found:");
      console.log(vals.join("\n"));
    }
    const redo = await ask("\nReconfigure? (y/N): ", "n");
    if (redo.toLowerCase() !== "y") {
      console.log("Keeping existing configuration.");
      cleanup();
    }
  }

  // 1. Instance name
  cfg.MARINA_NAME = await ask("\nName your instance [Marina]: ", cfg.MARINA_NAME ?? "Marina");

  // 2. World selection — derived from worlds/*.ts so the menu never goes stale.
  const worlds = worldMenu();
  console.log("\nChoose a world:");
  const pad = Math.max(...worlds.map(([slug]) => slug.length)) + 2;
  for (let i = 0; i < worlds.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${worlds[i]![0].padEnd(pad)}— ${worlds[i]![1]}`);
  }
  const worldInput = await ask(`\nWorld [${cfg.MARINA_WORLD ?? "1"}]: `, cfg.MARINA_WORLD ?? "1");
  const worldIdx = Number.parseInt(worldInput, 10);
  const worldMatch =
    worldIdx >= 1 && worldIdx <= worlds.length
      ? worlds[worldIdx - 1]![0]
      : (worlds.find(([n]) => n === worldInput.toLowerCase())?.[0] ?? "default");
  cfg.MARINA_WORLD = worldMatch;

  // 3. Admin name — optional on a local install (every loopback login is
  // already sovereign); it matters under shared/public or MARINA_AUTONOMY=guarded.
  console.log(
    "\nA local install (loopback bind, no MARINA_AUTH) needs no admin: every loopback login is",
  );
  console.log("sovereign. Set one for shared/public profiles or MARINA_AUTONOMY=guarded.");
  cfg.MARINA_ADMINS = await ask(
    "Admin name (auto-promoted to rank 9) []: ",
    cfg.MARINA_ADMINS ?? "",
  );

  // 4. LLM provider
  console.log("\n── Optional: Connect an LLM Provider ──\n");
  for (let i = 0; i < PROVIDERS.length; i++) {
    const labels = [
      "Claude (Opus, Sonnet, Haiku)",
      "GPT-6 Luna, Sol, Astra",
      "Gemini 3.1",
      "gpt-oss-120b (fast)",
      "Multi-provider routing",
    ];
    console.log(`  ${i + 1}. ${PROVIDERS[i]!.name.padEnd(14)}— ${labels[i]}`);
  }
  console.log(`  6. ${"skip".padEnd(14)}— No LLM, explore only`);

  let chosenProvider: (typeof PROVIDERS)[number] | null = null;
  const provInput = await ask(`\nProvider [6]: `, "6");
  const provIdx = Number.parseInt(provInput, 10);
  if (provIdx >= 1 && provIdx <= 5) {
    chosenProvider = PROVIDERS[provIdx - 1]!;
  } else if (provInput !== "6" && provInput.toLowerCase() !== "skip") {
    chosenProvider = PROVIDERS.find((p) => p.name === provInput.toLowerCase()) ?? null;
  }

  let providerOk = false;
  if (chosenProvider) {
    while (!providerOk) {
      console.log("\n(Input will not be displayed)");
      const key = await askHidden("Paste your API key: ");
      if (!key) {
        console.log("Skipped.");
        chosenProvider = null;
        break;
      }
      process.stdout.write("Testing... ");
      const err = await testKey(chosenProvider, key);
      if (err) {
        console.log(`✗ Failed: ${err}`);
        const retry = await ask("Retry? (Y/n): ", "y");
        if (retry.toLowerCase() === "n") {
          chosenProvider = null;
          break;
        }
      } else {
        console.log("✓ Connected.");
        cfg[chosenProvider.env] = key;
        providerOk = true;
      }
    }
  }

  // 5. Summary. Telnet is off by default (plaintext, unauthenticated) — only
  // list its port when the operator has actually enabled it.
  const providerLabel = providerOk && chosenProvider ? `${chosenProvider.name} ✓` : "none";
  const wsPort = process.env.WS_PORT?.trim() || "3300";
  const mcpPort = process.env.MCP_PORT?.trim() || "3301";
  const telnetPort = process.env.TELNET_PORT?.trim();
  const ports = `${wsPort} (ws) / ${mcpPort} (mcp)`;
  const row = (label: string, value: string) => `│ ${label.padEnd(10)}${value.padEnd(21)}│`;
  const summary = [
    "┌─────────────────────────────────┐",
    row("Instance:", cfg.MARINA_NAME!),
    row("World:", cfg.MARINA_WORLD!),
    row("Admin:", cfg.MARINA_ADMINS || "(none)"),
    row("LLM:", providerLabel),
    row("Ports:", ports),
  ];
  if (telnetPort && Number(telnetPort) > 0) summary.push(row("Telnet:", telnetPort));
  summary.push("└─────────────────────────────────┘");
  console.log(`\n${summary.join("\n")}`);
  if (providerOk) console.log(`\n${spendCapNotice(cfg)}`);

  // 6. Preserve unrelated configuration; never print or make secrets world-readable.
  const problems = validateConfiguration(cfg);
  if (problems.length) throw new Error(problems.join("\n"));
  saveChanges(cfg);
  console.log(`Writing ${ENV_PATH}... ✓`);

  // 7. Offer to start
  const start = await ask("\nStart Marina now? (Y/n): ", "y");
  rl.close();
  if (start.toLowerCase() !== "n") {
    console.log("\nStarting Marina...\n");
    try {
      const proc = Bun.spawn(["bun", "run", `${ROOT}/src/main.ts`], {
        cwd: directory,
        stdio: ["inherit", "inherit", "inherit"],
      });
      process.exitCode = await proc.exited;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to spawn Marina: ${message}`);
      console.error('Run "bun run start" manually to see the underlying error.');
      process.exitCode = 1;
    }
  } else {
    console.log('\nRun "bun run start" when ready.');
  }
}

if (import.meta.main) {
  await runInit(process.argv.slice(2));
}
