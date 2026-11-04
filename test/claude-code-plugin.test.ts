// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Claude Code plugin (`plugins/claude-code`) and the marketplace that
 * serves it (`.claude-plugin/marketplace.json`): the manifest launches the
 * bridge in on-demand mode, the generated skills match their sources, and
 * every skill and command carries what Claude Code reads.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLED_SEED_SKILLS,
  GENERATED_SKILLS,
  PLUGIN_DIR,
  syncClaudePlugin,
} from "../scripts/sync-claude-plugin";
import { BUILTIN_SKILLS } from "../src/agent/builtin-skills";

const root = join(import.meta.dir, "..");
const plugin = join(root, PLUGIN_DIR);
const read = (relative: string) => readFileSync(join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  expect(match).not.toBeNull();
  const meta: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

describe("Claude Code plugin manifest", () => {
  const manifest = JSON.parse(read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`)) as {
    name: string;
    version: string;
    description: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };

  it("is the marina plugin at the repository version", () => {
    expect(manifest.name).toBe("marina");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description.length).toBeGreaterThan(20);
  });

  it("launches the stdio bridge in on-demand mode through the marina bin on PATH", () => {
    // `marina` by name: a plugin install carries no checkout, and `--start`
    // adopts or starts the world, so the person never runs a server first.
    expect(manifest.mcpServers).toEqual({
      world: { command: "marina", args: ["mcp-stdio", "--start"] },
    });
  });
});

describe("Claude Code plugin marketplace", () => {
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as {
    name: string;
    owner: { name: string };
    plugins: { name: string; source: string }[];
  };

  it("lists the plugin by its directory inside the repository", () => {
    expect(marketplace.name).toBe("marina");
    expect(marketplace.owner.name).toBe("H2O.ai");
    const entry = marketplace.plugins.find((p) => p.name === "marina");
    expect(entry?.source).toBe(`./${PLUGIN_DIR}`);
    expect(existsSync(join(root, entry?.source ?? "", ".claude-plugin/plugin.json"))).toBe(true);
  });
});

describe("Claude Code plugin contents", () => {
  it("generated skills match their sources (run scripts/sync-claude-plugin.ts)", () => {
    expect(syncClaudePlugin({ root, write: false })).toEqual([]);
  });

  it("bundles only built-in procedures the server ships", () => {
    const builtin = new Set(BUILTIN_SKILLS.map((s) => s.name));
    for (const name of BUNDLED_SEED_SKILLS) expect(builtin.has(name)).toBe(true);
  });

  it("every skill has a name matching its directory and a description", () => {
    const dirs = readdirSync(join(plugin, "skills"));
    const generated = new Set(GENERATED_SKILLS.map((s) => s.name));
    expect(dirs).toContain("world");
    for (const name of generated) expect(dirs).toContain(name);
    for (const dir of dirs) {
      const meta = frontmatter(readFileSync(join(plugin, "skills", dir, "SKILL.md"), "utf8"));
      expect(meta.name).toBe(dir);
      expect(meta.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("every command has a description", () => {
    const files = readdirSync(join(plugin, "commands"));
    expect(files.sort()).toEqual(["handoff.md", "recall.md", "remember.md", "status.md"]);
    for (const file of files) {
      const meta = frontmatter(readFileSync(join(plugin, "commands", file), "utf8"));
      expect(meta.description?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("the main skill tells Claude the things only the plugin knows", () => {
    const skill = read(`${PLUGIN_DIR}/skills/world/SKILL.md`);
    for (const must of ["login", "~/.marina/mcp", "challenge", "/marina:status", "MARINA_MCP_URL"])
      expect(skill).toContain(must);
  });

  it("the README carries the one-line install", () => {
    expect(read(`${PLUGIN_DIR}/README.md`)).toContain(
      "/plugin install marina --marketplace h2oai/marina",
    );
  });
});
