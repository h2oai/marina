// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Record a real Marina world for the docs: boot an isolated server with the
 * default Workbench and its four agents, send Host the seeded Launch Brief,
 * and film the dashboard while Host, Builder, Critic and Chronicler work.
 * Every picture on the site and in the README comes from this, so none of
 * them can go stale: run it again and replace docs/assets/.
 *
 *   node site/scripts/capture.mjs record   # boot, film, stills, transcript
 *   node site/scripts/capture.mjs render   # ffmpeg: hero mp4 + README gif
 *   node site/scripts/capture.mjs optimize # palette PNGs for every still
 *   node site/scripts/capture.mjs down     # stop the server (--clean: delete the run dir)
 *
 * Needs MARINA_CAPTURE_ENV_FILE: an env file with ONE provider key (and,
 * optionally, MARINA_WORKBENCH_MODEL). The checkout's .env is never read.
 * Knobs: MARINA_CAPTURE_PORT (3500), MARINA_CAPTURE_DIR, MARINA_CAPTURE_NAME
 * (Sam), MARINA_CAPTURE_SECONDS (240), MARINA_CAPTURE_OUT (docs/assets).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.MARINA_CAPTURE_PORT ?? 3500);
const RUN = process.env.MARINA_CAPTURE_DIR ?? join(tmpdir(), `marina-capture-${PORT}`);
const OUT = resolve(process.env.MARINA_CAPTURE_OUT ?? join(ROOT, "docs", "assets"));
const NAME = process.env.MARINA_CAPTURE_NAME ?? "Sam";
const SECONDS = Number(process.env.MARINA_CAPTURE_SECONDS ?? 240);
const BASE = `http://127.0.0.1:${PORT}`;
const PID_FILE = join(RUN, "server.pid");
const LOG = join(RUN, "server.log");
const BUN = process.env.BUN ?? "bun";
const [verb = "record", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The seeded "first 90 seconds" request (worlds/default.ts, board demo-scenarios). */
const BRIEF =
  "tell Host Turn this brief into a three-point launch plan: make Marina's value obvious to a " +
  "first-time visitor. Ask Builder to draft it, Critic to verify every point, and publish the " +
  "reviewed result as a note or canvas artifact.";

async function health() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function up() {
  if (await health()) {
    console.log(`already up at ${BASE}`);
    return;
  }
  const envFile = process.env.MARINA_CAPTURE_ENV_FILE;
  if (!envFile || !existsSync(envFile)) {
    console.error(
      "MARINA_CAPTURE_ENV_FILE must name an env file with a provider key (agents need a model)",
    );
    process.exit(2);
  }
  mkdirSync(RUN, { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    WS_PORT: String(PORT),
    TELNET_PORT: "0",
    DB_PATH: join(RUN, "marina.db"),
    MARINA_DATA_DIR: join(RUN, "data"),
    MARINA_NAME: "capture",
    MARINA_PROFILE: "local",
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: "true",
  };
  const out = openSync(LOG, "a");
  const child = spawn(BUN, [`--env-file=${resolve(envFile)}`, "run", "src/main.ts"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const h = await health();
    if (h && h.agents >= 4) {
      console.log(`up: ${BASE} pid ${child.pid} agents ${h.agents}`);
      return;
    }
    await sleep(1000);
  }
  console.error(`server (or its agents) did not come up within 120 s — see ${LOG}`);
  process.exit(1);
}

function down() {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    rmSync(PID_FILE, { force: true });
    console.log(`stopped pid ${pid}`);
  }
  if (flags.clean) rmSync(RUN, { recursive: true, force: true });
}

/** One world command as NAME over the WebSocket; the reply text. */
function cmd(command, wait = 3) {
  const r = spawnSync(
    BUN,
    [
      "--no-env-file",
      "scripts/connect.ts",
      NAME,
      "--port",
      String(PORT),
      "--wait",
      String(wait),
      "-c",
      command,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH: process.env.PATH, NO_COLOR: "1" },
    },
  );
  return (r.stdout ?? "") + (r.stderr ?? "");
}

async function record() {
  await up();
  mkdirSync(join(RUN, "video"), { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  const marks = [];
  const mark = (label) => {
    marks.push({ t: Date.now(), label });
    console.log(`${new Date().toISOString()} ${label}`);
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
      recordVideo: { dir: join(RUN, "video"), size: { width: 1440, height: 900 } },
    });
    // The dashboard's H2O black-and-gold theme, as on the site.
    await context.addInitScript(() => localStorage.setItem("marina-theme", "h2o"));
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
    const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
    mark("video-start");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 30_000 });
    const nameBox = page.getByPlaceholder("Enter your name...");
    if (await nameBox.isVisible().catch(() => false)) {
      await nameBox.fill(NAME);
      await page.getByRole("button", { name: "Connect" }).click();
    }
    const box = page.getByPlaceholder("Type a command...");
    await box.waitFor({ timeout: 15_000 });
    const dismiss = page.getByRole("button", { name: "Dismiss getting-started guide" });
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    await page.waitForTimeout(1500);
    await shot("dashboard-arrive");
    mark("arrived");
    // Type like a person, then send.
    await box.click();
    await box.pressSequentially(BRIEF, { delay: 18 });
    await page.waitForTimeout(600);
    await box.press("Enter");
    mark("brief-sent");
    const end = Date.now() + SECONDS * 1000;
    let n = 0;
    while (Date.now() < end) {
      await page.waitForTimeout(15_000);
      n += 15;
      await page.screenshot({ path: join(RUN, `t-${String(n).padStart(3, "0")}.png`) });
    }
    mark("watch-end");
    await shot("dashboard-working");
    for (const tab of ["Work", "Canvas", "Map", "Observe", "Streams"]) {
      const t = page
        .getByRole("tab", { name: tab })
        .or(page.getByRole("button", { name: tab, exact: true }));
      if (
        !(await t
          .first()
          .isVisible()
          .catch(() => false))
      )
        continue;
      await t.first().click();
      await page.waitForTimeout(3000);
      await shot(`dashboard-${tab.toLowerCase()}`);
      mark(`tab-${tab}`);
    }
    // biome-ignore lint/performance/useDomNodeTextContent: a Playwright locator, the rendered text
    const chat = await page.locator("body").innerText();
    writeFileSync(join(RUN, "dashboard-text.txt"), chat);
    for (const who of ["Builder", "Critic", "Host"]) {
      await page.goto(`${BASE}/who/${who}`, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2000);
      await shot(`who-${who.toLowerCase()}`);
    }
    mark("done");
    await context.close();
  } finally {
    await browser.close();
  }
  const video = readdirSync(join(RUN, "video")).find((f) => f.endsWith(".webm"));
  if (video) renameSync(join(RUN, "video", video), join(RUN, "session.webm"));
  writeFileSync(join(RUN, "marks.json"), JSON.stringify(marks, null, 2));
  // The world's own record of what happened, for the logbook.
  const record = [
    "look log since:1h",
    "task list",
    "chronicle",
    "channel history general 40",
    "who",
  ]
    .map((c) => `$ ${c}\n${cmd(c, 4)}`)
    .join("\n\n");
  writeFileSync(join(RUN, "world-record.txt"), record);
  console.log(
    `recorded: ${RUN}/session.webm, stills in ${OUT}, transcript ${RUN}/world-record.txt`,
  );
}

/** ffmpeg: a short hero clip from the brief onward (mp4 for the site), and a GIF for the README. */
function render() {
  const marks = JSON.parse(readFileSync(join(RUN, "marks.json"), "utf8"));
  const t0 = marks[0].t;
  const at = (label) => (marks.find((m) => m.label === label).t - t0) / 1000;
  const start = Math.max(0, at("arrived") - 1);
  const length = Number(flags.seconds ?? 45);
  const src = join(RUN, "session.webm");
  const run = (args) => {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const mp4 = join(OUT, "world-running.mp4");
  run([
    "-ss",
    String(start),
    "-t",
    String(length),
    "-i",
    src,
    "-vf",
    "scale=1280:-2,fps=24",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    mp4,
  ]);
  const palette = join(RUN, "palette.png");
  const gifLen = Number(flags.gifSeconds ?? 20);
  const gifFps = Number(flags.gifFps ?? 8);
  const gifWidth = Number(flags.gifWidth ?? 880);
  run([
    "-ss",
    String(start),
    "-t",
    String(gifLen),
    "-i",
    src,
    "-vf",
    `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,palettegen=max_colors=128`,
    palette,
  ]);
  run([
    "-ss",
    String(start),
    "-t",
    String(gifLen),
    "-i",
    src,
    "-i",
    palette,
    "-lavfi",
    `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
    join(OUT, "world-running.gif"),
  ]);
  // The poster is the frame a visitor sees before play: by default a minute in, when the agents have replied.
  const posterAt = start + Number(flags.poster ?? 60);
  run([
    "-ss",
    String(posterAt),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-2",
    join(OUT, "world-running-poster.png"),
  ]);
  console.log(`rendered ${mp4}, world-running.gif, world-running-poster.png`);
}

/** Shrink every still in OUT: palette PNGs at the same pixel size (about a fifth of the bytes). */
async function optimize() {
  const sharp = (await import("sharp")).default;
  for (const file of readdirSync(OUT).filter((f) => f.endsWith(".png"))) {
    const path = join(OUT, file);
    const before = readFileSync(path).length;
    const buf = await sharp(path).png({ palette: true, quality: 90, effort: 8 }).toBuffer();
    if (buf.length < before) writeFileSync(path, buf);
    console.log(
      `${file}: ${Math.round(before / 1024)} → ${Math.round(Math.min(buf.length, before) / 1024)} KB`,
    );
  }
}

const verbs = { record, render, optimize, up, down };
if (!verbs[verb]) {
  console.error("usage: capture.mjs record|render|optimize|up|down");
  process.exit(2);
}
await verbs[verb]();
