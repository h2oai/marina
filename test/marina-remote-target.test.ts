// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF guard for `marina@<host>` model targets (src/agent/model-probe.ts).
 * The host is caller-supplied, so it goes through the url-guard like any other
 * user URL; loopback is allowed only under the local trust profile.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  assertMarinaRemoteTargetAllowed,
  marinaRemoteTarget,
  normalizeMarinaBaseUrl,
  validateMarinaRemoteTarget,
} from "../src/agent/model-probe";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { __setDnsResolverForTest } from "../src/net/url-guard";

afterEach(() => {
  resetTrustProfileForTests();
  __setDnsResolverForTest(null);
});

describe("marinaRemoteTarget", () => {
  it("extracts and normalizes the remote base URL of a marina@ model", () => {
    expect(marinaRemoteTarget("marina@gpu.box:3300")).toBe("http://gpu.box:3300/v1");
    expect(marinaRemoteTarget("marina/default@https://remote/")).toBe("https://remote/v1");
    expect(normalizeMarinaBaseUrl("https://gpu.box:3300/v1")).toBe("https://gpu.box:3300/v1");
  });

  it("returns undefined for local marina, other providers, and empty hosts", () => {
    expect(marinaRemoteTarget("marina/default")).toBeUndefined();
    expect(marinaRemoteTarget("anthropic/claude-haiku-4-5")).toBeUndefined();
    expect(marinaRemoteTarget("openai/gpt@weird")).toBeUndefined();
    expect(marinaRemoteTarget("marina@")).toBeUndefined();
  });
});

describe("validateMarinaRemoteTarget", () => {
  it("passes non-remote model strings through", async () => {
    setTrustProfile("shared");
    expect(await validateMarinaRemoteTarget("marina/default")).toBeNull();
    expect(await validateMarinaRemoteTarget("anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("blocks cloud metadata in every profile; private LAN literals only outside local", async () => {
    for (const profile of ["shared", "public", "local"] as const) {
      setTrustProfile(profile);
      expect(await validateMarinaRemoteTarget("marina@169.254.169.254:3300")).toMatch(/blocked/i);
    }
    for (const profile of ["shared", "public"] as const) {
      setTrustProfile(profile);
      expect(await validateMarinaRemoteTarget("marina@10.0.0.7:3300")).toMatch(/blocked/i);
      expect(await validateMarinaRemoteTarget("marina@192.168.1.20")).toMatch(/blocked/i);
    }
    // A single operator's LAN GPU box is a normal dev setup under `local`.
    setTrustProfile("local");
    expect(await validateMarinaRemoteTarget("marina@10.0.0.7:3300")).toBeNull();
    expect(await validateMarinaRemoteTarget("marina@192.168.1.20")).toBeNull();
  });

  it("blocks loopback outside the local profile and allows it under local", async () => {
    setTrustProfile("shared");
    expect(await validateMarinaRemoteTarget("marina@localhost:3300")).toMatch(/loopback/i);
    expect(await validateMarinaRemoteTarget("marina@127.0.0.1:3300")).toMatch(/loopback/i);
    expect(await validateMarinaRemoteTarget("marina@[::1]:3300")).toMatch(/loopback/i);

    setTrustProfile("local");
    expect(await validateMarinaRemoteTarget("marina@localhost:3300")).toBeNull();
    expect(await validateMarinaRemoteTarget("marina@127.0.0.1:3300")).toBeNull();
  });

  it("blocks a public-looking host that resolves to a private address (DNS rebinding)", async () => {
    setTrustProfile("shared");
    __setDnsResolverForTest(async () => ["127.0.0.1"]);
    expect(await validateMarinaRemoteTarget("marina@gpu.example.com:3300")).toMatch(/blocked/i);
  });

  it("allows a host that resolves to a public address", async () => {
    setTrustProfile("shared");
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    expect(await validateMarinaRemoteTarget("marina@gpu.example.com:3300")).toBeNull();
  });

  it("rejects non-http(s) schemes", async () => {
    setTrustProfile("local");
    expect(await validateMarinaRemoteTarget("marina@ftp://files.example.com")).toMatch(
      /blocked|protocol|valid/i,
    );
  });

  it("assertMarinaRemoteTargetAllowed throws with a clear reason and no-ops when safe", async () => {
    setTrustProfile("shared");
    await expect(assertMarinaRemoteTargetAllowed("marina@169.254.169.254")).rejects.toThrow(
      /Remote Marina target .* blocked .*not connected/i,
    );
    await expect(assertMarinaRemoteTargetAllowed("marina/default")).resolves.toBeUndefined();
  });
});
