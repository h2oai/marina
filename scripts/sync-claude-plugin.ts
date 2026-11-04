#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run scripts/sync-claude-plugin.ts [--check]` — the generated parts of the
 * Claude Code plugin (`plugins/claude-code`), derived from files kept elsewhere
 * in the repository so the plugin never drifts from them:
 *
 *   - `skills/<name>/SKILL.md` for the shared `marina-memory` skill and the
 *     world's built-in procedures (`seeds/skills/*.md`, the ones that make
 *     sense outside a resident's loop), each with the frontmatter Claude Code
 *     reads (`name`, `description`) and a line naming its source;
 *   - the plugin version in `.claude-plugin/plugin.json`, the root version.
 *
 * `--check` writes nothing and exits 1 naming each file that would change
 * (`test/claude-code-plugin.test.ts` runs the same check).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSkillMarkdown } from "../src/agent/skill-import";

export const PLUGIN_DIR = "plugins/claude-code";

/** Built-in procedures that stand on their own in a Claude Code session. */
export const BUNDLED_SEED_SKILLS = [
  "answer-request",
  "decompose-multihop",
  "intake-triage",
  "quantitative-estimates",
  "solve-math",
] as const;

/** A plugin skill generated from a repository file. */
export interface GeneratedSkill {
  /** `skills/<name>/SKILL.md` under the plugin. */
  name: string;
  /** Repository-relative source. */
  source: string;
  /** Rebuild the plugin copy from the source text. */
  render: (source: string) => string;
}

function withGeneratedHeader(name: string, description: string, body: string, source: string) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `<!-- Generated from ${source} by scripts/sync-claude-plugin.ts; edit the source. -->`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

export const GENERATED_SKILLS: readonly GeneratedSkill[] = [
  {
    name: "marina-memory",
    source: "skills/marina-memory/SKILL.md",
    // Already a Claude-Code skill file: copied as is, plus the provenance line.
    render: (text) => {
      const end = text.indexOf("\n---", 3);
      const frontmatter = text.slice(0, end + 4);
      const body = text.slice(end + 4);
      return `${frontmatter}\n<!-- Generated from skills/marina-memory/SKILL.md by scripts/sync-claude-plugin.ts; edit the source. -->${body}`;
    },
  },
  ...BUNDLED_SEED_SKILLS.map((name) => ({
    name,
    source: `seeds/skills/${name}.md`,
    render: (text: string) => {
      const skill = parseSkillMarkdown(text);
      return withGeneratedHeader(
        skill.name,
        skill.description,
        skill.body,
        `seeds/skills/${name}.md`,
      );
    },
  })),
];

export interface SyncOptions {
  root?: string;
  /** Write the files (default); false only reports drift. */
  write?: boolean;
}

/** Each plugin file whose generated content differs from what is on disk (empty when in sync). */
export function syncClaudePlugin(opts: SyncOptions = {}): string[] {
  const root = resolve(opts.root ?? join(import.meta.dir, ".."));
  const write = opts.write ?? true;
  const drift: string[] = [];
  const put = (relative: string, content: string) => {
    const path = join(root, relative);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === content) return;
    drift.push(relative);
    if (!write) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  for (const skill of GENERATED_SKILLS) {
    const source = readFileSync(join(root, skill.source), "utf8");
    put(`${PLUGIN_DIR}/skills/${skill.name}/SKILL.md`, skill.render(source));
  }

  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const manifestPath = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
  const manifestText = readFileSync(join(root, manifestPath), "utf8");
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (manifest.version !== version) {
    manifest.version = version;
    put(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return drift;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const drift = syncClaudePlugin({ write: !check });
  if (drift.length === 0) {
    console.log(
      check ? "Claude Code plugin is in sync." : "Claude Code plugin: nothing to update.",
    );
  } else if (check) {
    console.error(
      `Claude Code plugin is out of date — run \`bun run scripts/sync-claude-plugin.ts\`:\n  ${drift.join("\n  ")}`,
    );
    process.exit(1);
  } else {
    console.log(`Updated:\n  ${drift.join("\n  ")}`);
  }
}
