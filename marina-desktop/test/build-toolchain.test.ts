// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomId, RoomModule } from "../../src/types";
import { configureSdk, sdkPaths } from "../scripts/configure-sdk";
import { prepareRooms } from "../scripts/prepare-rooms";
import { packageRuntime, runtimeLayout } from "../scripts/runtime-package";
import { loadRooms } from "../src/bun/room-loader";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "marina-v2-test-"));
  return {
    root,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("packaged showcase rooms load without checkout imports or stale generated modules", async () => {
  using f = fixture();
  const directory = join(f.root, "dist/rooms/default");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "stale.js"), 'export default {short:"stale",long:"deleted"}');
  await prepareRooms(f.root);
  const rooms = new Map<RoomId, RoomModule>();
  await loadRooms(
    {
      registerRoom: (id: RoomId, room: RoomModule) => {
        rooms.set(id, room);
      },
    },
    directory,
  );
  expect(rooms.size).toBe(25);
  expect(rooms.has("stale" as RoomId)).toBe(false);
  expect([...rooms.keys()].some((id) => id.includes("_shared"))).toBe(false);
});

test("v2 SDK paths support TS7 and reject exports outside the projected API", () => {
  expect(sdkPaths({ ".": "./api/index.ts", "./main": "./api/sdks/main/index.ts" })).toEqual({
    electrobun: ["./devkit/api/index.ts"],
    "electrobun/main": ["./devkit/api/sdks/main/index.ts"],
  });
  expect(() => sdkPaths({ "./main": "./api/../../outside.ts" })).toThrow("escapes");
  expect(() => sdkPaths({ ".": { default: "./api/index.ts" } })).toThrow("Invalid");
  using f = fixture();
  expect(() => configureSdk(f.root)).toThrow("SDK missing");
  mkdirSync(join(f.root, ".hutch/devkit"), { recursive: true });
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ devDependencies: { electrobun: "2.0.2" } }),
  );
  const manifest = join(f.root, ".hutch/devkit/package.json");
  writeFileSync(manifest, JSON.stringify({ version: "2.0.1", exports: {} }));
  expect(() => configureSdk(f.root)).toThrow("stale");
  writeFileSync(manifest, JSON.stringify({ version: "2.0.2", exports: { ".": "./api/index.ts" } }));
  configureSdk(f.root);
  const generated = JSON.parse(readFileSync(join(f.root, ".hutch/tsconfig.sdk.json"), "utf8"));
  expect(generated.compilerOptions.baseUrl).toBeUndefined();
  expect(generated.compilerOptions.paths.electrobun).toEqual(["./devkit/api/index.ts"]);
});

test.each(["macos", "linux", "win"])("runtime packaging selects the %s layout", (os) => {
  using f = fixture();
  const root = join(f.root, "Marina", ...(os === "macos" ? ["Contents"] : []));
  mkdirSync(join(root, "Resources"), { recursive: true });
  writeFileSync(join(root, "Resources/build.json"), "{}");
  expect(runtimeLayout(f.root, os)).toEqual({
    executable: join(root, os === "macos" ? "MacOS" : "bin", os === "win" ? "bun.exe" : "bun"),
    resources: join(root, "Resources"),
  });
});

test("runtime replacement preserves the upstream cache and packages working SQLite", () => {
  using f = fixture();
  const project = join(f.root, "desktop");
  const build = join(project, "build");
  const os =
    process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
  const root = join(build, "Marina", ...(os === "macos" ? ["Contents"] : []));
  mkdirSync(join(root, "Resources"), { recursive: true });
  writeFileSync(
    join(root, "Resources/build.json"),
    JSON.stringify({ electrobunVersion: "2.0.2", runtimeVersions: { bun: "1.4.0" } }),
  );
  const layout = runtimeLayout(build, os);
  mkdirSync(join(root, os === "macos" ? "MacOS" : "bin"));
  const cacheFile = join(f.root, "upstream-bun");
  writeFileSync(cacheFile, "upstream toolchain must stay unchanged");
  linkSync(cacheFile, layout.executable);
  writeFileSync(join(f.root, ".bun-version"), "0.0.0");
  const env = {
    MARINA_DESKTOP_BUN_EXECUTABLE: process.execPath,
    ELECTROBUN_BUILD_DIR: build,
    ELECTROBUN_OS: os,
    ELECTROBUN_ARCH: process.arch,
  };
  expect(() => packageRuntime(env, project)).toThrow("mismatch");
  expect(readFileSync(layout.executable, "utf8")).toBe("upstream toolchain must stay unchanged");
  writeFileSync(join(f.root, ".bun-version"), Bun.version);
  packageRuntime(env, project);
  expect(readFileSync(cacheFile, "utf8")).toBe("upstream toolchain must stay unchanged");
  expect(
    execFileSync(
      layout.executable,
      [
        "-e",
        'import {Database} from "bun:sqlite"; using db=new Database(":memory:"); console.log(db.query("select 42 as answer").get().answer)',
      ],
      { encoding: "utf8" },
    ).trim(),
  ).toBe("42");
  const receipt = JSON.parse(readFileSync(join(layout.resources, "marina-runtime.json"), "utf8"));
  expect(receipt).toMatchObject({
    bun: Bun.version,
    upstreamBun: "1.4.0",
    electrobun: "2.0.2",
    arch: process.arch,
  });
  expect(receipt.sha256BeforeSigning).toMatch(/^[a-f0-9]{64}$/);
});
