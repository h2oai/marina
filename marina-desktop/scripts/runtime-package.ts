// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export function runtimeLayout(buildDir: string, os: string) {
  if (!["macos", "linux", "win"].includes(os))
    throw new Error(`Unsupported desktop platform: ${os}`);
  const roots = readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(buildDir, entry.name, ...(os === "macos" ? ["Contents"] : [])))
    .filter((root) => existsSync(join(root, "Resources/build.json")));
  if (roots.length !== 1)
    throw new Error("Expected exactly one Electrobun app in the target build directory");
  const root = roots[0]!;
  return {
    executable: join(root, os === "macos" ? "MacOS" : "bin", os === "win" ? "bun.exe" : "bun"),
    resources: join(root, "Resources"),
  };
}

export function packageRuntime(env: NodeJS.ProcessEnv, project = process.cwd()): void {
  const source = env.MARINA_DESKTOP_BUN_EXECUTABLE;
  if (!source || !env.ELECTROBUN_BUILD_DIR || !env.ELECTROBUN_OS)
    throw new Error(
      "Build through `bun run build:dev`, `build:canary`, or `build:stable` to select Marina's Bun runtime",
    );
  const expected = readFileSync(resolve(project, "../.bun-version"), "utf8").trim();
  const runtime = JSON.parse(
    execFileSync(
      source,
      [
        "-e",
        "console.log(JSON.stringify({version:Bun.version,platform:process.platform,arch:process.arch}))",
      ],
      { encoding: "utf8" },
    ),
  );
  const platform = { macos: "darwin", linux: "linux", win: "win32" }[env.ELECTROBUN_OS];
  if (
    runtime.version !== expected ||
    runtime.platform !== platform ||
    runtime.arch !== env.ELECTROBUN_ARCH
  )
    throw new Error(
      `Desktop runtime mismatch: require Bun ${expected} for ${env.ELECTROBUN_OS}-${env.ELECTROBUN_ARCH}`,
    );
  const { executable, resources } = runtimeLayout(env.ELECTROBUN_BUILD_DIR, env.ELECTROBUN_OS);
  if (!existsSync(executable)) throw new Error("Electrobun did not package a Bun executable");
  // Replace the directory entry, never write through a potential toolchain hardlink.
  const temporary = `${executable}.marina`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, executable);
  if (execFileSync(executable, ["--version"], { encoding: "utf8" }).trim() !== expected)
    throw new Error("Packaged Bun version verification failed");
  const metadataPath = join(resources, "build.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const upstreamBun = metadata.runtimeVersions?.bun;
  metadata.runtimeVersions = { ...metadata.runtimeVersions, bun: expected };
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  writeFileSync(
    join(resources, "marina-runtime.json"),
    `${JSON.stringify(
      {
        bun: expected,
        upstreamBun,
        electrobun: metadata.electrobunVersion,
        platform: runtime.platform,
        arch: runtime.arch,
        sha256BeforeSigning: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[desktop] Packaged and verified Bun ${expected} (${runtime.platform}-${runtime.arch})`,
  );
}
