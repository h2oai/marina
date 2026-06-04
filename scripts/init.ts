#!/usr/bin/env bun
import * as fs from "node:fs";
import * as readline from "node:readline/promises";

const ENV_PATH = `${import.meta.dirname}/../.env`;
const EXAMPLE_PATH = `${import.meta.dirname}/../.env.example`;

const WORLDS: [string, string][] = [
  ["default", "25 rooms, full coordination platform"],
  ["evolve", "8 capability benchmarks"],
  ["markets", "prediction markets with Brier scoring"],
  ["demos", "interactive demonstrations"],
  ["empty", "blank canvas, build from scratch"],
];

const PROVIDERS: { name: string; env: string; url: string; model: string; authHeader: string }[] =
  [
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
      model: "gpt-4o-mini",
      authHeader: "Bearer",
    },
    {
      name: "google",
      env: "GEMINI_API_KEY",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-2.0-flash",
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
      model: "openai/gpt-4o-mini",
      authHeader: "Bearer",
    },
  ];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cleanup = () => {
  rl.close();
  process.exit(0);
};
process.on("SIGINT", cleanup);

async function ask(prompt: string, fallback = ""): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer || fallback;
}

async function testKey(
  provider: (typeof PROVIDERS)[number],
  key: string,
): Promise<string | null> {
  const isAnthropic = provider.name === "anthropic";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${key}`;
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

const cfg: Record<string, string> = {};

console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551       Marina Setup         \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`);

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

// 2. World selection
console.log("\nChoose a world:");
for (let i = 0; i < WORLDS.length; i++) {
  console.log(`  ${i + 1}. ${WORLDS[i][0].padEnd(12)}\u2014 ${WORLDS[i][1]}`);
}
const worldInput = await ask(`\nWorld [1]: `, "1");
const worldIdx = Number.parseInt(worldInput, 10);
const worldMatch =
  worldIdx >= 1 && worldIdx <= WORLDS.length
    ? WORLDS[worldIdx - 1][0]
    : (WORLDS.find(([n]) => n === worldInput.toLowerCase())?.[0] ?? "default");
cfg.MARINA_WORLD = worldMatch;

// 3. Admin name
cfg.MARINA_ADMINS = await ask("\nAdmin name (auto-promoted to rank 9) []: ");

// 4. LLM provider
console.log("\n\u2500\u2500 Optional: Connect an LLM Provider \u2500\u2500\n");
for (let i = 0; i < PROVIDERS.length; i++) {
  const labels = [
    "Claude (Opus, Sonnet, Haiku)",
    "GPT-4o, GPT-4o Mini",
    "Gemini 2.0 Flash",
    "Llama 3.3 70B (fast)",
    "Multi-provider routing",
  ];
  console.log(`  ${i + 1}. ${PROVIDERS[i].name.padEnd(14)}\u2014 ${labels[i]}`);
}
console.log(`  6. ${"skip".padEnd(14)}\u2014 No LLM, explore only`);

let chosenProvider: (typeof PROVIDERS)[number] | null = null;
const provInput = await ask(`\nProvider [6]: `, "6");
const provIdx = Number.parseInt(provInput, 10);
if (provIdx >= 1 && provIdx <= 5) {
  chosenProvider = PROVIDERS[provIdx - 1];
} else if (provInput !== "6" && provInput.toLowerCase() !== "skip") {
  chosenProvider = PROVIDERS.find((p) => p.name === provInput.toLowerCase()) ?? null;
}

let providerOk = false;
if (chosenProvider) {
  while (!providerOk) {
    console.log("\n(Input will not be displayed)");
    const key = await ask("Paste your API key: ");
    if (!key) {
      console.log("Skipped.");
      chosenProvider = null;
      break;
    }
    process.stdout.write("Testing... ");
    const err = await testKey(chosenProvider, key);
    if (err) {
      console.log(`\u2717 Failed: ${err}`);
      const retry = await ask("Retry? (Y/n): ", "y");
      if (retry.toLowerCase() === "n") {
        chosenProvider = null;
        break;
      }
    } else {
      console.log("\u2713 Connected.");
      cfg[chosenProvider.env] = key;
      providerOk = true;
    }
  }
}

// 5. Summary
const providerLabel = providerOk && chosenProvider ? `${chosenProvider.name} \u2713` : "none";
console.log(`
\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 Instance:  ${cfg.MARINA_NAME.padEnd(21)}\u2502
\u2502 World:     ${cfg.MARINA_WORLD.padEnd(21)}\u2502
\u2502 Admin:     ${(cfg.MARINA_ADMINS || "(none)").padEnd(21)}\u2502
\u2502 LLM:       ${providerLabel.padEnd(21)}\u2502
\u2502 Ports:     3300 / 4000 / 3301    \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`);

// 6. Write .env
const example = fs.existsSync(EXAMPLE_PATH) ? fs.readFileSync(EXAMPLE_PATH, "utf-8") : "";
const lines = example.split("\n");
const set = new Set(Object.keys(cfg).filter((k) => cfg[k]));
const out: string[] = [];

for (const line of lines) {
  const match = line.match(/^#?\s*([A-Z_]+)=/);
  if (match && set.has(match[1])) {
    out.push(`${match[1]}=${cfg[match[1]]}`);
    set.delete(match[1]);
  } else {
    out.push(line);
  }
}
// Append any keys not found in the example template
for (const k of set) out.push(`${k}=${cfg[k]}`);

fs.writeFileSync(ENV_PATH, out.join("\n"), "utf-8");
console.log("Writing .env... \u2713");

// 7. Offer to start
const start = await ask("\nStart Marina now? (Y/n): ", "y");
rl.close();
if (start.toLowerCase() !== "n") {
  console.log("\nStarting Marina...\n");
  try {
    const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: `${import.meta.dirname}/..`,
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
