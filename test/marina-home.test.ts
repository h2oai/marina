// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Marina's one home (src/config/marina-home.ts): everything it writes for a
// person lives under ~/.marina (or MARINA_HOME), and older locations move in.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDesktopData } from "../marina-desktop/src/bun/paths";
import { startInstanceDir } from "../scripts/cli-env";
import {
  adoptLegacyPath,
  legacyLocations,
  legacyOrHome,
  marinaHome,
  marinaPathIn,
} from "../src/config/marina-home";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-home-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("marina home", () => {
  it("is ~/.marina, or MARINA_HOME", () => {
    expect(marinaHome({ HOME: "/home/ada" })).toBe("/home/ada/.marina");
    expect(marinaHome({ HOME: "/home/ada", MARINA_HOME: "/data/m" })).toBe("/data/m");
    expect(marinaPathIn({ HOME: "/home/ada" }, "world")).toBe("/home/ada/.marina/world");
  });

  it("moves an old location in once, and never strands it", () => {
    const legacy = join(root, "old", "cache");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "a"), "1");
    const path = join(root, "home", "cache");
    expect(adoptLegacyPath(path, legacy)).toBe(path);
    expect(readFileSync(join(path, "a"), "utf8")).toBe("1");
    expect(existsSync(legacy)).toBe(false);
    // Nothing old: the home path, untouched.
    expect(adoptLegacyPath(join(root, "home", "other"), join(root, "nope"))).toBe(
      join(root, "home", "other"),
    );
  });

  it("keeps an old tool folder that something outside may point at", () => {
    const legacy = join(root, "old-tool");
    mkdirSync(legacy);
    expect(legacyOrHome(join(root, "home", "tool"), legacy)).toBe(legacy);
    expect(existsSync(legacy)).toBe(true);
    rmSync(legacy, { recursive: true });
    expect(legacyOrHome(join(root, "home", "tool"), legacy)).toBe(join(root, "home", "tool"));
  });

  it("lists every older location, under the person's own home", () => {
    const list = legacyLocations({ HOME: "/home/ada" });
    expect(list).toContain("/home/ada/.local/share/marina");
    expect(list).toContain("/home/ada/Library/Application Support/Marina");
    expect(list.every((p) => p.startsWith("/home/ada/"))).toBe(true);
  });
});

describe("desktop data", () => {
  it("moves only the desktop's own files; other tools' folders stay", () => {
    const legacy = join(root, "share", "marina");
    mkdirSync(join(legacy, "corpora"), { recursive: true });
    mkdirSync(join(legacy, "logs"));
    writeFileSync(join(legacy, "marina.db"), "db");
    const data = join(root, "home", "desktop");
    expect(adoptDesktopData(data, legacy)).toBe(data);
    expect(readFileSync(join(data, "marina.db"), "utf8")).toBe("db");
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(existsSync(join(legacy, "corpora"))).toBe(true);
    expect(existsSync(join(data, "corpora"))).toBe(false);
  });
});

describe("where marina start runs its world", () => {
  // No source checkout's .env: the answer must not depend on the developer's.
  const NO_CHECKOUT = { checkoutDir: undefined };
  const env = () => ({ HOME: join(root, "user") });

  it("the home's world/ when the folder is not an instance", () => {
    const cwd = join(root, "somewhere");
    mkdirSync(cwd);
    expect(startInstanceDir(cwd, env(), NO_CHECKOUT)).toEqual({
      dir: join(root, "user", ".marina", "world"),
      home: true,
    });
  });

  it("the home and the code installed in it are never the world folder", () => {
    const home = join(root, "user", ".marina");
    mkdirSync(join(home, "app"), { recursive: true });
    writeFileSync(join(home, ".env"), "MARINA_WORLD=default\n");
    const world = { dir: join(home, "world"), home: true };
    expect(startInstanceDir(home, env(), NO_CHECKOUT)).toEqual(world);
    expect(startInstanceDir(join(home, "app"), env(), NO_CHECKOUT)).toEqual(world);
  });

  it("a project's own .env does not make it an instance", () => {
    const cwd = join(root, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, ".env"), "OPENAI_API_KEY=sk-x\nDATABASE_URL=postgres://x\n");
    expect(startInstanceDir(cwd, env(), NO_CHECKOUT).home).toBe(true);
  });

  it("the folder itself when it holds a world, Marina settings, or a location is set", () => {
    const world = join(root, "world");
    mkdirSync(world);
    writeFileSync(join(world, "marina.db"), "");
    expect(startInstanceDir(world, env(), NO_CHECKOUT)).toEqual({ dir: world, home: false });

    const instance = join(root, "instance");
    mkdirSync(instance);
    writeFileSync(join(instance, ".env"), "MARINA_WORLD=default\n");
    expect(startInstanceDir(instance, env(), NO_CHECKOUT).home).toBe(false);

    const cwd = join(root, "elsewhere");
    mkdirSync(cwd);
    expect(startInstanceDir(cwd, { ...env(), DB_PATH: "/srv/m.db" }, NO_CHECKOUT).home).toBe(false);
  });
});
