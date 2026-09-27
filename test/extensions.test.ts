// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRouter } from "../src/engine/command-router";
import { Engine } from "../src/engine/engine";
import { extensionWidgets, loadExtensions } from "../src/extensions/loader";
import { roomId } from "../src/types";
import { loadWorld } from "../src/world/world-loader";
import { MockConnection, makeTestRoom } from "./helpers";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "marina-extension-"));
  directories.push(dir);
  return dir;
}

test("runtime definitions reject missing names rather than coercing undefined into a command", () => {
  const router = new CommandRouter();
  expect(() =>
    router.registerOwned("extension:test", {
      name: undefined as unknown as string,
      help: "Invalid",
      handler() {},
    }),
  ).toThrow("Invalid command");
  expect(router.allBuiltins()).toEqual([]);
});

test("owned command registration validates aliases atomically and only its owner can remove it", () => {
  const router = new CommandRouter();
  router.registerBuiltin({ name: "look", help: "Look", handler() {} });
  expect(() =>
    router.registerOwned("extension:test", {
      name: "inspect",
      aliases: ["look"],
      help: "Inspect",
      handler() {},
    }),
  ).toThrow("already registered");
  expect(router.getDef("inspect")).toBeUndefined();
  router.registerOwned("extension:test", {
    name: "inspect",
    aliases: ["peek"],
    help: "Inspect",
    handler() {},
  });
  expect(router.unregisterOwned("extension:other", "peek")).toBe(false);
  router.removeOwner("extension:test");
  expect(router.getDef("peek")).toBeUndefined();
  expect(router.getDef("look")).toBeDefined();
});

test("installed extension runs through rank enforcement, publishes declarative widgets and cleans up", async () => {
  const dir = fixture();
  writeFileSync(
    join(dir, "marina-plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", apiVersion: 1, entry: "index.mjs" }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    `export default { activate(ctx) {
    ctx.registerCommand({name:"fixture-command", help:"Fixture command", minRank:9, run(ctx) { ctx.reply("extension completed"); }});
    ctx.registerWidget({id:"health", title:"Instance health", slot:"sidebar", source:"readiness"});
  }};`,
  );
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60000 });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const conn = new MockConnection("fixture");
  engine.addConnection(conn);
  engine.spawnEntity(conn.id, "Visitor");
  const close = await loadExtensions(engine, [dir]);
  try {
    expect(extensionWidgets(engine)).toHaveLength(1);
    await engine.processCommand(conn.entity!, "fixture-command");
    expect(conn.allTextJoined()).not.toContain("extension completed");
    engine.entities.get(conn.entity!)!.properties.rank = 9;
    await engine.processCommand(conn.entity!, "fixture-command");
    expect(conn.allTextJoined()).toContain("extension completed");
  } finally {
    await close();
    await engine.shutdown();
  }
  expect(engine.commands.getDef("fixture-command")).toBeUndefined();
  expect(extensionWidgets(engine)).toEqual([]);
});

test("incompatible extension API fails before activation", async () => {
  const dir = fixture();
  writeFileSync(
    join(dir, "marina-plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", apiVersion: 99, entry: "index.mjs" }),
  );
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60000 });
  await expect(loadExtensions(engine, [dir])).rejects.toThrow("incompatible");
  await engine.shutdown();
});

test("world loader handles directories and installed packages without a registry fetch", async () => {
  const dir = fixture();
  const pkg = join(dir, "node_modules", "fixture-world");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "fixture-world", type: "module", main: "index.mjs" }),
  );
  writeFileSync(
    join(pkg, "index.mjs"),
    `export default { name:"Fixture", startRoom:"start", rooms:{start:{short:"Start",long:"A room",exits:{}}}, quests:[], guideNotes:[] };`,
  );
  expect((await loadWorld(pkg)).name).toBe("Fixture");
  expect((await loadWorld("npm:fixture-world", dir)).startRoom).toBe(roomId("start"));
  await expect(loadWorld("npm:fixture-world@latest", dir)).rejects.toThrow("preinstalled");
});
