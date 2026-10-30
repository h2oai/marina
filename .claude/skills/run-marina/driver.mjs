#!/usr/bin/env node
// Marina run driver — launch an ISOLATED Marina instance (own port, own database, no
// provider keys), drive it over the real surfaces (world commands, the dashboard, the
// dashboard REST API) and screenshot it headless. See SKILL.md next to this file.
//
//   node .claude/skills/run-marina/driver.mjs <up|down|status|cmd|ui|api|smoke> [...]
//
// Environment: MARINA_RUN_PORT (3400), MARINA_RUN_DIR ($TMPDIR/marina-run-<port>),
// MARINA_RUN_NAME (driver), MARINA_RUN_ENV_FILE (an env file for provider keys; default
// is --no-env-file so the checkout's .env — and the live server's ports — never leak in).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.MARINA_RUN_PORT ?? 3400);
const RUN = process.env.MARINA_RUN_DIR ?? join(tmpdir(), `marina-run-${PORT}`);
const NAME = process.env.MARINA_RUN_NAME ?? "driver";
const BUN = process.env.BUN ?? "bun";
const BASE = `http://127.0.0.1:${PORT}`;
const PID_FILE = join(RUN, "pid");
const TOKEN_FILE = join(RUN, "token");
const LOG = join(RUN, "server.log");
const ENV_ARG = process.env.MARINA_RUN_ENV_FILE
  ? `--env-file=${resolve(process.env.MARINA_RUN_ENV_FILE)}`
  : "--no-env-file";

const [verb = "help", ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  } else args.push(rest[i]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

function tailLog(n = 25) {
  if (!existsSync(LOG)) return "(no server.log)";
  return readFileSync(LOG, "utf8").split("\n").slice(-n).join("\n");
}

async function up() {
  if (await health()) {
    console.log(`already up at ${BASE} (run dir ${RUN})`);
    return;
  }
  mkdirSync(RUN, { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    WS_PORT: String(PORT), // MCP and the log viewer follow on PORT+1 / PORT+2
    TELNET_PORT: "0",
    DB_PATH: join(RUN, "marina.db"),
    MARINA_DATA_DIR: join(RUN, "data"),
    MARINA_PROFILE: "local",
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: "false",
  };
  const out = openSync(LOG, "a");
  const child = spawn(BUN, [ENV_ARG, "run", "src/main.ts"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const h = await health();
    if (h) {
      console.log(`up: ${BASE} pid ${child.pid} rooms ${h.rooms} (run dir ${RUN})`);
      console.log(`dashboard ${BASE}/dashboard · mcp http://127.0.0.1:${PORT + 1}/mcp · log ${LOG}`);
      return;
    }
    await sleep(500);
  }
  console.error(`server did not answer /health within 60 s — tail of ${LOG}:\n${tailLog()}`);
  process.exit(1);
}

async function down() {
  if (!existsSync(PID_FILE)) {
    console.log("no pid file; nothing to stop");
  } else {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    try {
      process.kill(pid, "SIGTERM"); // by pid, never pkill -f (it would match the live server)
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await health())) await sleep(300);
    if (await health()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(PID_FILE, { force: true });
    console.log(`stopped pid ${pid}`);
  }
  rmSync(TOKEN_FILE, { force: true }); // a session token dies with the process
  if (flags.clean) {
    rmSync(RUN, { recursive: true, force: true });
    console.log(`removed ${RUN}`);
  }
}

async function status() {
  const h = await health();
  console.log(h ? `health: ${JSON.stringify(h)}` : `down (${BASE}/health unreachable)`);
  if (!h) process.exit(1);
  const r = spawnSync(BUN, ["--no-env-file", "scripts/marina.ts", "status", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

/** One world command as NAME over the WebSocket, printed and done. */
function cmd(command, wait = flags.wait ?? "3") {
  if (!command) {
    console.error('usage: driver.mjs cmd "<world command>" [--wait <sec>]');
    process.exit(2);
  }
  const r = spawnSync(
    BUN,
    ["--no-env-file", "scripts/connect.ts", NAME, "--port", String(PORT), "--wait", String(wait), "-c", command],
    { cwd: ROOT, stdio: "inherit", timeout: 120_000 },
  );
  process.exit(r.status ?? 1);
}

async function browser() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true, args: ["--disable-gpu"] });
}

/** Open the dashboard as NAME (Web Chat login if the page asks), optionally type a command,
 * screenshot, and cache the session token for `api`. */
async function ui() {
  if (!(await health())) {
    console.error(`down — run: driver.mjs up`);
    process.exit(1);
  }
  mkdirSync(RUN, { recursive: true });
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
    await page.goto(`${BASE}${flags.path ?? "/dashboard"}`, { waitUntil: "networkidle", timeout: 30_000 });
    const nameBox = page.getByPlaceholder("Enter your name...");
    if (await nameBox.isVisible().catch(() => false)) {
      await nameBox.fill(NAME);
      await page.getByRole("button", { name: "Connect" }).click();
      await page.waitForSelector('[placeholder="Type a command..."]', { timeout: 15_000 });
    }
    if (flags.cmd) {
      const box = page.getByPlaceholder("Type a command...");
      await box.fill(String(flags.cmd));
      await box.press("Enter");
      await page.waitForTimeout(Number(flags.settle ?? 2500));
    }
    const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
    if (token) writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    const out = resolve(flags.out ?? join(RUN, `ui-${Date.now()}.png`));
    await page.screenshot({ path: out, fullPage: Boolean(flags.full) });
    console.log(`screenshot ${out}${token ? " (session token cached)" : ""}`);
    if (flags.text) {
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      console.log(text.slice(0, Number(flags.text === true ? 1500 : flags.text)));
    }
  } finally {
    await b.close();
  }
}

/** GET a dashboard API path with the cached session token (logs in through the UI if none). */
async function api(path) {
  if (!path) {
    console.error("usage: driver.mjs api </api/path>");
    process.exit(2);
  }
  if (!existsSync(TOKEN_FILE)) {
    console.error("no session token yet — logging in through the dashboard first");
    await ui();
  }
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.text();
  console.log(`${r.status} ${path}`);
  try {
    const json = JSON.parse(body);
    console.log(flags.raw ? body : JSON.stringify(json, null, 2).slice(0, Number(flags.limit ?? 3000)));
  } catch {
    console.log(body.slice(0, 3000));
  }
  if (!r.ok) process.exit(1);
}

/** The whole loop: boot, one world command, the dashboard, one API read. */
async function smoke() {
  await up();
  const results = [];
  const check = (label, ok, note = "") => {
    results.push([label, ok, note]);
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? ` — ${note}` : ""}`);
  };
  const look = spawnSync(
    BUN,
    ["--no-env-file", "scripts/connect.ts", NAME, "--port", String(PORT), "--wait", "3", "-c", "look"],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
  check("world command `look`", /Exits:/.test(look.stdout), look.stdout.split("\n")[0]);
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByPlaceholder("Enter your name...").fill(NAME);
    await page.getByRole("button", { name: "Connect" }).click();
    const box = page.getByPlaceholder("Type a command...");
    await box.waitFor({ timeout: 15_000 });
    await box.fill("look");
    await box.press("Enter");
    await page.waitForTimeout(2500);
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
    if (token) writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    const shot = join(RUN, "smoke.png");
    await page.screenshot({ path: shot });
    check("dashboard login + `look`", /Exits:/.test(text) && !/Activity unavailable/.test(text), shot);
    const r = await fetch(`${BASE}/api/ops/overview`, { headers: { Authorization: `Bearer ${token ?? ""}` } });
    check("dashboard API /api/ops/overview", r.ok, `HTTP ${r.status}`);
  } finally {
    await b.close();
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `${failed.length} check(s) failed` : "smoke passed");
  process.exit(failed.length ? 1 : 0);
}

switch (verb) {
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "status":
    await status();
    break;
  case "cmd":
    cmd(args.join(" "));
    break;
  case "ui":
    await ui();
    break;
  case "api":
    await api(args[0]);
    break;
  case "smoke":
    await smoke();
    break;
  default:
    console.log(`usage: driver.mjs up | down [--clean] | status | cmd "<command>" [--wait s] |
       ui [--cmd "<command>"] [--path /dashboard] [--out file.png] [--full] [--text [n]] |
       api </api/path> [--raw] [--limit n] | smoke
instance ${BASE}  run dir ${RUN}  name ${NAME}`);
}
