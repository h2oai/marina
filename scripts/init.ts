#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

const ROOT = `${import.meta.dirname}/..`;
const ENV_PATH = `${ROOT}/.env`;
const EXAMPLE_PATH = `${ROOT}/.env.example`;
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
    model: "claude-sonnet-4-20250514",
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
    model: "llama-3.3-70b-versatile",
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
  const body = JSON.stringify({
    model: provider.model,
    max_tokens: 5,
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

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runInit(): Promise<void> {
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

  const cfg: Record<string, string> = {};

  console.log(`
╔══════════════════════════════╗
║       Marina Setup         ║
╚══════════════════════════════╝`);

  if (fs.existsSync(ENV_PATH)) {
    const existing = fs.readFileSync(ENV_PATH, "utf-8");
    const vals = existing
      .split("\n")
      .filter((l) => l.match(/^\w+=/))
      .map((l) => `  ${l.split("=")[0]} = ${l.slice(l.indexOf("=") + 1)}`);
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
  cfg.MARINA_NAME = await ask("\nName your instance [Marina]: ", "Marina");

  // 2. World selection — derived from worlds/*.ts so the menu never goes stale.
  const worlds = worldMenu();
  console.log("\nChoose a world:");
  const pad = Math.max(...worlds.map(([slug]) => slug.length)) + 2;
  for (let i = 0; i < worlds.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${worlds[i]![0].padEnd(pad)}— ${worlds[i]![1]}`);
  }
  const worldInput = await ask(`\nWorld [1]: `, "1");
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
  cfg.MARINA_ADMINS = await ask("Admin name (auto-promoted to rank 9) []: ");

  // 4. LLM provider
  console.log("\n── Optional: Connect an LLM Provider ──\n");
  for (let i = 0; i < PROVIDERS.length; i++) {
    const labels = [
      "Claude (Opus, Sonnet, Haiku)",
      "GPT-4o, GPT-4o Mini",
      "Gemini 2.0 Flash",
      "Llama 3.3 70B (fast)",
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

  // 6. Write .env
  const example = fs.existsSync(EXAMPLE_PATH) ? fs.readFileSync(EXAMPLE_PATH, "utf-8") : "";
  const lines = example.split("\n");
  const set = new Set(Object.keys(cfg).filter((k) => cfg[k]));
  const out: string[] = [];

  for (const line of lines) {
    const match = line.match(/^#?\s*([A-Z_]+)=/);
    if (match && set.has(match[1]!)) {
      out.push(`${match[1]}=${cfg[match[1]!]}`);
      set.delete(match[1]!);
    } else {
      out.push(line);
    }
  }
  // Append any keys not found in the example template
  for (const k of set) out.push(`${k}=${cfg[k]}`);

  fs.writeFileSync(ENV_PATH, out.join("\n"), "utf-8");
  console.log("Writing .env... ✓");

  // 7. Offer to start
  const start = await ask("\nStart Marina now? (Y/n): ", "y");
  rl.close();
  if (start.toLowerCase() !== "n") {
    console.log("\nStarting Marina...\n");
    try {
      const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
        cwd: ROOT,
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
  await runInit();
}
