// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runningFolderServer, serverInfoPath } from "../scripts/code";
import { setupCli } from "../scripts/setup-cli";

const pkg = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
  version: string;
};

describe("marina from any folder", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "marina-install-"));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("links marina into Bun's bin folder, idempotently, and never over someone else's", () => {
    const env = { BUN_INSTALL: scratch, PATH: `${join(scratch, "bin")}${delimiter}/usr/bin` };
    const first = setupCli({ env });
    expect(first).toMatchObject({ status: "linked", onPath: true });
    expect(setupCli({ env }).status).toBe("already-linked");
    expect(setupCli({ env: { BUN_INSTALL: scratch, PATH: "/usr/bin" } }).onPath).toBe(false);
    rmSync(first.link);
    writeFileSync(first.link, "#!/bin/sh\necho other\n");
    expect(setupCli({ env }).status).toBe("occupied");
    expect(setupCli({ env, force: true }).status).toBe("linked");
  });

  it("runs through a link from any working directory", () => {
    const link = join(scratch, "marina");
    symlinkSync(join(import.meta.dir, "..", "scripts", "marina.ts"), link);
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere);
    const r = Bun.spawnSync([process.execPath, "--env-file=/dev/null", link, "version"], {
      cwd: elsewhere,
      env: { PATH: process.env.PATH, HOME: scratch },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(pkg.version);
  });
});

describe("a folder already open in another terminal", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "marina-folder-"));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("is recognised at once while its server answers", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ hasLlmKey: true }) });
    try {
      writeFileSync(
        serverInfoPath(project),
        JSON.stringify({ pid: process.pid, port: server.port, startedAt: 1 }),
      );
      const started = performance.now();
      expect(await runningFolderServer(project)).toEqual({
        pid: process.pid,
        port: server.port!,
        startedAt: 1,
      });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  it("a stale announcement (dead process or silent port) is removed and ignored", async () => {
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(serverInfoPath(project), JSON.stringify({ pid: dead, port: 1, startedAt: 1 }));
    expect(await runningFolderServer(project)).toBeUndefined();
    expect(existsSync(serverInfoPath(project))).toBe(false);
    const silent = Bun.serve({ port: 0, fetch: () => new Response("", { status: 503 }) });
    const port = silent.port;
    silent.stop(true);
    writeFileSync(
      serverInfoPath(project),
      JSON.stringify({ pid: process.pid, port, startedAt: 1 }),
    );
    expect(await runningFolderServer(project)).toBeUndefined();
    expect(existsSync(serverInfoPath(project))).toBe(false);
    expect(await runningFolderServer(project)).toBeUndefined();
  });
});
