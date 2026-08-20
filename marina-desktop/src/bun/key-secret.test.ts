// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDesktopKeySecret } from "./key-secret";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function secretPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "marina-desktop-secret-"));
  dirs.push(dir);
  return join(dir, ".key-secret");
}

describe("ensureDesktopKeySecret", () => {
  it("creates, reuses, and exports an owner-only secret", () => {
    const path = secretPath();
    const firstEnv: Record<string, string | undefined> = {};
    const first = ensureDesktopKeySecret(path, firstEnv);
    const second = ensureDesktopKeySecret(path, {});

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(firstEnv.MARINA_KEY_SECRET).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(first);
  });

  it("preserves an explicit configured secret without creating a file", () => {
    const path = secretPath();
    const configured = "operator-provided-secret";
    expect(ensureDesktopKeySecret(path, { MARINA_KEY_SECRET: configured })).toBe(configured);
    expect(() => readFileSync(path)).toThrow();
  });

  it("rejects an invalid existing secret", () => {
    const path = secretPath();
    writeFileSync(path, "short\n", { mode: 0o600 });
    expect(() => ensureDesktopKeySecret(path, {})).toThrow("invalid");
  });
});
