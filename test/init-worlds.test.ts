// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorldSlugs,
  MutableOutput,
  NON_WORLD_FILES,
  readWorldName,
  worldMenu,
} from "../scripts/init";

const WORLDS_DIR = join(import.meta.dir, "../worlds");

/** Temp dirs created by this file, removed after each test. */
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("init world menu", () => {
  it("lists every loadable world in worlds/, default first, helpers excluded", () => {
    const slugs = listWorldSlugs(WORLDS_DIR);
    expect(slugs[0]).toBe("default");
    const onDisk = readdirSync(WORLDS_DIR)
      .filter((f) => f.endsWith(".ts") && !NON_WORLD_FILES.has(f))
      .map((f) => f.slice(0, -3));
    expect([...slugs].sort()).toEqual([...onDisk].sort());
    expect(slugs).not.toContain("seed");
    expect(slugs).not.toContain("focused-example");
    for (const w of ["showcase", "commons", "craft", "markets", "prediction-lab", "empty"])
      expect(slugs).toContain(w);
  });

  it("reads the exported world name textually and falls back to the slug", () => {
    expect(readWorldName("default", WORLDS_DIR)).toBe("Workbench");
    expect(readWorldName("showcase", WORLDS_DIR)).toBe("Showcase");
    expect(readWorldName("does-not-exist", WORLDS_DIR)).toBe("does-not-exist");
  });

  it("describes default as the Workbench, not the 25-room showcase", () => {
    const menu = worldMenu(WORLDS_DIR);
    const def = menu.find(([slug]) => slug === "default")!;
    expect(def[1]).toContain("Workbench");
    expect(def[1]).not.toContain("25");
    const showcase = menu.find(([slug]) => slug === "showcase")!;
    expect(showcase[1]).toContain("25");
    expect(menu.length).toBeGreaterThan(5);
  });

  it("falls back to the world name for a slug without a blurb", () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-worlds-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "custom.ts"),
      'const w: WorldDefinition = {\n  name: "My Custom World",\n  startRoom: "x",\n};\nexport default w;\n',
    );
    writeFileSync(join(dir, "seed.ts"), "export const x = 1;\n");
    expect(listWorldSlugs(dir)).toEqual(["custom"]);
    expect(worldMenu(dir)).toEqual([["custom", "My Custom World"]]);
  });

  it("returns only default when the directory is unreadable", () => {
    expect(listWorldSlugs("/nonexistent/worlds")).toEqual(["default"]);
  });
});

describe("MutableOutput (secret prompt echo)", () => {
  it("passes writes through normally and swallows them while muted", async () => {
    const chunks: string[] = [];
    const sink = {
      write: (c: Buffer | string) => {
        chunks.push(String(c));
        return true;
      },
    };
    const out = new MutableOutput(sink as unknown as NodeJS.WritableStream);
    const write = (s: string) => new Promise<void>((r) => out.write(s, () => r()));
    await write("visible");
    out.muted = true;
    await write("sk-secret");
    out.muted = false;
    await write("after");
    expect(chunks).toEqual(["visible", "after"]);
  });
});
