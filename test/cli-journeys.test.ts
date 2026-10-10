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

interface JourneyMetrics {
  journey: string;
  /** Launch to the first interactive prompt. */
  promptMs: number;
  /** Non-empty lines on screen before the first prompt. */
  linesBeforePrompt: number;
  /** Keys the person typed (each character, control keys included). */
  keystrokes: number;
  exitCode: number | null;
}

const metrics: JourneyMetrics[] = [];
const PROMPT = /›\s*$/;

interface Step {
  keys: string;
  /** Wait until the screen text (since this step began) satisfies this. */
  until: (text: string) => boolean;
}

/** The screen as plain text: control sequences removed. */
const screen = (raw: string) => terminalText(raw);

async function journey(
  name: string,
  steps: Step[],
  opts: { args?: string[]; exitKeys?: string } = {},
): Promise<{ metrics: JourneyMetrics; text: string; firstScreen: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "marina-journey-"));
  const project = join(scratch, "project");
  const home = join(scratch, "home");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(join(project, "README.md"), "# demo\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  let raw = "";
  await using tty = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(_t, data) {
      raw = (raw + new TextDecoder().decode(data)).slice(-512 * 1024);
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
      env: { PATH: process.env.PATH, TERM: "xterm-256color", NO_COLOR: "1", HOME: home },
    },
  );
  let keystrokes = 0;
  try {
    // The first prompt: a prompt line, then a moment of quiet (hints may follow it).
    await until(
      () => PROMPT.test(screen(raw).trimEnd().split("\n").at(-1) ?? "") || child.exitCode !== null,
      {
        timeoutMs: 30_000,
      },
    );
    const promptMs = performance.now() - started;
    if (child.exitCode !== null) throw new Error(`marina exited ${child.exitCode}: ${screen(raw)}`);
    const atPrompt = screen(raw);
    const lines = atPrompt.split("\n");
    const promptLine = lines.findIndex((l) => PROMPT.test(l));
    const firstScreen = lines.slice(0, promptLine).join("\n");
    const linesBeforePrompt = lines.slice(0, promptLine).filter((l) => l.trim()).length;
    for (const step of steps) {
      const from = raw.length;
      tty.write(step.keys);
      keystrokes += [...step.keys].length;
      await until(() => step.until(screen(raw.slice(from))), { timeoutMs: 20_000 });
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
  test("start: a fresh folder reaches a prompt, and exits cleanly", async () => {
    const { metrics: m } = await journey("start", []);
    expect(m.exitCode).toBe(0);
    // Regression guard: today the prompt appears in about 3 s.
    expect(m.promptMs).toBeLessThan(15_000);
  }, 60_000);

  test("help: /help answers on screen", async () => {
    const { metrics: m } = await journey("help", [
      { keys: "/help\r", until: (t) => /help|commands?/i.test(t) && PROMPT.test(t.trimEnd()) },
    ]);
    expect(m.exitCode).toBe(0);
  }, 60_000);

  test("status: /status answers on screen", async () => {
    const { metrics: m } = await journey("status", [
      { keys: "/status\r", until: (t) => /session|status/i.test(t) && PROMPT.test(t.trimEnd()) },
    ]);
    expect(m.exitCode).toBe(0);
  }, 60_000);
});
