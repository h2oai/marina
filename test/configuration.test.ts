// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Dotenv expressions must stay literal in these fixtures.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { environmentCatalog, parseEnvironment, writeEnvironment } from "../src/config/environment";
import { configurationPreset, validateConfiguration } from "../src/config/presets";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "marina-config-"));
  directories.push(dir);
  return dir;
}

test("configuration edits preserve unrelated settings and round-trip literal secrets through Bun dotenv", async () => {
  const dir = fixture();
  const path = join(dir, ".env");
  writeFileSync(path, "# keep this comment\nCUSTOM_OPTION=untouched\nMARINA_NAME=old\n");
  const secret = 'special $HOME # "quoted" \\ end';
  writeEnvironment(path, { MARINA_NAME: "My World", TEST_API_KEY: secret });
  expect(readFileSync(path, "utf8")).toContain("# keep this comment\nCUSTOM_OPTION=untouched");
  expect(parseEnvironment(readFileSync(path, "utf8")).TEST_API_KEY).toBe(secret);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const proc = Bun.spawn(
    [process.execPath, "-e", "process.stdout.write(process.env.TEST_API_KEY)"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(proc.stdout).text()).toBe(secret);
  expect(await proc.exited).toBe(0);
});

test("headless setup targets the instance directory, preserves edits and redacts secrets", async () => {
  const dir = fixture();
  writeFileSync(
    join(dir, ".env"),
    '# operator comment\nOPENAI_API_KEY=do-not-print-this\nWS_PORT=3400\nCUSTOM_OPTION=kept\nCUSTOM_URL="${HOST}/v1" # preserve interpolation\n',
  );
  const script = resolve("scripts/init.ts");
  async function run(...args: string[]) {
    const proc = Bun.spawn([process.execPath, script, "--directory", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { code: await proc.exited, output };
  }
  expect((await run("--yes", "--preset", "minimal")).code).toBe(0);
  const values = parseEnvironment(readFileSync(join(dir, ".env"), "utf8"));
  expect(values.WS_PORT).toBe("3400");
  expect(values.MARINA_WORLD).toBe("empty");
  expect(values.CUSTOM_OPTION).toBe("kept");
  expect(readFileSync(join(dir, ".env"), "utf8")).toContain(
    'CUSTOM_URL="${HOST}/v1" # preserve interpolation',
  );
  const check = await run("--check");
  expect(check.code).toBe(0);
  expect(check.output).not.toContain("do-not-print-this");
  expect(check.output).toContain("[set]");
  writeEnvironment(join(dir, ".env"), { WS_PORT: "invalid" });
  expect((await run("--check")).code).toBe(1);
});

test("settings metadata includes commented defaults and presets are validated", () => {
  const catalog = environmentCatalog(
    "# ── Models ──\n# Optional key\n# OPENAI_API_KEY=\n# ENABLED=false\nCOUNT=2\n",
  );
  expect(catalog[0]).toMatchObject({ key: "OPENAI_API_KEY", category: "Models", isSecret: true });
  expect(catalog[1]?.type).toBe("boolean");
  expect(validateConfiguration(configurationPreset("minimal"))).toEqual([]);
  expect(() => configurationPreset("typo")).toThrow("Unknown preset");
  expect(validateConfiguration(configurationPreset("shared-team"))).toContain(
    "BETTER_AUTH_SECRET must contain at least 32 characters when sign-in is enabled",
  );
});

test("explicit removals clear duplicate assignments without rewriting unrelated expressions", () => {
  const path = join(fixture(), ".env");
  writeFileSync(
    path,
    'MAX_AGENTS=3\n# operator note\nMAX_AGENTS=4\nCUSTOM_URL="${HOST}/v1" # leave intact\n',
  );
  writeEnvironment(path, { MAX_AGENTS: null });
  expect(readFileSync(path, "utf8")).toBe(
    '# operator note\nCUSTOM_URL="${HOST}/v1" # leave intact\n',
  );
});

test("dashboard configuration writes target the instance and reject malformed values", async () => {
  const dir = fixture();
  const path = join(dir, ".env");
  const original = '# operator note\nCUSTOM_URL="${HOST}/v1" # keep\nOPENAI_API_KEY=original\n';
  writeFileSync(path, original);
  const code = `
    import { Engine } from ${JSON.stringify(resolve("src/engine/engine.ts"))};
    import { MarinaDB } from ${JSON.stringify(resolve("src/persistence/database.ts"))};
    import { handleDashboardApi } from ${JSON.stringify(resolve("src/net/dashboard-api.ts"))};
    const db = new MarinaDB("fixture.db");
    const engine = new Engine({ startRoom: "test/start", tickInterval: 60000, db });
    const url = new URL("http://localhost/api/env");
    async function edit(vars) {
      const req = new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", "X-Marina-Desktop-Token": process.env.MARINA_DESKTOP_API_TOKEN }, body: JSON.stringify({ vars }) });
      return (await handleDashboardApi(req, url, "PUT", engine, db)).status;
    }
    const invalid = await edit({ OPENAI_API_KEY: "bad\\nINJECTED=true" });
    const nonString = await edit({ OPENAI_API_KEY: 12 });
    const status = await edit({ OPENAI_API_KEY: 'literal $HOME # "quote"' });
    console.log(JSON.stringify({ invalid, nonString, status, live: process.env.OPENAI_API_KEY }));
    await engine.shutdown();
    db.close();
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      MARINA_DESKTOP_API_TOKEN: "configuration-test-capability-token-at-least-32-chars",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const errors = await new Response(proc.stderr).text();
  expect(await proc.exited, errors).toBe(0);
  const result = JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!);
  expect(result).toEqual({
    invalid: 400,
    nonString: 400,
    status: 200,
    live: 'literal $HOME # "quote"',
  });
  expect(readFileSync(path, "utf8")).toContain('# operator note\nCUSTOM_URL="${HOST}/v1" # keep');
  expect(parseEnvironment(readFileSync(path, "utf8")).OPENAI_API_KEY).toBe(result.live);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
