// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal journeys: `marina` driven through a real pseudo-terminal, the way a
 * person uses it. Each journey measures what the person feels — time to the
 * first prompt, lines on screen before it, keystrokes to finish — and asserts
 * the behaviour the terminal promises. No model is needed: every journey runs
 * on a disposable (`--fresh`) session in a scratch folder, with a scratch HOME.
 *
 * Measurements are written to `$MARINA_CLI_JOURNEYS_OUT` (default: a file in
 * the OS temp folder) so a change can report before/after numbers.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminalText } from "../scripts/code-presentation";
import { until } from "./helpers";
import { VtScreen } from "./vt-screen";

interface JourneyMetrics {
  journey: string;
  /** Launch to the first interactive prompt. */
  promptMs: number;
  /** Non-empty lines on the first page above the input area. */
  linesBeforePrompt: number;
  /** Keys the person typed (each character, control keys included). */
  keystrokes: number;
  exitCode: number | null;
}

const metrics: JourneyMetrics[] = [];
/** The empty prompt line of the input area (`>` where the locale has no Unicode). */
const PROMPT_LINE = /^[❯>]\s*$/;
const COLS = 120;
const ROWS = 40;

interface Step {
  keys: string;
  /**
   * Wait until this holds: `text` is what was written since the step began,
   * control sequences removed; `page` is the screen a person sees now.
   */
  until: (text: string, page: string[]) => boolean;
}

/** The output as plain text: control sequences removed. */
const screen = (raw: string) => terminalText(raw);
/** The input area is back: its empty prompt is on the page. */
const atPrompt = (page: string[]) => page.some((l) => PROMPT_LINE.test(l));

async function journey(
  name: string,
  steps: Step[],
  opts: {
    args?: string[];
    exitKeys?: string;
    /** Runs at the first prompt, with the scratch folder, HOME and project paths. */
    atPrompt?: (paths: { project: string; home: string }) => Promise<void>;
    /** Extra environment for the spawned `marina` (e.g. a dummy provider key). */
    env?: Record<string, string>;
  } = {},
): Promise<{ metrics: JourneyMetrics; text: string; firstScreen: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "marina-journey-"));
  const project = join(scratch, "project");
  const home = join(scratch, "home");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(join(project, "README.md"), "# demo\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  let raw = "";
  const vt = new VtScreen(COLS, ROWS);
  const decoder = new TextDecoder();
  await using tty = new Bun.Terminal({
    cols: COLS,
    rows: ROWS,
    data(_t, data) {
      const text = decoder.decode(data, { stream: true });
      vt.write(text);
      raw = (raw + text).slice(-512 * 1024);
    },
  });
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      "--env-file=/dev/null",
      resolve("scripts/marina.ts"),
      ...(opts.args ?? ["--fresh"]),
      project,
    ],
    {
      cwd: project,
      terminal: tty,
      env: {
        PATH: process.env.PATH,
        TERM: "xterm-256color",
        NO_COLOR: "1",
        HOME: home,
        ...opts.env,
      },
    },
  );
  let keystrokes = 0;
  try {
    // The first prompt: the input area is on the page.
    await until(() => atPrompt(vt.screen()) || child.exitCode !== null, { timeoutMs: 30_000 });
    const promptMs = performance.now() - started;
    if (child.exitCode !== null) throw new Error(`marina exited ${child.exitCode}: ${screen(raw)}`);
    const page = vt.screen();
    const promptLine = page.findIndex((l) => PROMPT_LINE.test(l));
    // Above the area's top rule: what the first page shows before you type.
    const firstScreen = page.slice(0, promptLine - 1).join("\n");
    const linesBeforePrompt = page.slice(0, promptLine - 1).filter((l) => l.trim()).length;
    // The whole area is on the page: rule, prompt, rule, footer.
    expect(page.length - promptLine).toBeGreaterThanOrEqual(3);
    await opts.atPrompt?.({ project, home });
    for (const step of steps) {
      const from = raw.length;
      tty.write(step.keys);
      keystrokes += [...step.keys].length;
      await until(() => step.until(screen(raw.slice(from)), vt.screen()), { timeoutMs: 20_000 });
    }
    const exitKeys = opts.exitKeys ?? "/quit\r";
    tty.write(exitKeys);
    keystrokes += [...exitKeys].length;
    await until(() => child.exitCode !== null, { timeoutMs: 45_000 });
    const m: JourneyMetrics = {
      journey: name,
      promptMs: Math.round(promptMs),
      linesBeforePrompt,
      keystrokes,
      exitCode: child.exitCode,
    };
    metrics.push(m);
    return { metrics: m, text: screen(raw), firstScreen };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(scratch, { recursive: true, force: true });
  }
}

afterAll(() => {
  const out = process.env.MARINA_CLI_JOURNEYS_OUT ?? join(tmpdir(), "marina-cli-journeys.json");
  writeFileSync(out, `${JSON.stringify(metrics, null, 2)}\n`);
});

describe.skipIf(process.platform === "win32")("terminal journeys", () => {
  test("start: one page — the welcome card, then the input area — and a clean /exit", async () => {
    const {
      metrics: m,
      firstScreen,
      text,
    } = await journey("start", [], {
      exitKeys: "/exit\r",
      env: { OPENAI_API_KEY: "journey-test-key" },
    });
    expect(m.exitCode).toBe(0);
    // The card fits the page above the input: its top and bottom borders are both on it.
    expect(m.linesBeforePrompt).toBeLessThanOrEqual(20);
    expect(firstScreen).toMatch(/^[╭+]─*-* *Marina \d+\.\d+\.\d+ /m);
    expect(firstScreen).toMatch(/^[╰+][─-]+[╯+]$/m);
    expect(firstScreen).toContain("New session.");
    expect(firstScreen).toContain("Tips for getting started");
    // The card opens the page; no startup line above it.
    expect(firstScreen).not.toContain("Starting Marina");
    // Internals stay off the first screen; they are one command away.
    for (const internal of ["WS ·", "Federate", "Flywheel", "Dependencies:", "[C*", "…·…"])
      expect(text).not.toContain(internal);
    // The area's rule names where input goes.
    expect(text).toMatch(/ project · \S.* [─-]{3}$/m);
    // Regression guard: today the prompt appears in about 2 s.
    expect(m.promptMs).toBeLessThan(15_000);
  }, 60_000);

  test("zero-config: no provider key names the missing thing and offers init", async () => {
    const { metrics: m, text, firstScreen } = await journey("zero-config", [], {});
    expect(m.exitCode).toBe(0);
    // The card says it first, inside the page; the idle label never claims "ready".
    expect(firstScreen).toMatch(/Connect a model first/);
    expect(firstScreen).toContain("marina init");
    expect(firstScreen).toContain("no model yet");
    expect(text).toMatch(/ project · no model [─-]{3}$/m);
    expect(m.linesBeforePrompt).toBeLessThanOrEqual(22);
  }, 60_000);

  test("memory: /memory save remembers a line and /memory lists it", async () => {
    const { text } = await journey(
      "memory",
      [
        {
          keys: "/memory save onramp-note-123\r",
          until: (t, page) => /onramp-note-123/i.test(t) && atPrompt(page),
        },
        { keys: "/memory\r", until: (_t, page) => atPrompt(page) },
      ],
      { env: { OPENAI_API_KEY: "journey-test-key" } },
    );
    expect(text).toContain("onramp-note-123");
  }, 60_000);

  test("model: /model shows the current selection", async () => {
    const { text } = await journey(
      "model",
      [{ keys: "/model\r", until: (t, page) => /Model · /.test(t) && atPrompt(page) }],
      { env: { OPENAI_API_KEY: "journey-test-key" } },
    );
    expect(text).toContain("Model · ");
  }, 60_000);

  test("help: /help is one screen of essentials; /help all lists everything", async () => {
    const { metrics: m, text } = await journey("help", [
      { keys: "/help\r", until: (t) => t.includes("More: /help all") },
      { keys: "/help all\r", until: (t) => t.includes("F6 switches coding/world") },
    ]);
    expect(m.exitCode).toBe(0);
    expect(text).toContain("/diff");
    expect(text).toContain("switch agent (available: marina");
  }, 60_000);

  test("status: /status answers on screen", async () => {
    const { metrics: m } = await journey("status", [
      {
        keys: "/status\r",
        until: (t, page) => /session|status/i.test(t) && atPrompt(page),
      },
    ]);
    expect(m.exitCode).toBe(0);
  }, 60_000);

  test("open twice: a second marina in an open folder says so at once", async () => {
    let second: { exitCode: number | null; stderr: string; ms: number } | undefined;
    const { metrics: m } = await journey("open-twice", [], {
      args: [],
      atPrompt: async ({ project, home }) => {
        const started = performance.now();
        const r = Bun.spawnSync(
          [process.execPath, "--env-file=/dev/null", resolve("scripts/marina.ts"), project],
          { cwd: project, env: { PATH: process.env.PATH, HOME: home, NO_COLOR: "1" } },
        );
        second = {
          exitCode: r.exitCode,
          stderr: r.stderr.toString(),
          ms: performance.now() - started,
        };
      },
    });
    expect(m.exitCode).toBe(0);
    expect(second?.exitCode).toBe(1);
    expect(second?.stderr).toContain("Marina is already open in this folder");
    expect(second!.ms).toBeLessThan(5_000);
  }, 60_000);

  test("verbose: --verbose shows the startup details the first screen leaves out", async () => {
    const { metrics: m, firstScreen } = await journey("verbose", [], {
      args: ["--fresh", "--verbose"],
    });
    expect(m.exitCode).toBe(0);
    expect(firstScreen).toContain("WS · ws://localhost:");
    expect(firstScreen).toContain("DB · ephemeral");
  }, 60_000);

  test("fake-model E2E: /cost, /compact and /plan plumbing without a provider key", async () => {
    const { text } = await journey(
      "fake-model",
      [
        { keys: "/cost\r", until: (t) => t.includes("Today's model spend") },
        { keys: "/compact\r", until: (t) => /compact/i.test(t) },
        { keys: "/plan design a thing\r", until: (t) => /on it|Task received/i.test(t) },
      ],
      { env: { OPENAI_API_KEY: "test", MARINA_FAKE_MODEL: "1" } },
    );
    expect(text).toContain("Today's model spend");
    expect(text).toMatch(/compact/i);
  }, 60_000);
});
