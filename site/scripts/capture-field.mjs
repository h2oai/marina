// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-shoot the pictures in docs/guides/field-use-cases.md from a real, working Marina: boot an
 * isolated server, run each example the way a person would (typed into Web Chat, or in a
 * terminal), wait for its real answer and screenshot the dark dashboard the tour uses. Run it
 * again whenever the dashboard or the message text changes, and replace docs/assets/field-*.png.
 *
 *   node site/scripts/capture-field.mjs record [only=forecast,memory]  # the default world
 *   node site/scripts/capture-field.mjs tabletop                         # the war room (agents)
 *   node site/scripts/capture-field.mjs tabletop-shot                    # its pictures again, no rerun
 *   node site/scripts/capture-field.mjs dd                               # the due-diligence team
 *   node site/scripts/capture-field.mjs dd-shot                          # its board again, no rerun
 *   node site/scripts/capture-field.mjs down [--clean]
 *
 * Needs MARINA_CAPTURE_ENV_FILE: an env file with provider keys (the checkout's `.env` is fine;
 * the server's ports, database and data directory are set here and win over it). Every example
 * spends real model calls; the env file's daily spending cap applies.
 * Knobs: MARINA_CAPTURE_PORT (3520; the due-diligence world uses PORT+10), MARINA_CAPTURE_DIR,
 * MARINA_CAPTURE_OUT (docs/assets), MARINA_CAPTURE_TABLETOP_SECONDS (420),
 * MARINA_CAPTURE_DD_SECONDS (600).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.MARINA_CAPTURE_PORT ?? 3520);
const RUN = process.env.MARINA_CAPTURE_DIR ?? join(tmpdir(), `marina-capture-field-${PORT}`);
const OUT = resolve(process.env.MARINA_CAPTURE_OUT ?? join(ROOT, "docs", "assets"));
const BUN = process.env.BUN ?? "bun";
const [verb = "record", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = createRequire(join(ROOT, "package.json"))("playwright-core");

/** A reply that only says work has started: "… (usually 1–3 min)", "Running debate…". */
const PROGRESS = /(…|\.\.\.)\s*(\([^)]*\))?\s*$/;

const WORLDS = {
  main: { port: PORT, dir: join(RUN, "main"), world: "default", agents: false },
  dd: { port: PORT + 10, dir: join(RUN, "dd"), world: "due-diligence", agents: true },
};

/** The policy documents example 2 searches; built into this run's own corpus directory. */
const POLICIES = [
  {
    docid: "pol-1",
    title: "Log Retention Policy",
    text: "Customer access logs are retained for 90 days and then deleted. Security logs are retained for one year.",
  },
  {
    docid: "pol-2",
    title: "Data Residency Policy",
    text: "Customer data for EU tenants must remain in EU regions. Backups follow the same rule.",
  },
];

/** Web Chat examples: each runs as its own person, so no transcript shows another's work. A
 * command given as `{ cmd, until }` also waits for a message matching `until` (an answer that
 * arrives later, such as a schedule's run). Record into a fresh MARINA_CAPTURE_DIR: a rerun
 * into an old one finds the schedule and connectors already there. */
const CHAT = [
  {
    file: "field-forecast.png",
    user: "Ava",
    // Several vendors research in parallel; with provider retries this can pass 10 minutes.
    cmds: [{ cmd: "forecast Will Brent crude close above $90 on 2027-03-31?", max: 1_500_000 }],
  },
  {
    file: "field-research.png",
    user: "Ben",
    cmds: [
      "research ask -- What changed in EU AI Act obligations for general-purpose AI models in 2026?",
    ],
  },
  {
    file: "field-corpus.png",
    user: "Dee",
    cmds: ["web search engines:corpus:policies data retention for customer logs"],
  },
  {
    file: "field-debate.png",
    user: "Cal",
    cmds: [
      "pattern run debate budget:1 -- Pre-mortem: we launch self-serve pricing in EMEA on 1 March 2027 with no sales-assist tier. Find the ways this fails.",
    ],
  },
  {
    file: "field-memory.png",
    user: "Sam",
    cmds: [
      "memory note We chose Vendor B for the data platform because of EU data residency.",
      "ask What did we decide about the data platform vendor?",
    ],
  },
  {
    file: "field-schedule.png",
    user: "Gus",
    height: 1300,
    cmds: [
      "data series CPIAUCSL",
      "data markets fed rate cut",
      "schedule add eu-ai-brief daily:07:00 -- research ask -- What changed in EU AI regulation in the last 24 hours? Cite sources.",
      { cmd: "schedule run eu-ai-brief", until: /Research \(agent\)\s/ },
    ],
  },
  {
    file: "field-tools.png",
    user: "Eli",
    cmds: [
      "connect add deepwiki https://mcp.deepwiki.com/mcp",
      "connect tools deepwiki",
      "connect add internal http://169.254.169.254/mcp",
    ],
  },
];

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function up(w) {
  if (await health(w.port)) return;
  const envFile = process.env.MARINA_CAPTURE_ENV_FILE;
  if (!envFile || !existsSync(envFile)) {
    console.error("MARINA_CAPTURE_ENV_FILE must name an env file with provider keys");
    process.exit(2);
  }
  mkdirSync(w.dir, { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    WS_PORT: String(w.port),
    TELNET_PORT: "0",
    DB_PATH: join(w.dir, "marina.db"),
    MARINA_DATA_DIR: join(w.dir, "data"),
    MARINA_CORPUS_DIR: join(w.dir, "corpora"),
    MARINA_NAME: "field",
    MARINA_PROFILE: "local",
    MARINA_WORLD: w.world,
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: String(w.agents),
  };
  const out = openSync(join(w.dir, "server.log"), "a");
  const child = spawn(BUN, [`--env-file=${resolve(envFile)}`, "run", "src/main.ts"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(join(w.dir, "server.pid"), String(child.pid));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await health(w.port)) {
      console.log(`up: ${w.world} on ${w.port} (${w.dir})`);
      return;
    }
    await sleep(1000);
  }
  console.error(`server did not come up within 120 s — see ${join(w.dir, "server.log")}`);
  process.exit(1);
}

function down() {
  for (const w of Object.values(WORLDS)) {
    const pidFile = join(w.dir, "server.pid");
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    rmSync(pidFile, { force: true });
    console.log(`stopped ${w.world} (pid ${pid})`);
  }
  if (flags.clean) rmSync(RUN, { recursive: true, force: true });
}

/** A logged-in dark dashboard page, 1440×900 CSS px at 2×, as in the tour. */
async function open(browser, port, user, { maximizeChat = true, height = 900 } = {}) {
  const page = await browser.newPage({
    viewport: { width: 1440, height },
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: "networkidle" });
  const nameBox = page.locator('[placeholder="Enter your name..."]');
  if (await nameBox.isVisible().catch(() => false)) {
    await nameBox.fill(user);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector('[placeholder="Type a command..."]', { timeout: 20_000 });
  }
  await page.waitForTimeout(2000);
  // The first-run guide can open a moment after login.
  await page
    .locator('aside[aria-label="Getting started"]')
    .waitFor({ timeout: 5_000 })
    .catch(() => {});
  for (const sel of [
    'button[aria-label="Dismiss getting-started guide"]',
    'button[aria-label="Dismiss orientation"]',
  ]) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  if (maximizeChat) {
    await page.locator('button[aria-label="Maximize Web Chat panel"]').click();
    await page.waitForTimeout(800);
  }
  return page;
}

const messageCount = (page) => page.locator('button[aria-label="Copy message"]').count();
/** Presence and onboarding notices that arrive on their own, never as a command's answer. */
const NOTICE = /^\s*(CONNECT|DISCONNECT|LEAVE|ARRIVE|ENTER|JOIN|ONBOARDING)\b/;
const lastMessage = (page) =>
  page.evaluate((notice) => {
    const re = new RegExp(notice);
    const all = [...document.querySelectorAll('button[aria-label="Copy message"]')].map(
      (b) => b.parentElement?.innerText ?? "",
    );
    return all.filter((t) => !re.test(t)).at(-1) ?? "";
  }, NOTICE.source);

/** Type one command and wait until its answer is in: the chat is quiet and its last message
 * is not a "started, usually N min" line. */
async function run(page, command, { settle = 6_000, max = 600_000, until } = {}) {
  const box = page.locator('[placeholder="Type a command..."]');
  const before = await messageCount(page);
  const t0 = Date.now();
  await box.fill(command);
  await box.press("Enter");
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() - t0 < max) {
    await page.waitForTimeout(1000);
    const n = await page.evaluate(() => document.body.innerText.length);
    if (n !== last) {
      last = n;
      quietSince = Date.now();
      continue;
    }
    if ((await messageCount(page)) <= before) continue;
    const latest = (await lastMessage(page)).trim();
    if (PROGRESS.test(latest)) continue;
    if (until && !until.test(latest)) continue;
    if (Date.now() - quietSince >= settle) break;
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s  ${command.slice(0, 70)}`);
  return before;
}

/** The answers' text beside the run (never in docs/), for updating the figures the page quotes. */
async function saveTranscript(page, first, file) {
  const text = await page.evaluate(
    (i) =>
      [...document.querySelectorAll('button[aria-label="Copy message"]')]
        .slice(i)
        .map((b) => b.parentElement?.innerText ?? "")
        .join("\n\n---\n\n"),
    first,
  );
  writeFileSync(join(RUN, file.replace(/\.png$/, ".txt")), text);
}

/** Scroll so message `index` (0-based, in arrival order) is at the top of Web Chat. */
async function scrollToMessage(page, index) {
  await page.evaluate((i) => {
    const b = document.querySelectorAll('button[aria-label="Copy message"]')[i];
    const msg = b?.parentElement;
    if (!msg) return;
    msg.scrollIntoView({ block: "start" });
    let sc = msg.parentElement;
    while (
      sc &&
      !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))
    )
      sc = sc.parentElement;
    if (sc) sc.scrollTop = Math.max(0, sc.scrollTop - 8);
  }, index);
  await page.waitForTimeout(500);
}

async function chatShots(browser, only) {
  const w = WORLDS.main;
  for (const ex of CHAT) {
    if (only && !only.includes(ex.file.replace(/^field-|\.png$/g, ""))) continue;
    console.log(ex.file);
    const page = await open(browser, w.port, ex.user, { height: ex.height ?? 900 });
    let first = -1;
    for (const c of ex.cmds) {
      const at = typeof c === "string" ? await run(page, c) : await run(page, c.cmd, c);
      if (first < 0) first = at;
    }
    await scrollToMessage(page, first);
    await page.screenshot({ path: join(OUT, ex.file) });
    await saveTranscript(page, first, ex.file);
    await page.close();
  }
}

async function endpointShot(browser) {
  console.log("field-endpoint.png");
  const page = await open(browser, WORLDS.main.port, "Rae", { maximizeChat: false });
  for (const t of ["Admin", "Endpoint", "Passthru"]) {
    await page
      .getByText(new RegExp(`^${t}$`, "i"))
      .first()
      .click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(OUT, "field-endpoint.png"), clip: workspaceClip(420) });
  await page.close();
}

/** Admin → Keys with the add-a-key form open: where a provider key goes from the dashboard. */
async function keysShot(browser) {
  console.log("connect-provider.png");
  const page = await open(browser, WORLDS.main.port, "Rae", { maximizeChat: false });
  await page
    .getByText(/^Admin$/i)
    .first()
    .click();
  await page.waitForTimeout(1500);
  await page
    .getByText(/^\+ Add$/)
    .first()
    .click();
  await page.waitForTimeout(800);
  await page.locator('[placeholder="Key name"]').fill("openrouter");
  // Pick a provider so the form shows what goes where; no key is typed or saved.
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="openrouter"]') })
    .first()
    .selectOption("openrouter");
  await page.screenshot({ path: join(OUT, "connect-provider.png"), clip: workspaceClip(420) });
  await page.close();
}

/** The middle (Workspace) column of the 1440-wide layout. */
const workspaceClip = (height) => ({ x: 437, y: 92, width: 639, height });

function buildCorpus() {
  const w = WORLDS.main;
  const file = join(w.dir, "policies.jsonl");
  writeFileSync(file, `${POLICIES.map((d) => JSON.stringify(d)).join("\n")}\n`);
  const r = spawnSync(
    BUN,
    ["--no-env-file", "scripts/corpus.ts", "build", "policies", file, "--replace"],
    {
      cwd: ROOT,
      env: { ...process.env, MARINA_CORPUS_DIR: join(w.dir, "corpora") },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`corpus build failed: ${r.stderr}`);
}

/** Record a terminal program in a pseudo-terminal and render it the way the tour does. */
function terminalShot(name, argv, cwd, script, out, cols = 108, rows = 46) {
  console.log(name);
  const raw = join(RUN, `${name}.raw`);
  const r = spawnSync(
    "python3",
    ["site/scripts/capture-terminal.py", "field", raw, String(cols), String(rows)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        MARINA_CAPTURE_TERM_ARGV: JSON.stringify(argv),
        MARINA_CAPTURE_TERM_CWD: cwd,
        MARINA_CAPTURE_TERM_SCRIPT: JSON.stringify(script),
      },
      stdio: "inherit",
    },
  );
  if (r.status !== 0) throw new Error(`${name}: recording failed`);
  spawnSync(
    "node",
    ["site/scripts/capture-terminal.mjs", raw, join(OUT, out), String(cols), String(rows)],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
}

/** Example 8: a small project with an off-by-one bug and a failing test. */
function codingShot() {
  const repo = join(RUN, "paginate");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "paginate", type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, "paginate.js"),
    "// Returns the items on a 1-based page.\nexport function paginate(items, page, perPage) {\n  const start = page * perPage;\n  return items.slice(start, start + perPage);\n}\n",
  );
  writeFileSync(
    join(repo, "paginate.test.js"),
    'import { expect, test } from "bun:test";\nimport { paginate } from "./paginate.js";\n\ntest("page 1 returns the first items", () => {\n  expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2]);\n});\n',
  );
  for (const a of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=field", "-c", "user.email=field@example.com", "commit", "-qm", "init"],
  ])
    spawnSync("git", a, { cwd: repo });
  terminalShot(
    "coding",
    [
      BUN,
      // The CLI reads its keys from this file alone (an explicit --env-file replaces its lookup).
      `--env-file=${resolve(process.env.MARINA_CAPTURE_ENV_FILE ?? ".env")}`,
      join(ROOT, "scripts", "marina.ts"),
      "-p",
      "fix the pagination bug so page 1 returns the first items, and make the tests pass",
      ".",
    ],
    repo,
    [[240, null]],
    "field-coding.png",
  );
}

/** Example 5: one OpenAI-style call through the gateway, its key headers shown. */
function gatewayShot() {
  const w = WORLDS.main;
  const key = readFileSync(join(w.dir, "marina.db.local-api-key"), "utf8").trim();
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-5-5",
    messages: [{ role: "user", content: "What is a refund policy? One sentence." }],
  });
  // `show` keeps the headers this example is about and the reply's text.
  const show =
    "show(){ tr -d '\\r' | awk -F': ' 'tolower($1) ~ /^(x-request-id|x-marina-upstream-model|x-marina-cost-usd|x-marina-stack)$/ {print} /^\\{/ {b=$0} END {print \"\"; print b}' | sed -E 's/.*\"content\":\"([^\"]*)\".*/\\1/'; }";
  const curl =
    `curl -si $OPENAI_BASE_URL/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" ` +
    `-H 'Content-Type: application/json' -d '${body}' | show\r`;
  terminalShot(
    "gateway",
    ["bash", "--norc", "--noprofile", "-i"],
    w.dir,
    [
      [
        1,
        `export PS1='$ ' OPENAI_BASE_URL=http://localhost:${w.port}/v1 OPENAI_API_KEY=${key}; ${show}; clear\r`,
      ],
      [1, curl],
      [15, null],
    ],
    "field-gateway.png",
    108,
    16,
  );
}

async function record() {
  mkdirSync(OUT, { recursive: true });
  await up(WORLDS.main);
  buildCorpus();
  const only = typeof flags.only === "string" ? flags.only.split(",") : null;
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    await chatShots(browser, only);
    if (!only || only.includes("endpoint")) await endpointShot(browser);
    if (!only || only.includes("keys")) await keysShot(browser);
  } finally {
    await browser.close();
  }
  if (!only || only.includes("gateway")) gatewayShot();
  if (!only || only.includes("coding")) codingShot();
}

/** Type a command whose answer opens Web Chat's overlay, and shoot the overlay alone. With
 * `author`, its list is scrolled to that author's most recent entry. */
async function overlayShot(page, command, file, { author } = {}) {
  const box = page.locator('[placeholder="Type a command..."]');
  await box.fill(command);
  await box.press("Enter");
  await page
    .locator("button", { hasText: /^Close$/ })
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const clip = await page.evaluate((who) => {
    const close = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Close",
    );
    let d = close;
    while (d?.parentElement && d.getBoundingClientRect().height < 300) d = d.parentElement;
    if (who) {
      const leaves = [...d.querySelectorAll("*")].filter((e) => e.children.length === 0);
      const msg = leaves.filter((e) => e.textContent.trim() === who).at(-1)?.parentElement;
      let sc = msg?.parentElement;
      while (
        sc &&
        !(
          sc.scrollHeight > sc.clientHeight + 4 &&
          /auto|scroll/.test(getComputedStyle(sc).overflowY)
        )
      )
        sc = sc.parentElement;
      if (sc && msg)
        sc.scrollTop += msg.getBoundingClientRect().top - sc.getBoundingClientRect().top - 10;
    }
    const r = d.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, author ?? null);
  await page.waitForTimeout(400);
  console.log(file);
  await page.screenshot({ path: join(OUT, file), clip });
}

/** The due-diligence team's review board: the memo and reviews it posted. */
async function ddShot(browser) {
  const page = await open(browser, WORLDS.dd.port, "Sam", { maximizeChat: false });
  await overlayShot(page, "board read due-diligence-review", "field-dd.png");
  await page.close();
}

const TABLETOP_PLAYERS = ["Red_Actor", "Blue_Lead", "CFO_Sim"];

/** The map with the war room on it, and the crew channel at the incident lead's latest turn. */
async function tabletopShots(browser) {
  console.log("field-map.png");
  const map = await open(browser, WORLDS.main.port, "Lee", { maximizeChat: false });
  await map.getByText(/^Map$/).first().click();
  await map.waitForTimeout(2500);
  await map.screenshot({ path: join(OUT, "field-map.png"), clip: workspaceClip(722) });
  await map.close();

  console.log("field-tabletop.png");
  const chat = await open(browser, WORLDS.main.port, "Lee", { maximizeChat: false, height: 1000 });
  await run(chat, "channel list", { settle: 2_000, max: 30_000 });
  const name = (await lastMessage(chat)).match(/#?(crew-[0-9a-f]+)/)?.[1];
  if (!name) throw new Error("no crew channel found");
  // A member reads the channel's messages; the overlay is cropped at the lead's latest turn.
  await run(chat, `channel join ${name}`, { settle: 2_000, max: 30_000 });
  await overlayShot(chat, `channel history ${name} 10`, "field-tabletop.png", {
    author: "Blue_Lead",
  });
  await chat.close();
}

/** Only the pictures, from a world where the tabletop already ran. */
async function tabletopShotOnly() {
  if (!(await health(WORLDS.main.port))) throw new Error(`no world on ${WORLDS.main.port}`);
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    await tabletopShots(browser);
  } finally {
    await browser.close();
  }
}

/** Example 9: build the war room, cast three players, throw in a surprise, then shoot the map
 * and the crew channel at the incident lead's first turn. */
async function tabletop() {
  await up(WORLDS.main);
  const seconds = Number(process.env.MARINA_CAPTURE_TABLETOP_SECONDS ?? 420);
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    const page = await open(browser, WORLDS.main.port, "Lee");
    for (const c of [
      "build room tabletop/war-room Incident War Room",
      "build formation tabletop/war-room debate",
      "agent spawn Red_Actor role researcher budget 300 goal Play a ransomware crew that already holds domain admin, never help the defenders",
      "agent spawn Blue_Lead role general budget 300 goal Lead incident response for Acme, contain, preserve evidence, communicate",
      "agent spawn CFO_Sim role general budget 200 goal Play the CFO, weigh ransom, downtime cost and disclosure duties",
      "crew create ir-tabletop Red_Actor,Blue_Lead,CFO_Sim formation:debate -- 02:00 Saturday: billing cluster encrypted, ransom note demands 40 BTC",
    ])
      await run(page, c, { settle: 3_000, max: 60_000 });
    await sleep(Math.round(seconds / 2) * 1000);
    await run(
      page,
      "crew dispatch ir-tabletop Inject 2: a journalist emails asking whether customer card data was taken",
      { settle: 3_000, max: 60_000 },
    );
    await sleep(Math.round(seconds / 2) * 1000);
    await page.close();

    await tabletopShots(browser);
    const lee = await open(browser, WORLDS.main.port, "Lee");
    for (const agent of TABLETOP_PLAYERS)
      await run(lee, `agent stop ${agent}`, { settle: 2_000, max: 30_000 });
  } finally {
    await browser.close();
  }
}

/** Example 6: brief the due-diligence team, give it time, then show what it posted for review. */
async function dd() {
  await up(WORLDS.dd);
  const seconds = Number(process.env.MARINA_CAPTURE_DD_SECONDS ?? 600);
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    const page = await open(browser, WORLDS.dd.port, "Sam");
    await run(
      page,
      "tell DiligenceLead Replace the example company with Datadog (NASDAQ: DDOG). Our thesis: Datadog keeps winning mid-market observability despite open-source pressure. Split the work across market, technical and business tasks, cite public sources, and draft the memo.",
      { settle: 3_000, max: 60_000 },
    );
    await page.close();
    await sleep(seconds * 1000);
    await ddShot(browser);
  } finally {
    await browser.close();
  }
}

/** Only the picture, from a due-diligence world that is already running and briefed. */
async function ddShotOnly() {
  if (!(await health(WORLDS.dd.port))) throw new Error(`no world on ${WORLDS.dd.port}`);
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  try {
    await ddShot(browser);
  } finally {
    await browser.close();
  }
}

const verbs = {
  record,
  tabletop,
  "tabletop-shot": tabletopShotOnly,
  dd,
  "dd-shot": ddShotOnly,
  down,
  up: () => up(WORLDS.main),
};
if (!verbs[verb]) {
  console.error(
    `unknown verb ${verb}: record | tabletop | tabletop-shot | dd | dd-shot | up | down`,
  );
  process.exit(2);
}
await verbs[verb]();
