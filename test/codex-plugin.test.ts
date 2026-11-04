// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCodexPlugin } from "../scripts/build-codex-plugin";
import { serveMemory } from "../src/memory/server";
import { McpServerAdapter } from "../src/net/mcp/mcp-server";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

interface ServerEntry {
  command: string;
  args: string[];
}

function entry(plugin: string, name: string): ServerEntry {
  const config = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
  const server = config.mcpServers[name] as ServerEntry;
  return {
    command: server.command,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emulate plugin host path expansion
    args: server.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", plugin)),
  };
}

async function connect(plugin: string, name: string, cwd: string) {
  const client = new Client({ name: "marina-plugin-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({ ...entry(plugin, name), cwd, stderr: "pipe" }),
      { timeout: 5000 },
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function memoryCall(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).toBeFalsy();
  const result = response.structuredContent as { ok: boolean; result: Record<string, unknown> };
  expect(result.ok).toBe(true);
  return result.result;
}

it("runs the relocated bundle without checkout dependencies, resumes memory, and authenticates a world", async () => {
  const secret = `plugin-transport-${crypto.randomUUID()}`;
  using _state = scopeProcessState({ rateLimitBypass: true, env: { MODEL_API_KEYS: secret } });
  const directory = mkdtempSync(join(tmpdir(), "marina-plugin-"));
  const memory = serveMemory({ dbPath: join(directory, "memory.db"), port: 0 });
  const fixture = createTestEngine();
  const world = new McpServerAdapter(fixture.engine, 0);
  const clients: Client[] = [];
  try {
    world.start();
    fixture.engine.start();
    const credential = memory.db.issueMemoryCredential(
      memory.db.ensurePrincipal({ type: "service", displayName: "codex-plugin" }).principal_id,
    );
    const url = `http://127.0.0.1:${memory.server.port}`;
    const http = new MarinaMemoryClient(url, credential.token);
    const space = (await http.createSpace("plugin")).id;
    const credentials = join(directory, "private-memory.json");
    writeFileSync(credentials, JSON.stringify({ token: credential.token, spaceId: space }), {
      mode: 0o600,
    });
    const worldCredentials = join(directory, "private-world.json");
    writeFileSync(worldCredentials, JSON.stringify({ token: secret }), { mode: 0o600 });
    const built = await buildCodexPlugin({
      output: join(directory, "build"),
      memory: { url, credentials },
      world: { url: `http://127.0.0.1:${world.getPort()}/mcp`, credentials: worldCredentials },
    });
    const relocated = join(directory, "relocated package");
    renameSync(built, relocated);
    const plugin = join(relocated, "plugins/marina");
    for (const path of new Bun.Glob("**/*").scanSync({
      cwd: relocated,
      dot: true,
      onlyFiles: true,
    })) {
      const contents = readFileSync(join(relocated, path), "utf8");
      expect(contents).not.toContain(credential.token);
      expect(contents).not.toContain(secret);
    }
    expect(readFileSync(join(plugin, "skills/marina-memory/SKILL.md"), "utf8")).toBe(
      readFileSync(join(import.meta.dir, "../skills/marina-memory/SKILL.md"), "utf8"),
    );
    const client = await connect(plugin, "marina_memory", directory);
    clients.push(client);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("memory_workflow");
    const source = await memoryCall(client, "memory_service", {
      operation: "capture",
      key: "evidence-1",
      input: { content: "Zephyr rollback uses the retained image." },
    });
    await memoryCall(client, "memory_service", {
      operation: "save_checkpoint",
      id: "codex-work",
      key: "checkpoint-1",
      input: { expected_version: 0, source_ids: [source.id], data: { next: "verify rollback" } },
    });
    await client.close();
    const resumed = await connect(plugin, "marina_memory", directory);
    clients.push(resumed);
    expect(
      await memoryCall(resumed, "memory_service", { operation: "checkpoint", id: "codex-work" }),
    ).toMatchObject({ data: { next: "verify rollback" } });
    expect(await memoryCall(resumed, "memory_retrieve", { task: "Zephyr rollback" })).toMatchObject(
      { evidence: [expect.objectContaining({ id: source.id })] },
    );
    memory.db.revokeWorkloadCredential(credential.credentialId);
    expect((await resumed.callTool({ name: "memory_query", arguments: {} })).isError).toBe(true);
    await expect(connect(plugin, "marina_memory", directory)).rejects.toThrow();

    const resident = await connect(plugin, "marina_world", directory);
    clients.push(resident);
    expect((await resident.callTool({ name: "look", arguments: {} })).isError).toBe(true);
    expect(
      (await resident.callTool({ name: "login", arguments: { name: "PluginResident" } })).isError,
    ).toBeFalsy();
    expect((await resident.callTool({ name: "look", arguments: {} })).isError).toBeFalsy();
    writeFileSync(worldCredentials, JSON.stringify({ token: "invalid" }));
    await expect(connect(plugin, "marina_world", directory)).rejects.toThrow();

    // Malformed credentials must not leak their contents to stderr or protocol output.
    writeFileSync(credentials, `{"token":"${credential.token}",BROKEN`);
    const command = entry(plugin, "marina_memory");
    const proc = Bun.spawn([command.command, ...command.args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Cannot read credential file");
    expect(stderr).not.toContain(credential.token);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    world.stop();
    await fixture.dispose();
    await memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it("builds memory only without a failing world connection or a world skill", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-plugin-memory-"));
  try {
    const output = await buildCodexPlugin({
      output: join(directory, "package"),
      memory: {
        url: "http://127.0.0.1:3301",
        credentials: join(directory, "not-provisioned.json"),
      },
    });
    const plugin = join(output, "plugins/marina");
    expect(
      Object.keys(JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")).mcpServers),
    ).toEqual(["marina_memory"]);
    expect(existsSync(join(plugin, "skills/marina-world"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
    expect(existsSync(join(plugin, manifest.mcpServers))).toBe(true);
    expect(existsSync(join(plugin, manifest.onboardingSkill))).toBe(true);
    const command = entry(plugin, "marina_memory");
    const proc = Bun.spawn([command.command, ...command.args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("Cannot read credential file");
    await expect(
      buildCodexPlugin({ output, world: { url: "http://localhost:3301/mcp" } }),
    ).rejects.toThrow("already exists");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("rejects credential-bearing URLs and in-package credential paths before writing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-plugin-input-"));
  const output = join(directory, "package");
  try {
    for (const url of [
      "https://user:secret@example.com/mcp",
      "https://example.com/mcp?token=secret",
      "file:///tmp/mcp",
    ]) {
      await expect(buildCodexPlugin({ output, world: { url } })).rejects.toThrow(
        "without credentials",
      );
    }
    await expect(
      buildCodexPlugin({
        output,
        memory: { url: "http://localhost:3301", credentials: join(output, "secret.json") },
      }),
    ).rejects.toThrow("outside");
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
