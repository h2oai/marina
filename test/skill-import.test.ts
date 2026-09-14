// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverSkillFiles,
  formatSkillContent,
  parseSkillMarkdown,
  resolveConfinedSkillPath,
} from "../src/agent/skill-import";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("parseSkillMarkdown", () => {
  it("parses a minimal valid skill", () => {
    const src = `---
name: my-skill
description: it does a thing
---

Step 1. Do the thing.`;
    const s = parseSkillMarkdown(src);
    expect(s.name).toBe("my-skill");
    expect(s.description).toBe("it does a thing");
    expect(s.tags).toEqual([]);
    expect(s.importance).toBe(6);
    expect(s.body).toContain("Step 1");
  });

  it("parses tags as comma-separated strings", () => {
    const src = `---
name: tagged
description: has tags
tags: foo, bar , baz
---

body`;
    const s = parseSkillMarkdown(src);
    expect(s.tags).toEqual(["foo", "bar", "baz"]);
  });

  it("parses importance and clamps to 1..10", () => {
    const high = parseSkillMarkdown(`---
name: a
description: b
importance: 99
---
body`);
    const low = parseSkillMarkdown(`---
name: a
description: b
importance: -5
---
body`);
    const mid = parseSkillMarkdown(`---
name: a
description: b
importance: 7
---
body`);
    expect(high.importance).toBe(10);
    expect(low.importance).toBe(1);
    expect(mid.importance).toBe(7);
  });

  it("throws when frontmatter is missing", () => {
    expect(() => parseSkillMarkdown("just a body, no frontmatter")).toThrow(/frontmatter/i);
  });

  it("throws when name is missing", () => {
    const src = `---
description: nameless
---

body`;
    expect(() => parseSkillMarkdown(src)).toThrow(/name/i);
  });

  it("throws when description is missing", () => {
    const src = `---
name: descless
---

body`;
    expect(() => parseSkillMarkdown(src)).toThrow(/description/i);
  });

  it("throws when body is empty", () => {
    const src = `---
name: empty
description: no body
---
`;
    expect(() => parseSkillMarkdown(src)).toThrow(/body/i);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nname: cr\r\ndescription: lf\r\n---\r\n\r\nbody line";
    const s = parseSkillMarkdown(src);
    expect(s.name).toBe("cr");
    expect(s.body).toContain("body line");
  });
});

describe("formatSkillContent", () => {
  it("produces the same shape as `skill store`", () => {
    const content = formatSkillContent({
      name: "x",
      description: "y",
      tags: [],
      importance: 6,
      body: "do this then that",
    });
    expect(content).toBe("[Skill: x] y || Actions: do this then that");
  });
});

describe("discoverSkillFiles", () => {
  const tmp = `/tmp/test-skill-discover-${Date.now()}`;

  it("returns empty array for missing directory", () => {
    expect(discoverSkillFiles(`/tmp/nope-${Date.now()}`)).toEqual([]);
  });

  it("finds .md files sorted by basename", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "z-third.md"), "x");
    writeFileSync(join(tmp, "a-first.md"), "x");
    writeFileSync(join(tmp, "m-second.md"), "x");
    writeFileSync(join(tmp, "ignore.txt"), "x"); // not .md
    const files = discoverSkillFiles(tmp);
    expect(files.map((f) => f.split("/").pop())).toEqual([
      "a-first.md",
      "m-second.md",
      "z-third.md",
    ]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("resolveConfinedSkillPath", () => {
  const root = join(tmpdir(), `marina-skill-confine-${process.pid}`);
  const outside = join(tmpdir(), `marina-skill-outside-${process.pid}`);

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(join(root, "skills"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "skills", "ok.md"), "---\nname: ok\ndescription: d\n---\nbody");
    writeFileSync(join(outside, "secret.md"), "---\nname: s\ndescription: d\n---\nbody");
    symlinkSync(join(outside, "secret.md"), join(root, "skills", "escape.md"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts relative and absolute paths inside the root", () => {
    const real = realpathSync(join(root, "skills", "ok.md"));
    expect(resolveConfinedSkillPath("skills/ok.md", root)).toBe(real);
    expect(resolveConfinedSkillPath(join(root, "skills", "ok.md"), root)).toBe(real);
  });

  it("rejects .. segments", () => {
    expect(() => resolveConfinedSkillPath("skills/../../etc/passwd", root)).toThrow(/'\.\.'/);
    expect(() => resolveConfinedSkillPath("../secret.md", root)).toThrow(/'\.\.'/);
  });

  it("rejects absolute paths outside the root", () => {
    expect(() => resolveConfinedSkillPath(join(outside, "secret.md"), root)).toThrow(
      /must be inside/,
    );
    expect(() => resolveConfinedSkillPath("/etc/passwd", root)).toThrow(/must be inside/);
  });

  it("rejects symlinks that resolve outside the root", () => {
    expect(() => resolveConfinedSkillPath("skills/escape.md", root)).toThrow(/symlink/);
  });

  it("reports a missing file without leaking anything else", () => {
    expect(() => resolveConfinedSkillPath("skills/nope.md", root)).toThrow(/not found/);
  });
});

describe("skill import command (rank gate + cwd confinement)", () => {
  const TEST_DB = "test_skill_import_cmd.db";
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("refuses below rank 3", () => {
    engine.processCommand(conn.entity!, "skill import seeds/skills/answer-request.md");
    expect(stripAnsi(conn.lastText())).toContain(
      "skill import requires rank 3+ (host file access)",
    );
    expect(db.getNotesByType("Alice", "skill").length).toBe(0);
  });

  it("at rank 3 refuses paths that escape the working directory", () => {
    setRank(engine.entities.get(conn.entity!)!, 3);
    engine.processCommand(conn.entity!, "skill import ../../etc/passwd");
    expect(stripAnsi(conn.lastText())).toContain("may not contain '..'");
    conn.clear();
    engine.processCommand(conn.entity!, "skill import /etc/passwd");
    expect(stripAnsi(conn.lastText())).toContain("must be inside");
    expect(db.getNotesByType("Alice", "skill").length).toBe(0);
  });

  it("at rank 3 imports a skill file that lives under cwd", () => {
    setRank(engine.entities.get(conn.entity!)!, 3);
    engine.processCommand(conn.entity!, "skill import seeds/skills/answer-request.md");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("answer-request");
    const skills = db.getNotesByType("Alice", "skill");
    expect(skills.length).toBe(1);
    expect(skills[0]?.content).toContain("[Skill: answer-request]");
    // Same file via its absolute path is also fine (inside cwd).
    conn.clear();
    engine.processCommand(conn.entity!, `skill import ${resolve("seeds/skills/solve-math.md")}`);
    expect(db.getNotesByType("Alice", "skill").length).toBe(2);
  });
});
