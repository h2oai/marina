// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfiguredRoots } from "../src/coding/workspace-registry";

describe("ensureConfiguredRoots", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when no roots are configured", () => {
    const result = ensureConfiguredRoots({});
    expect(result.ensured).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("creates a missing root and git inits it", () => {
    // realpathSync: macOS tmpdir() (/var/...) canonicalizes to /private/var/...
    const base = realpathSync(mkdtempSync(join(tmpdir(), "marina-roots-")));
    created.push(base);
    const root = join(base, "workspace");

    const result = ensureConfiguredRoots({ MARINA_CODE_ROOTS: root });

    expect(result.warnings).toEqual([]);
    expect(result.ensured).toEqual([root]);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("dedupes MARINA_CODE_ROOTS and MARINA_CODE_DEFAULT_ROOT", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "marina-roots-")));
    created.push(base);
    const root = join(base, "ws");

    const result = ensureConfiguredRoots({
      MARINA_CODE_ROOTS: root,
      MARINA_CODE_DEFAULT_ROOT: root,
    });

    expect(result.ensured).toEqual([root]);
  });

  it("leaves an existing git repo untouched", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "marina-roots-")));
    created.push(base);
    const root = join(base, "ws");

    const first = ensureConfiguredRoots({ MARINA_CODE_ROOTS: root });
    expect(first.ensured).toEqual([root]);
    // Second pass: .git already present, still reported ready, no warnings.
    const second = ensureConfiguredRoots({ MARINA_CODE_ROOTS: root });
    expect(second.ensured).toEqual([root]);
    expect(second.warnings).toEqual([]);
  });
});
