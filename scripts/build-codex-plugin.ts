#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { getErrorMessage } from "../src/engine/errors";

const ROOT = resolve(import.meta.dir, "..");

export interface CodexPluginOptions {
  output: string;
  memory?: { url: string; credentials: string };
  world?: { url: string; credentials?: string };
}

function connectionUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTP(S) service URL without credentials, query, or fragment");
  }
  return url.href;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve symlinked ancestors even when the last directory has not been created. */
function physicalPath(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : join(physicalPath(dirname(path)), relative(dirname(path), path));
}

/** Emit a self-contained local marketplace, without installing it or reading secrets. */
export async function buildCodexPlugin(options: CodexPluginOptions): Promise<string> {
  const output = resolve(options.output);
  if (existsSync(output)) throw new Error("Output already exists; choose a new --output directory");
  if (!options.memory && !options.world) throw new Error("Configure memory or a world connection");
  const plugin = join(output, "plugins", "marina");
  const servers: Record<string, { type: "stdio"; command: string; args: string[] }> = {};
  for (const [mode, connection] of Object.entries({
    memory: options.memory,
    world: options.world,
  })) {
    if (!connection) continue;
    const args = [
      "--no-env-file",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the plugin host
      "${PLUGIN_ROOT}/server/mcp.js",
      "--mode",
      mode,
      "--url",
      connectionUrl(connection.url),
    ];
    if (connection.credentials) {
      const credentials = resolve(connection.credentials);
      if (inside(physicalPath(output), physicalPath(credentials))) {
        throw new Error("Keep credential files outside the plugin marketplace directory");
      }
      args.push("--credentials", credentials);
    }
    servers[`marina_${mode}`] = { type: "stdio", command: process.execPath, args };
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output); // Refuse a concurrent creator rather than overwrite its files.
  mkdirSync(join(plugin, "server"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(ROOT, "scripts/codex-plugin-mcp.ts")],
    outdir: join(plugin, "server"),
    naming: "mcp.js",
    target: "bun",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Plugin MCP bundle failed");
  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const metadata = JSON.parse(
    readFileSync(join(ROOT, "plugins/marina/.codex-plugin/plugin.json"), "utf8"),
  );
  writeJson(join(plugin, ".codex-plugin/plugin.json"), { ...metadata, version });
  writeJson(join(plugin, ".mcp.json"), { mcpServers: servers });
  cpSync(join(ROOT, "plugins/marina/skills/marina-setup"), join(plugin, "skills/marina-setup"), {
    recursive: true,
  });
  cpSync(join(ROOT, "skills/marina-memory"), join(plugin, "skills/marina-memory"), {
    recursive: true,
  });
  if (options.world) {
    cpSync(join(ROOT, "plugins/marina/skills/marina-world"), join(plugin, "skills/marina-world"), {
      recursive: true,
    });
  }
  cpSync(join(ROOT, "LICENSE"), join(plugin, "LICENSE"));
  cpSync(join(ROOT, "docs/guides/codex-plugin.md"), join(plugin, "README.md"));
  writeJson(join(output, ".agents/plugins/marketplace.json"), {
    name: "marina-local",
    interface: { displayName: "Marina" },
    plugins: [
      {
        name: "marina",
        source: { source: "local", path: "./plugins/marina" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  });
  return output;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        output: { type: "string", default: "dist/codex-plugin" },
        "memory-url": { type: "string", default: "http://127.0.0.1:3301" },
        "memory-credentials": { type: "string", default: "data/codex-memory.json" },
        "world-url": { type: "string" },
        "world-credentials": { type: "string" },
        "world-only": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(`Build Marina's Codex plugin and local marketplace.
  --output PATH               New output directory (default dist/codex-plugin)
  --memory-url URL            Memory HTTP service (default http://127.0.0.1:3301)
  --memory-credentials PATH   Private JSON from memory init (default data/codex-memory.json)
  --world-url URL             Include world MCP, e.g. http://127.0.0.1:3302/mcp
  --world-credentials PATH    Private JSON containing a world transport token
  --world-only                Omit the dedicated memory connection; requires --world-url
Credentials are referenced by absolute path, never read or copied. Bun is required at runtime.
Existing output directories are refused. See docs/guides/codex-plugin.md.`);
    } else {
      if (values["world-only"] && !values["world-url"])
        throw new Error("--world-only requires --world-url");
      if (values["world-credentials"] && !values["world-url"])
        throw new Error("--world-credentials requires --world-url");
      const output = await buildCodexPlugin({
        output: values.output,
        ...(!values["world-only"]
          ? { memory: { url: values["memory-url"], credentials: values["memory-credentials"] } }
          : {}),
        ...(values["world-url"]
          ? { world: { url: values["world-url"], credentials: values["world-credentials"] } }
          : {}),
      });
      console.log(
        `Built Marina plugin marketplace: ${output}\nAdd this directory with codex plugin marketplace add, then install marina@marina-local.\nStart a new Codex session and use $marina:marina-setup.`,
      );
    }
  } catch (error) {
    console.error(`Marina plugin build: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
