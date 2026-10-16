// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isLoopbackHostname, isLoopbackIp } from "../src/net/loopback";

describe("isLoopbackHostname", () => {
  it("accepts localhost, ::1 and IPv4 literals in 127.0.0.0/8", () => {
    for (const host of ["localhost", "LOCALHOST", " localhost ", "::1", "[::1]", "127.0.0.1"]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    expect(isLoopbackHostname("127.5.6.7")).toBe(true);
    expect(isLoopbackHostname("127.255.255.255")).toBe(true);
  });

  it("refuses DNS names that start with 127. or localhost", () => {
    for (const host of [
      "127.attacker.example",
      "127.0.0.1.nip.io",
      "127.0.0.1.attacker.example",
      "localhost.attacker.example",
      "app.localhost",
    ]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });

  it("refuses malformed and non-loopback addresses", () => {
    for (const host of [
      "127.0.0",
      "127.0.0.1.2",
      "127.0.0.256",
      "127.0.0.-1",
      "127..0.1",
      "0.0.0.0",
      "10.0.0.1",
      "192.168.1.5",
      "::",
      "[::]",
      "::ffff:127.0.0.1",
      "",
    ]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe("isLoopbackIp", () => {
  it("accepts IPv4 127.0.0.0/8, ::1 and IPv4-mapped loopback", () => {
    for (const ip of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1", "::FFFF:127.1.2.3"]) {
      expect(isLoopbackIp(ip)).toBe(true);
    }
  });

  it("fails closed on unknown, malformed or remote peers", () => {
    for (const ip of [
      undefined,
      "",
      "10.0.0.5",
      "192.168.1.9",
      "::ffff:10.0.0.1",
      "::ffff:127.attacker",
      "127.0.0.1.2",
      "localhost",
    ]) {
      expect(isLoopbackIp(ip)).toBe(false);
    }
  });
});
