// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { COMMAND_CATEGORIES } from "../src/engine/commands/help";
import { Engine } from "../src/engine/engine";
import { SAFETY_GATES } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { MIGRATIONS } from "../src/persistence/schema";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const readDoc = async (path: string) => Bun.file(path).text();

const currentDocs = [
  "README.md",
  "SKILL.md",
  "skills/marina-claude/SKILL.md",
  "docs/guides/agent-development.md",
  "docs/guides/coding.md",
  "docs/guides/commands.md",
  "docs/guides/building-worlds.md",
  "docs/guides/federation.md",
  "docs/guides/getting-started.md",
  "docs/guides/coordination.md",
  "docs/guides/troubleshooting.md",
  "docs/guides/markets.md",
  "docs/guides/memory.md",
  "docs/guides/civic-substrate.md",
  "docs/guides/configuration.md",
  "docs/marina-foundational-paper.md",
];

describe("documentation contract", () => {
  it("keeps README pointed at SKILL.md as the command field guide", async () => {
    const readme = await readDoc("README.md");

    expect(readme).toContain(
      "The complete command reference and operational manual live in [SKILL.md](SKILL.md).",
    );
    expect(readme).toContain("`SKILL.md` is the agent-facing field guide.");
  });

  it("keeps root SKILL.md anchored on agent and prompt-surface contracts", async () => {
    const skill = await readDoc("SKILL.md");

    expect(skill).toContain("## Agent Operating Contract");
    expect(skill).toContain("## Prompt and Knowledge Surfaces");
  });

  it("keeps the Claude skill scoped to connection modes and root Marina guidance", async () => {
    const claudeSkill = await readDoc("skills/marina-claude/SKILL.md");

    expect(claudeSkill).toContain("## Scope");
    expect(claudeSkill).toContain("This skill is a Claude connection adapter.");
    expect(claudeSkill).toContain("use the root `SKILL.md` served by the Marina instance");
    expect(claudeSkill).toContain("`GET /api/skill`");
    expect(claudeSkill).toContain("the repository copy at `SKILL.md`");
  });

  it("does not preserve stale seeded role and trait count claims", async () => {
    const docs = await Promise.all([readDoc("README.md"), readDoc("SKILL.md")]);

    for (const doc of docs) {
      expect(doc).not.toMatch(/\b(?:six|6) roles and (?:nine|9) traits\b/i);
    }
  });

  it("keeps current command examples aligned with implemented command names", async () => {
    const docs = await Promise.all(currentDocs.map(readDoc));

    for (const doc of docs) {
      expect(doc).not.toContain("reflection <");
      expect(doc).not.toMatch(/\bpool join\b/);
      expect(doc).not.toMatch(/\bpool [\w:-]+ read\b/);
      expect(doc).not.toMatch(/\bbuild command [\w-]+ \|/);
      expect(doc).not.toContain("build metrics");
      expect(doc).not.toMatch(/\bboard reply [\w-]+ \|/);
      expect(doc).not.toMatch(/\bboard vote [\w-]+ \|/);
      expect(doc).not.toMatch(/\bsource room\b/);
    }
  });

  it("keeps current access docs focused on existing gates, not stale rank ladders", async () => {
    const docs = await Promise.all(currentDocs.map(readDoc));

    for (const doc of docs) {
      expect(doc).not.toContain("auto-promoted to rank 4 (admin)");
      expect(doc).not.toContain("minRank is the only permission gate");
      expect(doc).not.toContain("Spawning requires Builder rank");
      expect(doc).not.toContain("Builder rank (2)");
      expect(doc).not.toMatch(/\brank\s*[5-9]\+\b/i);
      expect(doc).not.toMatch(/\b(?:Guardian|Steward|Sovereign)\+/);
      expect(doc).not.toContain("Sovereign only");
      expect(doc).not.toContain("Admin (Rank 4)");
      expect(doc).not.toContain("API Keys (Admin)");
      expect(doc).not.toContain("Platform Adapters (Admin)");
      expect(doc).not.toContain("Ask an admin to promote you");
      expect(doc).not.toContain("Promotes to Canvas rank");
      expect(doc).not.toContain("Rank: Guest (0)");
      expect(doc).not.toContain("Rank: Citizen (1)");
      expect(doc).not.toMatch(/Resolve market \((Builder|Coordinator) rank required\)/);
    }
  });

  it("keeps the fast-loop contract visible in current guidance", async () => {
    const [readme, skill, behaviorGuide] = await Promise.all([
      readDoc("README.md"),
      readDoc("SKILL.md"),
      readDoc("docs/guides/behavior-surfaces.md"),
    ]);

    for (const doc of [readme, skill, behaviorGuide]) {
      expect(doc).toContain("Fast Loop");
      expect(doc).toContain("canvas intent claim");
      expect(doc).toContain("crew dispatch");
      expect(doc).toContain("brief social");
    }
  });
});

// ─── Structural (positive) contract ──────────────────────────────────────────
// The assertions above are a stale-string blocklist: they catch documentation
// that drifted, but never documentation that is MISSING. The block below is the
// positive half — it reflects over the live registries (safety gates, builtin
// commands, migrations, env vars) and fails when a new one lands without its
// documentation. Anything that deliberately has no prose home is listed in an
// explicit allowlist next to the reason.

/** Match `token` as a whole word, so `code.exec` is not satisfied by `code.exec.unrestricted`. */
const mentions = (haystack: string, token: string): boolean =>
  new RegExp(`(^|[^\\w.-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w.-]|$)`).test(
    haystack,
  );

/**
 * Builtins whose prose home is the in-code `help` category map rather than
 * `docs/guides/commands.md`. Each is a local utility or an inspection verb that
 * `help` fully describes; the guide covers the world-facing primitives. A NEW
 * command must land in the guide or be added here on purpose.
 */
const COMMANDS_DOCUMENTED_ONLY_IN_HELP = new Set([
  "calc", // arithmetic scratchpad — `help calc` is the whole reference
  "debrief", // session-close view composed from note/standing primitives
  "observe", // experiment-scoped observation verb, documented under `experiment`
  "system-prompt", // read-only prompt inspection (alias `sysprompt`)
]);

/**
 * `MARINA_*` names that `.env.example` documents but no source file spells out
 * literally, because the code composes them at runtime. Keep the composing site
 * in the comment so the allowlist stays auditable.
 */
const ENV_VARS_COMPOSED_AT_RUNTIME = new Set([
  // `src/net/model-api/upstream.ts` builds `MARINA_DEFAULT_${PROVIDER}_MODEL`
  // from the provider name, so no literal appears anywhere in the tree.
  "MARINA_DEFAULT_GEMINI_MODEL",
  "MARINA_DEFAULT_GROQ_MODEL",
  "MARINA_DEFAULT_LLAMA_MODEL",
  "MARINA_DEFAULT_OLLAMA_MODEL",
  "MARINA_DEFAULT_OPENAI_MODEL",
  "MARINA_DEFAULT_OPENROUTER_MODEL",
]);

const TEST_DB = "test_docs_contract.db";

describe("documentation contract — structure", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeAll(() => {
    // A db-backed engine constructs every manager, so all conditionally
    // registered commands register (same setup as test/help-coverage.test.ts).
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterAll(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("documents every safety gate in the civic-substrate architecture page", async () => {
    const doc = await readDoc("docs/architecture/civic-substrate.md");
    const ids = Object.values(SAFETY_GATES).map((gate) => gate.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !mentions(doc, id))).toEqual([]);
  });

  it("resolves every registered builtin to a source file under src/engine/commands/", async () => {
    const glob = new Bun.Glob("**/*.ts");
    let sources = "";
    for await (const file of glob.scan({ cwd: "src/engine/commands" })) {
      sources += await Bun.file(`src/engine/commands/${file}`).text();
    }

    const unresolved = engine.commands
      .allBuiltins()
      .map((cmd) => cmd.name)
      .filter((name) => !sources.includes(`name: "${name}"`));
    expect(unresolved).toEqual([]);
  });

  it("documents every registered builtin in the command guide or a help category", async () => {
    const guide = await readDoc("docs/guides/commands.md");
    const categorized = new Set(Object.values(COMMAND_CATEGORIES).flat());
    const names = engine.commands.allBuiltins().map((cmd) => cmd.name);

    const undocumented = names.filter(
      (name) => !mentions(guide, name) && !COMMANDS_DOCUMENTED_ONLY_IN_HELP.has(name),
    );
    expect(undocumented).toEqual([]);

    // The allowlist is not an escape hatch: an exempt command must still be
    // reachable from `help` via a real category.
    const exemptWithoutCategory = [...COMMANDS_DOCUMENTED_ONLY_IN_HELP].filter(
      (name) => !categorized.has(name),
    );
    expect(exemptWithoutCategory).toEqual([]);

    // And the allowlist must not outlive the commands it covers.
    const stale = [...COMMANDS_DOCUMENTED_ONLY_IN_HELP].filter((name) => !names.includes(name));
    expect(stale).toEqual([]);
  });

  it("keeps migration versions contiguous from 1 with no duplicates", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    const max = Math.max(...versions);

    expect(new Set(versions).size).toBe(versions.length); // no duplicates
    expect(versions.length).toBe(max); // none missing
    expect([...versions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: max }, (_, i) => i + 1),
    );
    // Migrations are append-only: the array order IS the apply order.
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("links every architecture deep-dive from the architecture README", async () => {
    const readme = await readDoc("docs/architecture/README.md");
    const glob = new Bun.Glob("*.md");
    const pages: string[] = [];
    for await (const file of glob.scan({ cwd: "docs/architecture" })) {
      if (file !== "README.md") pages.push(file);
    }

    expect(pages.length).toBeGreaterThan(0);
    expect(pages.filter((page) => !readme.includes(`(${page})`)).sort()).toEqual([]);
  });

  it("resolves every docs/architecture pointer in CLAUDE.md", async () => {
    const claudeMd = await readDoc("CLAUDE.md");
    const pointers = [...new Set(claudeMd.match(/docs\/architecture\/[\w.-]+\.md/g) ?? [])];

    expect(pointers.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const pointer of pointers) {
      if (!(await Bun.file(pointer).exists())) broken.push(pointer);
    }
    expect(broken).toEqual([]);
  });

  it("reads every MARINA_* variable documented in .env.example", async () => {
    const example = await readDoc(".env.example");
    const documented = [...new Set(example.match(/MARINA_[A-Z0-9_]+/g) ?? [])].sort();
    expect(documented.length).toBeGreaterThan(50);

    // World definitions in worlds/ are shipped code that reads env directly
    // (see package.json "files"), so they count alongside src/ and scripts/.
    const roots = ["src", "scripts", "worlds"];
    const glob = new Bun.Glob("**/*.ts");
    let tree = "";
    for (const root of roots) {
      for await (const file of glob.scan({ cwd: root })) {
        tree += await Bun.file(`${root}/${file}`).text();
      }
    }

    const unread = documented.filter(
      (name) => !tree.includes(name) && !ENV_VARS_COMPOSED_AT_RUNTIME.has(name),
    );
    expect(unread).toEqual([]);

    // Keep the composed-name allowlist honest: each entry must still be
    // documented in .env.example.
    expect([...ENV_VARS_COMPOSED_AT_RUNTIME].filter((n) => !documented.includes(n))).toEqual([]);
  });
});
