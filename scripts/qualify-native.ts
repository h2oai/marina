#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Standalone CLI acceptance: an external directory, no Bun or checkout on PATH. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MarinaAgent } from "../src/sdk/client";
import { MARINA_VERSION } from "../src/version";
import { loadBuiltinWorld } from "../src/world/builtin-worlds";
import { terminalText } from "./code-presentation";

const scratch = mkdtempSync(join(tmpdir(), "marina-native-qualification-"));
const bin = join(scratch, "bin");
const project = join(scratch, "project");
mkdirSync(bin);
mkdirSync(project);
const executable = join(bin, "marina");
copyFileSync(resolve("dist/marina"), executable);
const git = Bun.which("git");
if (!git) throw new Error("Native CLI qualification requires Git");
symlinkSync(git, join(bin, "git"));
const env = {
  PATH: bin,
  HOME: scratch,
  NO_COLOR: "1",
  TERM: "xterm-256color",
  MARINA_ROOM_AGENTS: "false",
  AGENT_AUTORESPAWN: "false",
  MARINA_TRUST_PROFILE: "local",
  WS_HOST: "127.0.0.1",
  WS_PORT: "0",
  MCP_PORT: "0",
  LOG_PORT: "0",
  MARINA_OPEN_API: "true",
  MARINA_DESKTOP_API_TOKEN: crypto.randomUUID(),
};

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Standalone CLI qualification timed out");
}

try {
  const version = Bun.spawnSync([executable, "version"], { cwd: scratch, env });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== MARINA_VERSION)
    throw new Error("Standalone version did not match package version");
  for (const world of ["empty", "default", "showcase"]) {
    // The primary listener reports its chosen port through the ordinary banner.
    const child = Bun.spawn([executable, "start"], {
      cwd: scratch,
      env: { ...env, MARINA_WORLD: world, DB_PATH: join(scratch, `${world}.db`) },
      stdout: "pipe",
      stderr: "pipe",
    });
    let port: number | undefined;
    let errorOutput = "";
    const output = (async () => {
      let text = "";
      for await (const bytes of child.stdout) {
        text = (text + new TextDecoder().decode(bytes)).slice(-32_768);
        const match = /WebSocket server listening on .*:(\d+)/.exec(text);
        if (match) port = Number(match[1]);
      }
    })();
    const errors = (async () => {
      for await (const bytes of child.stderr) errorOutput += new TextDecoder().decode(bytes);
    })();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
    let agent: MarinaAgent | undefined;
    try {
      await until(async () => {
        if (child.exitCode !== null)
          throw new Error(`Native ${world} exited ${child.exitCode}: ${errorOutput.slice(-2000)}`);
        if (!port) return false;
        try {
          return (
            await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
          ).ok;
        } catch {
          return false;
        }
      });
      agent = new MarinaAgent(`ws://127.0.0.1:${port}/ws`, { autoReconnect: false });
      await agent.connect("NativeProbe");
      const perceptions = await agent.command("look");
      const expected = await loadBuiltinWorld(world);
      if (!JSON.stringify(perceptions).includes(expected.rooms[expected.startRoom]!.short))
        throw new Error(`Native ${world} has no starting room`);
      const catalog = await fetch(`http://127.0.0.1:${port}/api/env`, {
        headers: { "X-Marina-Desktop-Token": env.MARINA_DESKTOP_API_TOKEN },
      });
      if (!catalog.ok || ((await catalog.json()) as unknown[]).length < 50)
        throw new Error(`Native ${world} is missing the settings catalog`);
      agent.disconnect();
      child.kill("SIGTERM");
      await until(() => child.exitCode !== null);
      if (await child.exited) throw new Error(`Native ${world} failed graceful shutdown`);
      console.log(
        `Standalone ${world}: health, SDK room command, settings, graceful shutdown passed`,
      );
    } finally {
      agent?.disconnect();
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([output, errors]);
    }
  }
  writeFileSync(join(project, "README.md"), "# Native CLI fixture\n");
  const init = Bun.spawnSync([git, "init", "-q"], { cwd: project, env });
  if (init.exitCode) throw new Error("Cannot initialize native coding fixture");
  let raw = "";
  await using terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(_terminal, bytes) {
      raw = (raw + new TextDecoder().decode(bytes)).slice(-128_000);
    },
  });
  const child = Bun.spawn([executable, "--fresh", project], { cwd: project, env, terminal });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const screen = () => terminalText(raw);
  try {
    await until(() => {
      if (child.exitCode !== null) throw new Error(`Native folder session failed: ${screen()}`);
      return /›\s*$/.test(screen());
    });
    if (!screen().includes(`Marina ${MARINA_VERSION}`))
      throw new Error("Native session has no version");
    terminal.write("/cost\r");
    await until(() => /spent|spend|today/i.test(screen()) && /›\s*$/.test(screen()));
    terminal.write("/compact\r");
    await until(() => screen().includes("No active coding agent to compact"));
    terminal.write("/quit\r");
    await until(() => child.exitCode !== null, 35_000);
    if (await child.exited) throw new Error("Native folder session failed to exit cleanly");
    console.log(
      "Standalone folder session: prompt, /cost, idle /compact, /quit passed without Bun on PATH",
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
