// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearResolvers,
  getResolver,
  listResolvers,
  registerBuiltinResolvers,
} from "../src/resolvers";
import { registerResolver } from "../src/resolvers/registry";
import type { Resolver } from "../src/resolvers/types";

const dummy: Resolver<{ x: string }> = {
  kind: "dummy",
  description: "test fixture",
  parseArgs(raw) {
    return raw.x ? { ok: true, args: { x: raw.x } } : { ok: false, error: "x required" };
  },
  idFromArgs: (args) => args.x,
  closesOn: [],
  async resolve({ args }) {
    return { status: "changed", value: args.x, source: "dummy://" };
  },
};

describe("resolver registry", () => {
  beforeEach(() => clearResolvers());
  afterEach(() => clearResolvers());

  it("register + getResolver round-trip", () => {
    expect(getResolver("dummy")).toBeUndefined();
    registerResolver(dummy);
    expect(getResolver("dummy")?.kind).toBe("dummy");
  });

  it("listResolvers returns every registered kind", () => {
    expect(listResolvers()).toEqual([]);
    registerResolver(dummy);
    expect(listResolvers().map((r) => r.kind)).toEqual(["dummy"]);
  });

  it("duplicate registration throws", () => {
    registerResolver(dummy);
    expect(() => registerResolver(dummy)).toThrow(/already registered/);
  });

  it("clearResolvers empties the registry", () => {
    registerResolver(dummy);
    clearResolvers();
    expect(listResolvers()).toEqual([]);
  });

  it("registerBuiltinResolvers is idempotent (safe to call repeatedly)", () => {
    registerBuiltinResolvers();
    const first = listResolvers().length;
    expect(first).toBeGreaterThan(0);
    registerBuiltinResolvers();
    expect(listResolvers().length).toBe(first);
  });

  it("the built-in echoing resolver is registered", () => {
    registerBuiltinResolvers();
    const echoing = getResolver("echoing");
    expect(echoing).toBeDefined();
    expect(echoing?.description).toMatch(/echo/i);
  });

  it("the built-in resolving resolver is registered (markets resolution)", () => {
    registerBuiltinResolvers();
    const resolving = getResolver("resolving");
    expect(resolving).toBeDefined();
    expect(resolving?.kind).toBe("resolving");
    expect(resolving?.kind).not.toMatch(/[-_]/); // voice-friendly identifier
    expect(resolving?.closesOn).toContain("resolved");
  });

  it("echoing parseArgs requires payload", () => {
    registerBuiltinResolvers();
    const r = getResolver("echoing")!;
    expect(r.parseArgs({}).ok).toBe(false);
    const ok = r.parseArgs({ payload: "hi" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(r.idFromArgs(ok.args)).toBe("hi");
    }
  });
});
