// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { join, resolve } from "node:path";

/**
 * Whether the Rust SDK's crates can be had here: already in cargo's cache (an offline fetch
 * succeeds), or crates.io resolves. A network-less environment with an empty cache (the
 * bubblewrap sandbox Marina verifies itself in: no network, a scratch HOME) cannot build the
 * Rust SDK at all, so its tests are skipped there rather than failing every run.
 */
export async function cratesAvailable(): Promise<boolean> {
  const cargo = process.env.MARINA_TEST_CARGO ?? "cargo";
  const manifest = join(resolve(import.meta.dir, ".."), "sdks/rust/Cargo.toml");
  const offline = Bun.spawnSync([cargo, "fetch", "--offline", "--manifest-path", manifest], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (offline.exitCode === 0) return true;
  return lookup("index.crates.io").then(
    () => true,
    () => false,
  );
}
