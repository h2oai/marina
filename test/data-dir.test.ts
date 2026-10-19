// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDataDir, instanceEnvPath, scratchRoot } from "../src/config/data-dir";

const made: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "marina-data-dir-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MARINA_DATA_DIR", () => {
  test("unset changes nothing", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDataDir(env)).toBeUndefined();
    expect(env).toEqual({});
    expect(scratchRoot(env)).toBe("data/scratch");
  });

  test("roots every unset path setting and creates the directory 0700", () => {
    const dir = join(tmp(), "nested", "marina");
    const env: NodeJS.ProcessEnv = { MARINA_DATA_DIR: dir };
    expect(applyDataDir(env)).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(env.DB_PATH).toBe(join(dir, "marina.db"));
    expect(env.BETTER_AUTH_DB_PATH).toBe(join(dir, "marina-auth.db"));
    expect(env.ASSETS_DIR).toBe(join(dir, "assets"));
    expect(scratchRoot(env)).toBe(join(dir, "scratch"));
    expect(env.MARINA_MEMORY_EMBEDDING_CACHE).toBe(join(dir, "memory-models"));
    expect(instanceEnvPath(env)).toBe(join(dir, ".env"));
  });

  test("an explicit path setting wins", () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { MARINA_DATA_DIR: dir, DB_PATH: "/elsewhere/world.db" };
    applyDataDir(env);
    expect(env.DB_PATH).toBe("/elsewhere/world.db");
    expect(env.ASSETS_DIR).toBe(join(dir, "assets"));
  });

  test("a relative directory resolves to an absolute one", () => {
    const env: NodeJS.ProcessEnv = { MARINA_DATA_DIR: "relative-marina-dir" };
    const dir = applyDataDir(env)!;
    made.push(dir);
    expect(dir).toBe(join(process.cwd(), "relative-marina-dir"));
    expect(env.MARINA_DATA_DIR).toBe(dir);
  });

  test("its .env fills only what the process environment leaves unset", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-file\nMARINA_WORLD=research\n");
    const env: NodeJS.ProcessEnv = { MARINA_DATA_DIR: dir, MARINA_WORLD: "default" };
    applyDataDir(env);
    expect(env.ANTHROPIC_API_KEY).toBe("from-file");
    expect(env.MARINA_WORLD).toBe("default");
  });

  test("its .env reaches settings read at module load (main imports the bootstrap first)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env"), "MARINA_MAX_LOGINS=7\n");
    const repo = join(import.meta.dir, "..");
    // The same order as src/main.ts: the bootstrap, then a module that reads
    // the environment while it loads.
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import ${JSON.stringify(join(repo, "src/config/load-data-dir"))};\n` +
        `import { MARINA_MAX_LOGINS } from ${JSON.stringify(join(repo, "src/engine/constants"))};\n` +
        "process.stdout.write(String(MARINA_MAX_LOGINS));\n",
    );
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", MARINA_DATA_DIR: dir };
    const proc = Bun.spawn([process.execPath, "--no-env-file", entry], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, err).toBe(0);
    expect(out).toBe("7");
    // An explicit environment value still wins over the file.
    const explicit = Bun.spawn([process.execPath, "--no-env-file", entry], {
      cwd: dir,
      env: { ...env, MARINA_MAX_LOGINS: "3" },
      stdout: "pipe",
    });
    expect(await new Response(explicit.stdout).text()).toBe("3");
    await explicit.exited;
  });

  test("src/main.ts imports the bootstrap before anything else", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const firstImport = main.match(/^import [^;]*;/m)?.[0];
    expect(firstImport).toBe('import "./config/load-data-dir";');
  });
});
