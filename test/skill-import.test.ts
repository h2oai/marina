// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSkillFiles,
  formatSkillContent,
  parseSkillMarkdown,
} from "../src/agent/skill-import";

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
