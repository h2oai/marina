// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot exposure checks: a container's wildcard bind counts as loopback only
 * when its publish address (MARINA_PUBLISHED_HOST) is host loopback, and the
 * shipped docker-compose.yml relies on that instead of acknowledging an
 * insecure public bind.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatewayIngressRefusal } from "../src/engine/gateway-runtime";
import { bindSafetyRefusal } from "../src/net/bind-safety";
import { isWildcardBindHost, publishedLoopback } from "../src/net/loopback";
import { scopeProcessState } from "./process-state";

const ROOT = join(import.meta.dir, "..");

describe("publishedLoopback", () => {
  it("counts a wildcard container bind as loopback only for a loopback publish", () => {
    for (const publishedHost of ["127.0.0.1", "::1", "[::1]", "localhost", " 127.0.0.1 "]) {
      expect(publishedLoopback({ bindHost: "0.0.0.0", publishedHost, inContainer: true })).toBe(
        true,
      );
      expect(publishedLoopback({ bindHost: "::", publishedHost, inContainer: true })).toBe(true);
    }
    for (const publishedHost of ["0.0.0.0", "10.0.0.5", "", "  ", undefined, "127.evil.com"]) {
      expect(publishedLoopback({ bindHost: "0.0.0.0", publishedHost, inContainer: true })).toBe(
        false,
      );
    }
  });

  it("never applies to a non-wildcard bind or outside a container", () => {
    expect(
      publishedLoopback({ bindHost: "10.0.0.5", publishedHost: "127.0.0.1", inContainer: true }),
    ).toBe(false);
    expect(
      publishedLoopback({ bindHost: "0.0.0.0", publishedHost: "127.0.0.1", inContainer: false }),
    ).toBe(false);
  });

  it("recognises wildcard bind hosts", () => {
    expect(isWildcardBindHost("0.0.0.0")).toBe(true);
    expect(isWildcardBindHost("[::]")).toBe(true);
    expect(isWildcardBindHost("127.0.0.1")).toBe(false);
  });
});

describe("bindSafetyRefusal", () => {
  const base = {
    bindHost: "0.0.0.0",
    loopbackExposure: false,
    authEnabled: false,
    insecurePublicAck: false,
    openApi: false,
    openPosture: false,
  };

  it("refuses a passwordless non-loopback exposure and names the container fix", () => {
    expect(bindSafetyRefusal(base)).toMatch(/FATAL: .*NON-LOOPBACK/);
    const container = bindSafetyRefusal({ ...base, publishedHost: "10.0.0.5" });
    expect(container).toContain('published on host "10.0.0.5"');
    expect(container).toContain("MARINA_PUBLISHED_HOST=127.0.0.1");
  });

  it("passes a loopback exposure, the explicit ack, or sign-in without the open API", () => {
    expect(bindSafetyRefusal({ ...base, loopbackExposure: true })).toBeUndefined();
    expect(bindSafetyRefusal({ ...base, insecurePublicAck: true })).toBeUndefined();
    expect(bindSafetyRefusal({ ...base, authEnabled: true })).toBeUndefined();
  });

  it("refuses the open API on a non-loopback exposure even with sign-in", () => {
    expect(bindSafetyRefusal({ ...base, authEnabled: true, openApi: true })).toContain(
      "MARINA_OPEN_API=true",
    );
  });
});

describe("docker-compose.yml exposure contract", () => {
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const active = compose
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("does not acknowledge an insecure public bind", () => {
    expect(active).not.toMatch(/MARINA_ALLOW_INSECURE_PUBLIC\s*=\s*true/);
  });

  it("passes the host publish address in, defaulting to loopback like `ports:`", () => {
    expect(active).toContain("MARINA_PUBLISHED_HOST=${MARINA_BIND_IP:-127.0.0.1}");
    expect(active).toContain('"${MARINA_BIND_IP:-127.0.0.1}:3300:3300"');
  });
});

describe("gatewayIngressRefusal", () => {
  it("refuses shared/public without GATEWAY_SECRET; local and a set secret accept", () => {
    for (const profile of ["shared", "public"] as const) {
      using _state = scopeProcessState({ trustProfile: profile });
      expect(gatewayIngressRefusal({})).toContain("Set GATEWAY_SECRET=");
      expect(gatewayIngressRefusal({ GATEWAY_SECRET: "s" })).toBeNull();
    }
    using _local = scopeProcessState({ trustProfile: "local" });
    expect(gatewayIngressRefusal({})).toBeNull();
  });
});
