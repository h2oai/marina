// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { getAllowedOrigins, isLoopbackOriginHost, isTrustedBrowserOrigin } from "../src/net/cors";

describe("isTrustedBrowserOrigin (shared WS-upgrade / pre-auth POST rule)", () => {
  const prevAllowed = process.env.ALLOWED_ORIGINS;
  afterEach(() => {
    if (prevAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = prevAllowed;
  });

  it("allows a request with no Origin header (non-browser client)", () => {
    expect(isTrustedBrowserOrigin(null, "127.0.0.1:3300")).toBe(true);
    expect(isTrustedBrowserOrigin(undefined, null)).toBe(true);
  });

  it("allows a same-origin browser request (Origin host equals Host header)", () => {
    expect(isTrustedBrowserOrigin("http://localhost:3300", "localhost:3300")).toBe(true);
    expect(isTrustedBrowserOrigin("https://marina.example.com", "marina.example.com")).toBe(true);
    // Case-insensitive host comparison.
    expect(isTrustedBrowserOrigin("https://Marina.Example.com", "marina.example.com")).toBe(true);
  });

  it("refuses a foreign origin, the opaque null origin and garbage", () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(isTrustedBrowserOrigin("https://evil.example", "127.0.0.1:3300")).toBe(false);
    expect(isTrustedBrowserOrigin("null", "127.0.0.1:3300")).toBe(false);
    expect(isTrustedBrowserOrigin("", "127.0.0.1:3300")).toBe(false);
    expect(isTrustedBrowserOrigin("not a url", "127.0.0.1:3300")).toBe(false);
    expect(isTrustedBrowserOrigin("ftp://127.0.0.1", "127.0.0.1:3300")).toBe(false);
    // Port mismatch is a different origin.
    expect(isTrustedBrowserOrigin("http://localhost:5173", "localhost:3300")).toBe(false);
  });

  it("allows origins listed in ALLOWED_ORIGINS", () => {
    process.env.ALLOWED_ORIGINS = "https://dash.example.com, http://tool.example:8080";
    expect(getAllowedOrigins()?.has("https://dash.example.com")).toBe(true);
    expect(isTrustedBrowserOrigin("https://dash.example.com", "marina.internal")).toBe(true);
    expect(isTrustedBrowserOrigin("http://tool.example:8080", "marina.internal")).toBe(true);
    expect(isTrustedBrowserOrigin("https://other.example.com", "marina.internal")).toBe(false);
    // Explicit override wins over the env (tests / embedded hosts).
    expect(
      isTrustedBrowserOrigin("https://dash.example.com", "marina.internal", {
        allowedOrigins: null,
      }),
    ).toBe(false);
  });

  it("allows loopback origins on any port only when the listener binds loopback", () => {
    delete process.env.ALLOWED_ORIGINS;
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://127.5.5.5",
      "http://[::1]:5173",
      "https://localhost",
    ]) {
      expect(isTrustedBrowserOrigin(origin, "127.0.0.1:3300", { loopbackBind: true })).toBe(true);
      expect(isTrustedBrowserOrigin(origin, "0.0.0.0:3300", { loopbackBind: false })).toBe(false);
      expect(isTrustedBrowserOrigin(origin, "0.0.0.0:3300")).toBe(false);
    }
    // A loopback bind does not open the door for a non-loopback origin.
    expect(
      isTrustedBrowserOrigin("https://evil.example", "127.0.0.1:3300", { loopbackBind: true }),
    ).toBe(false);
  });

  it("isLoopbackOriginHost classifies URL.hostname forms", () => {
    expect(isLoopbackOriginHost("localhost")).toBe(true);
    expect(isLoopbackOriginHost("127.0.0.1")).toBe(true);
    expect(isLoopbackOriginHost("[::1]")).toBe(true);
    expect(isLoopbackOriginHost("::1")).toBe(true);
    expect(isLoopbackOriginHost("0.0.0.0")).toBe(false);
    expect(isLoopbackOriginHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackOriginHost("10.0.0.1")).toBe(false);
  });
});
