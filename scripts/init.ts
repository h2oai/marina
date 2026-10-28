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
import { testKeyConnectivity } from "../src/engine/commands/key";
import { dailySpendCapUsd } from "../src/engine/spend-ledger";
import {
  HOSTED_PROVIDERS,
  hostedBaseUrl,
  isHostedProvider,
} from "../src/net/model/hosted-providers";
import { IS_COMPILED } from "../src/runtime-paths";
import { BUILTIN_WORLDS } from "../src/world/builtin-worlds";
import { userMarinaDir } from "./cli-env";
import { themeFor } from "./code-style";
import { initStyles } from "./term-help";

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
  if (IS_COMPILED && dir === WORLDS_DIR)
    return [
      "default",
      ...Object.keys(BUILTIN_WORLDS)
        .filter((slug) => slug !== "default")
        .sort(),
    ];
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

/** One line per provider in the setup menu. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude (Opus, Sonnet, Haiku)",
  openai: "GPT-6 Luna, Sol, Astra",
  google: "Gemini 3.1",
  openrouter: "one key, models from every vendor",
  groq: "gpt-oss-120b (fast)",
  together: "Together AI hosted models",
  nebius: "Nebius Token Factory hosted models",
};
/** Menu order: the providers most people already have a key for come first. */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "openrouter", "groq"];

const PROVIDERS: { name: string; env: string; url: string; model: string; authHeader: string }[] = [
  ...Object.entries(HOSTED_PROVIDERS).map(([name, spec]) => ({
    name,
    env: spec.envKey,
    url: `${hostedBaseUrl(name as keyof typeof HOSTED_PROVIDERS)}/chat/completions`,
    model: spec.defaultModel,
    authHeader: "Bearer",
  })),
  {
    name: "anthropic",
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-opus-5-5",
    authHeader: "x-api-key",
  },
  {
    name: "openai",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-6.1-sol",
    authHeader: "Bearer",
  },
  {
    name: "google",
    env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.1-pro-preview",
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
    model: "google/gemini-3.1-pro-preview",
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
  if (isHostedProvider(provider.name)) {
    const result = await testKeyConnectivity(provider.name, key);
    return result.ok ? null : result.detail;
  }
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

/**
 * The settings for a local OpenAI-compatible runtime at `baseUrl`: Ollama
 * (port 11434) has its own variables; anything else (llama.cpp, LM Studio,
 * vLLM, SGLang) goes through the llama ones.
 */
export function localRuntimeSettings(
  baseUrl: string,
  model: string,
  contextWindow?: string,
): Record<string, string> {
  const url = baseUrl.replace(/\/+$/, "");
  if (/:11434(\/|$)/.test(url)) return { OLLAMA_BASE_URL: url, MARINA_DEFAULT_OLLAMA_MODEL: model };
  return {
    LLAMA_BASE_URL: url,
    MARINA_DEFAULT_LLAMA_MODEL: model,
    ...(contextWindow ? { LLAMA_CONTEXT_WINDOW: contextWindow } : {}),
  };
}

/** The model ids a local runtime serves (`GET <base>/models`), or why it could not be read. */
async function localModels(baseUrl: string): Promise<{ models: string[] } | { error: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    return models.length ? { models } : { error: "it serves no models yet" };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
  // Default target: the checkout's own `.env` when run inside it, else the
  // user's `~/.marina/.env`, which every folder reads (scripts/cli-env.ts).
  // `--directory` names one instance instead.
  const userWide =
    values.directory === undefined && (IS_COMPILED || resolve(process.cwd()) !== resolve(ROOT));
  const directory = resolve(values.directory ?? (userWide ? userMarinaDir() : process.cwd()));
  if (userWide) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ENV_PATH = join(directory, ".env");
  const serverDirectory = userWide ? process.cwd() : directory;
  const savedNotice = userWide
    ? `Wrote ${ENV_PATH}; every folder uses it. Run marina in a project, or marina start.`
    : `Wrote ${ENV_PATH}. Run marina start from ${directory}.`;
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
      console.log(savedNotice);
      console.log(spendCapNotice(cfg));
    }
    return;
  }
  const output = new MutableOutput(process.stdout);
  // On a terminal readline must own the echo (raw mode): otherwise the terminal
  // itself echoes every key and muting `output` hides nothing.
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: !!process.stdin.isTTY && !!process.stdout.isTTY,
  });
  const cleanup = () => {
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  // In raw mode Ctrl+C reaches readline, not the process.
  rl.on("SIGINT", cleanup);
  const theme = themeFor(process.stdout.isTTY ? process.stdout : undefined);
  const ui = { ...initStyles(theme), styled: theme.level > 0 };

  async function ask(prompt: string, fallback = ""): Promise<string> {
    const answer = (await rl.question(ui.ask(prompt))).trim();
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

  console.log(
    ui.styled
      ? ui.banner("setup")
      : `
╔══════════════════════════════╗
║       Marina Setup         ║
╚══════════════════════════════╝`,
  );

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

  // 1. A model: the one thing every surface needs. Asked first.
  console.log(`\n${ui.section("── Connect a model ──")}`);
  console.log(
    ui.muted("Agents need a model. Paste a provider key, or point at a model on this machine."),
  );
  const menu = [
    ...PROVIDER_ORDER.map((name) => PROVIDERS.find((p) => p.name === name)!).filter(Boolean),
    ...PROVIDERS.filter((p) => !PROVIDER_ORDER.includes(p.name)),
  ];
  const localChoice = String(menu.length + 1);
  const skipProvider = String(menu.length + 2);
  console.log("");
  for (let i = 0; i < menu.length; i++) {
    const p = menu[i]!;
    console.log(
      ui.choice(`${i + 1}.`, p.name.padEnd(14), `— ${PROVIDER_LABELS[p.name] ?? p.name}`),
    );
  }
  console.log(
    ui.choice(
      `${localChoice}.`,
      "local".padEnd(14),
      "— Ollama, llama.cpp, LM Studio, vLLM (no key)",
    ),
  );
  console.log(ui.choice(`${skipProvider}.`, "skip".padEnd(14), "— no model for now, explore only"));

  let chosenProvider: (typeof PROVIDERS)[number] | null = null;
  let localLabel: string | undefined;
  const provInput = (await ask("\nModel [1]: ", "1")).toLowerCase();
  const provIdx = Number.parseInt(provInput, 10);
  const wantsLocal = provInput === localChoice || provInput === "local";
  if (provIdx >= 1 && provIdx <= menu.length) {
    chosenProvider = menu[provIdx - 1]!;
  } else if (!wantsLocal && provInput !== skipProvider && provInput !== "skip") {
    chosenProvider = PROVIDERS.find((p) => p.name === provInput) ?? null;
  }

  let providerOk = false;
  if (chosenProvider) {
    while (!providerOk) {
      console.log(ui.muted("\n(Input will not be displayed)"));
      const key = await askHidden(`Paste your ${chosenProvider.name} API key: `);
      if (!key) {
        console.log("Skipped.");
        chosenProvider = null;
        break;
      }
      process.stdout.write("Testing... ");
      const err = await testKey(chosenProvider, key);
      if (err) {
        console.log(ui.fail(`✗ Failed: ${err}`));
        const retry = await ask("Retry? (Y/n): ", "y");
        if (retry.toLowerCase() === "n") {
          chosenProvider = null;
          break;
        }
      } else {
        console.log(ui.ok("✓ Connected."));
        cfg[chosenProvider.env] = key;
        providerOk = true;
      }
    }
  } else if (wantsLocal) {
    console.log(
      ui.muted(
        "\nThe runtime must already be running. Ollama listens on http://localhost:11434/v1,\nllama.cpp on http://localhost:8080/v1, LM Studio on http://localhost:1234/v1.",
      ),
    );
    while (!providerOk) {
      const url = await ask("Base URL [http://localhost:11434/v1]: ", "http://localhost:11434/v1");
      process.stdout.write("Looking for models... ");
      const found = await localModels(url);
      if ("error" in found) {
        console.log(ui.fail(`✗ ${url}: ${found.error}`));
        const retry = await ask("Retry? (Y/n): ", "y");
        if (retry.toLowerCase() === "n") break;
        continue;
      }
      console.log(ui.ok(`✓ ${found.models.length} found.`));
      const shown = found.models.slice(0, 20);
      for (let i = 0; i < shown.length; i++) console.log(ui.choice(`${i + 1}.`, shown[i]!, ""));
      const pick = await ask("Model [1]: ", "1");
      const pickIdx = Number.parseInt(pick, 10);
      const model =
        pickIdx >= 1 && pickIdx <= shown.length ? shown[pickIdx - 1]! : pick || shown[0]!;
      // Ollama reports its window; other servers are asked only when llama.cpp's probe fails.
      const ollama = /:11434(\/|$)/.test(url.replace(/\/+$/, ""));
      const window = ollama
        ? ""
        : await ask("Context window in tokens (blank: ask the server): ", "");
      Object.assign(cfg, localRuntimeSettings(url, model, window));
      localLabel = `${model} (local)`;
      providerOk = true;
    }
  }

  // 2. Server settings: what `marina start` and every folder session share.
  console.log(`\n${ui.section("── Server settings (Enter keeps each default) ──")}`);
  cfg.MARINA_NAME = await ask("\nName your instance [Marina]: ", cfg.MARINA_NAME ?? "Marina");

  // World selection — derived from worlds/*.ts so the menu never goes stale.
  const worlds = worldMenu();
  console.log(`\n${ui.section("Choose a world:")}`);
  const pad = Math.max(...worlds.map(([slug]) => slug.length)) + 2;
  for (let i = 0; i < worlds.length; i++) {
    console.log(
      ui.choice(`${String(i + 1).padStart(2)}.`, worlds[i]![0].padEnd(pad), `— ${worlds[i]![1]}`),
    );
  }
  const worldInput = await ask(`\nWorld [${cfg.MARINA_WORLD ?? "1"}]: `, cfg.MARINA_WORLD ?? "1");
  const worldIdx = Number.parseInt(worldInput, 10);
  const worldMatch =
    worldIdx >= 1 && worldIdx <= worlds.length
      ? worlds[worldIdx - 1]![0]
      : (worlds.find(([n]) => n === worldInput.toLowerCase())?.[0] ?? "default");
  cfg.MARINA_WORLD = worldMatch;

  // Admin name — optional on a local install (every loopback login is already
  // sovereign); it matters under shared/public or MARINA_AUTONOMY=guarded.
  console.log(
    ui.muted(
      "\nOn your own machine you are already the operator; leave this blank. Name an admin\nwhen other people can reach this server (MARINA_ADMINS).",
    ),
  );
  cfg.MARINA_ADMINS = await ask("Admin name []: ", cfg.MARINA_ADMINS ?? "");

  // 5. Summary. Telnet is off by default (plaintext, unauthenticated) — only
  // list its port when the operator has actually enabled it.
  const providerLabel =
    providerOk && chosenProvider ? `${chosenProvider.name} ✓` : (localLabel ?? "none");
  const wsPort = process.env.WS_PORT?.trim() || "3300";
  const mcpPort = process.env.MCP_PORT?.trim() || String((Number(wsPort) || 3300) + 1);
  const telnetPort = process.env.TELNET_PORT?.trim();
  const ports = `${wsPort} (ws) / ${mcpPort} (mcp)`;
  const rows: [string, string][] = [
    ["Instance:", cfg.MARINA_NAME!],
    ["World:", cfg.MARINA_WORLD!],
    ["Admin:", cfg.MARINA_ADMINS || "(none)"],
    ["Model:", providerLabel],
    ["Ports:", ports],
    ...(telnetPort && Number(telnetPort) > 0 ? [["Telnet:", telnetPort] as [string, string]] : []),
  ];
  const width = Math.max(...rows.map(([, value]) => [...value].length)) + 10;
  const summary = [
    `┌${"─".repeat(width + 2)}┐`,
    ...rows.map(
      ([label, value]) =>
        `│ ${label.padEnd(10)}${value}${" ".repeat(width - 10 - [...value].length)} │`,
    ),
    `└${"─".repeat(width + 2)}┘`,
  ];
  console.log(`\n${summary.join("\n")}`);
  if (providerOk) console.log(`\n${spendCapNotice(cfg)}`);

  // 6. Preserve unrelated configuration; never print or make secrets world-readable.
  const problems = validateConfiguration(cfg);
  if (problems.length) throw new Error(problems.join("\n"));
  saveChanges(cfg);
  console.log(`Writing ${ENV_PATH}... ✓`);

  // 7. What next. The user-wide settings serve every folder: say how to use
  // them rather than starting a server in this terminal.
  if (userWide) {
    rl.close();
    console.log(
      [
        "",
        "Next:",
        "  cd <your project> && marina      code in that folder (its dashboard link is on the first screen)",
        `  marina start                      the server and dashboard at http://localhost:${wsPort}`,
      ].join("\n"),
    );
    return;
  }
  const start = await ask("\nStart Marina now? (Y/n): ", "y");
  rl.close();
  if (start.toLowerCase() !== "n") {
    console.log("\nStarting Marina...\n");
    try {
      const proc = Bun.spawn(
        IS_COMPILED
          ? [process.execPath, "start"]
          : [process.execPath, "run", `${ROOT}/src/main.ts`],
        {
          cwd: serverDirectory,
          stdio: ["inherit", "inherit", "inherit"],
        },
      );
      process.exitCode = await proc.exited;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed to spawn Marina: ${message}`);
      console.error('Run "marina start" manually to see the underlying error.');
      process.exitCode = 1;
    }
  } else {
    console.log('\nRun "marina start" when ready.');
  }
}

if (import.meta.main) {
  await runInit(process.argv.slice(2));
}
