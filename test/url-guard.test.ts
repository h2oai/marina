// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { guardedFetch, validateFetchUrl } from "../src/net/url-guard";

describe("validateFetchUrl", async () => {
  // 1. Valid public URLs pass
  describe("public URLs", async () => {
    it("should allow http://example.com", async () => {
      expect(await validateFetchUrl("http://example.com")).toBeNull();
    });

    it("should allow https://github.com", async () => {
      expect(await validateFetchUrl("https://github.com")).toBeNull();
    });

    it("should allow https://example.com/path?query=1", async () => {
      expect(await validateFetchUrl("https://example.com/path?query=1")).toBeNull();
    });
  });

  // 2. Private IPv4 ranges blocked
  describe("private IPv4 ranges", async () => {
    it("should block 127.0.0.1 (loopback)", async () => {
      expect(await validateFetchUrl("http://127.0.0.1")).not.toBeNull();
    });

    it("should block 127.255.255.255 (loopback /8)", async () => {
      expect(await validateFetchUrl("http://127.255.255.255")).not.toBeNull();
    });

    it("should block 10.0.0.1 (class A private)", async () => {
      expect(await validateFetchUrl("http://10.0.0.1")).not.toBeNull();
    });

    it("should block 172.16.0.1 (class B private)", async () => {
      expect(await validateFetchUrl("http://172.16.0.1")).not.toBeNull();
    });

    it("should block 172.31.255.255 (class B private upper bound)", async () => {
      expect(await validateFetchUrl("http://172.31.255.255")).not.toBeNull();
    });

    it("should allow 172.15.0.1 (just below private range)", async () => {
      expect(await validateFetchUrl("http://172.15.0.1")).toBeNull();
    });

    it("should allow 172.32.0.1 (just above private range)", async () => {
      expect(await validateFetchUrl("http://172.32.0.1")).toBeNull();
    });

    it("should block 192.168.1.1 (class C private)", async () => {
      expect(await validateFetchUrl("http://192.168.1.1")).not.toBeNull();
    });
  });

  // 3. IPv6 loopback blocked
  describe("IPv6 loopback", async () => {
    it("should block ::1", async () => {
      expect(await validateFetchUrl("http://[::1]")).not.toBeNull();
    });

    it("should block :: (unspecified)", async () => {
      expect(await validateFetchUrl("http://[::]")).not.toBeNull();
    });
  });

  // 4. Link-local blocked
  describe("link-local addresses", async () => {
    it("should block 169.254.0.1 (IPv4 link-local)", async () => {
      expect(await validateFetchUrl("http://169.254.0.1")).not.toBeNull();
    });

    it("should block 169.254.255.255 (IPv4 link-local upper)", async () => {
      expect(await validateFetchUrl("http://169.254.255.255")).not.toBeNull();
    });

    it("should block fe80:: (IPv6 link-local)", async () => {
      expect(await validateFetchUrl("http://[fe80::1]")).not.toBeNull();
    });
  });

  // 5. Cloud metadata endpoints blocked
  describe("cloud metadata endpoints", async () => {
    it("should block 169.254.169.254 (AWS/Azure metadata)", async () => {
      expect(await validateFetchUrl("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
    });

    it("should block metadata.google.internal", async () => {
      expect(
        validateFetchUrl("http://metadata.google.internal/computeMetadata/v1/"),
      ).not.toBeNull();
    });

    it("should block metadata.goog", async () => {
      expect(await validateFetchUrl("http://metadata.goog/computeMetadata/v1/")).not.toBeNull();
    });
  });

  // 6. IPv4-mapped IPv6 — URL parsers normalise [::ffff:x.x.x.x] to hex form
  //    (::ffff:a00:1). The guard handles both dotted-quad and hex forms.
  describe("IPv4-mapped IPv6", async () => {
    it("should block ::ffff:127.0.0.1 (loopback via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:127.0.0.1]")).not.toBeNull();
    });

    it("should block ::ffff:10.0.0.1 (class A private via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:10.0.0.1]")).not.toBeNull();
    });

    it("should block ::ffff:192.168.1.1 (class C private via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:192.168.1.1]")).not.toBeNull();
    });

    it("should block ::ffff:169.254.169.254 (cloud metadata via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:169.254.169.254]")).not.toBeNull();
    });

    it("should block ::ffff:172.16.0.1 (class B private via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:172.16.0.1]")).not.toBeNull();
    });

    it("should allow ::ffff:8.8.8.8 (public IP via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:8.8.8.8]")).toBeNull();
    });
  });

  // 7. Non-http/https protocols blocked
  describe("blocked protocols", async () => {
    it("should block ftp://", async () => {
      const result = await validateFetchUrl("ftp://example.com/file");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked protocol");
    });

    it("should block file://", async () => {
      const result = await validateFetchUrl("file:///etc/passwd");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked protocol");
    });

    it("should block data:", async () => {
      const result = await validateFetchUrl("data:text/html,<h1>hi</h1>");
      expect(result).not.toBeNull();
    });
  });

  // 8. Malformed URLs blocked
  describe("malformed URLs", async () => {
    it("should block a completely invalid URL", async () => {
      const result = await validateFetchUrl("not-a-url");
      expect(result).toBe("Invalid URL");
    });

    it("should block a URL missing protocol", async () => {
      const result = await validateFetchUrl("://missing-scheme.com");
      expect(result).not.toBeNull();
    });
  });

  // 9. Null/empty input handled
  describe("null/empty input", async () => {
    it("should block an empty string", async () => {
      const result = await validateFetchUrl("");
      expect(result).toBe("Invalid URL");
    });

    it("should block whitespace-only input", async () => {
      const result = await validateFetchUrl("   ");
      expect(result).not.toBeNull();
    });
  });

  // 10. Edge cases
  describe("edge cases", async () => {
    it("should block localhost", async () => {
      const result = await validateFetchUrl("http://localhost:8080/api");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked host");
    });

    it("should block 0.0.0.0", async () => {
      expect(await validateFetchUrl("http://0.0.0.0")).not.toBeNull();
    });

    it("should block fc00::/7 unique-local IPv6", async () => {
      expect(await validateFetchUrl("http://[fd12::1]")).not.toBeNull();
    });

    it("should block fc-prefix unique-local IPv6", async () => {
      expect(await validateFetchUrl("http://[fc00::1]")).not.toBeNull();
    });
  });
});

describe("guardedFetch (redirect-aware SSRF guard)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("throws on a blocked initial URL without ever fetching", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(guardedFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /SSRF blocked/,
    );
    expect(called).toBe(false);
  });

  it("refuses a redirect that points at a private/metadata IP", async () => {
    // Public host 302s to the cloud-metadata endpoint — the classic redirect bypass.
    globalThis.fetch = (async (input: string | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("169.254.169.254")) return new Response("SECRET", { status: 200 });
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as unknown as typeof fetch;
    await expect(guardedFetch("http://example.com/redir")).rejects.toThrow(/SSRF blocked/);
  });

  it("passes a normal non-redirect response through", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const resp = await guardedFetch("http://example.com");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });
});
