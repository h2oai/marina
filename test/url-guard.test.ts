// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { __setDnsResolverForTest, guardedFetch, validateFetchUrl } from "../src/net/url-guard";

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

    it("should block 100.100.100.200 (Alibaba Cloud metadata)", async () => {
      expect(await validateFetchUrl("http://100.100.100.200/latest/meta-data/")).not.toBeNull();
    });

    it("should block 192.0.0.192 (Oracle Cloud metadata)", async () => {
      expect(await validateFetchUrl("http://192.0.0.192/opc/v1/instance/")).not.toBeNull();
    });
  });

  // 5b. Extra blocked v4 ranges: CGNAT/shared 100.64.0.0/10 and IANA special
  //     192.0.0.0/24 — the ranges the Alibaba/Oracle metadata endpoints live in.
  describe("CGNAT + IANA-special ranges (Alibaba / Oracle metadata neighborhoods)", async () => {
    it("should block 100.64.0.1 (CGNAT lower bound)", async () => {
      expect(await validateFetchUrl("http://100.64.0.1")).not.toBeNull();
    });

    it("should block 100.127.255.255 (CGNAT upper bound)", async () => {
      expect(await validateFetchUrl("http://100.127.255.255")).not.toBeNull();
    });

    it("should allow 100.63.255.255 (just below CGNAT)", async () => {
      expect(await validateFetchUrl("http://100.63.255.255")).toBeNull();
    });

    it("should allow 100.128.0.1 (just above CGNAT)", async () => {
      expect(await validateFetchUrl("http://100.128.0.1")).toBeNull();
    });

    it("should block 192.0.0.1 (192.0.0.0/24 IANA special)", async () => {
      expect(await validateFetchUrl("http://192.0.0.1")).not.toBeNull();
    });

    it("should block 192.0.0.255 (192.0.0.0/24 upper)", async () => {
      expect(await validateFetchUrl("http://192.0.0.255")).not.toBeNull();
    });

    it("should allow 192.0.1.1 (just outside 192.0.0.0/24)", async () => {
      expect(await validateFetchUrl("http://192.0.1.1")).toBeNull();
    });

    it("should allow 192.1.0.1 (unrelated public 192.x)", async () => {
      expect(await validateFetchUrl("http://192.1.0.1")).toBeNull();
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

    it("should block ::ffff:100.100.100.200 (Alibaba metadata via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:100.100.100.200]")).not.toBeNull();
    });

    it("should block ::ffff:192.0.0.192 (Oracle metadata via mapped IPv6)", async () => {
      expect(await validateFetchUrl("http://[::ffff:192.0.0.192]")).not.toBeNull();
    });
  });

  // 6b. IPv6 transition/tunnel wrappers that embed a private/metadata IPv4
  describe("IPv6 tunnel wrappers (NAT64 / 6to4 / Teredo)", async () => {
    it("should block NAT64 64:ff9b::/96 wrapping 127.0.0.1", async () => {
      expect(await validateFetchUrl("http://[64:ff9b::7f00:1]")).not.toBeNull();
    });

    it("should block NAT64 64:ff9b::/96 wrapping 169.254.169.254 (metadata)", async () => {
      expect(await validateFetchUrl("http://[64:ff9b::a9fe:a9fe]")).not.toBeNull();
    });

    it("should block NAT64 64:ff9b::/96 wrapping 10.0.0.1", async () => {
      expect(await validateFetchUrl("http://[64:ff9b::a00:1]")).not.toBeNull();
    });

    it("should block NAT64 local prefix 64:ff9b:1::/48 wrapping 127.0.0.1", async () => {
      expect(await validateFetchUrl("http://[64:ff9b:1::7f00:1]")).not.toBeNull();
    });

    it("should block 6to4 2002::/16 wrapping 10.0.0.1", async () => {
      expect(await validateFetchUrl("http://[2002:a00:1::]")).not.toBeNull();
    });

    it("should block 6to4 2002::/16 wrapping 169.254.169.254 (metadata)", async () => {
      expect(await validateFetchUrl("http://[2002:a9fe:a9fe::]")).not.toBeNull();
    });

    it("should block Teredo 2001:0::/32 whose client IPv4 decodes to 127.0.0.1", async () => {
      // Public Teredo server (8.8.8.8) so the block is attributable to the
      // obfuscated client field, not the server field.
      expect(await validateFetchUrl("http://[2001:0:808:808::80ff:fffe]")).not.toBeNull();
    });

    it("should block NAT64 wrapping 100.100.100.200 (Alibaba metadata)", async () => {
      // 100.100.100.200 = 0x6464:0x64c8
      expect(await validateFetchUrl("http://[64:ff9b::6464:64c8]")).not.toBeNull();
    });

    it("should block NAT64 wrapping 192.0.0.192 (Oracle metadata)", async () => {
      // 192.0.0.192 = 0xc000:0x00c0
      expect(await validateFetchUrl("http://[64:ff9b::c000:c0]")).not.toBeNull();
    });

    it("should allow NAT64 wrapping a public IPv4 (8.8.8.8)", async () => {
      expect(await validateFetchUrl("http://[64:ff9b::808:808]")).toBeNull();
    });

    it("should allow 6to4 wrapping a public IPv4 (8.8.8.8)", async () => {
      expect(await validateFetchUrl("http://[2002:808:808::]")).toBeNull();
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
    __setDnsResolverForTest(null);
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

  it("pins the connection to the validated IP, neutralizing DNS rebinding", async () => {
    // The guard resolves once and gets a public IP; a rebinding host would flip
    // to a private IP on a later resolve. Because the connection targets the
    // pinned IP literal (not the hostname), fetch() never re-resolves.
    let resolves = 0;
    __setDnsResolverForTest(async () => {
      resolves++;
      return resolves === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    });
    let connectedTo = "";
    let hostHeader = "";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      connectedTo = typeof input === "string" ? input : input.toString();
      hostHeader = new Headers(init?.headers).get("host") ?? "";
      return new Response("asset", { status: 200 });
    }) as unknown as typeof fetch;

    const resp = await guardedFetch("http://rebind.example.com/asset.png");
    expect(resp.status).toBe(200);
    // Connection went to the pinned public IP, never the hostname — so a rebind
    // to 127.0.0.1 could not take effect.
    expect(connectedTo).toContain("93.184.216.34");
    expect(connectedTo).not.toContain("rebind.example.com");
    // Routing identity preserved via the Host header.
    expect(hostHeader).toBe("rebind.example.com");
  });

  it("carries TLS SNI serverName for https so cert validation matches the host", async () => {
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    let serverName: string | undefined;
    let connectedTo = "";
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      connectedTo = typeof input === "string" ? input : input.toString();
      serverName = (init as { tls?: { serverName?: string } })?.tls?.serverName;
      return new Response("asset", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch("https://cdn.example.com/asset.png");
    expect(connectedTo).toContain("93.184.216.34");
    expect(serverName).toBe("cdn.example.com");
  });

  it("blocks a host that resolves to a private IP (no connection attempted)", async () => {
    __setDnsResolverForTest(async () => ["10.0.0.5"]);
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(guardedFetch("http://sneaky.example.com/x")).rejects.toThrow(/SSRF blocked/);
    expect(called).toBe(false);
  });
});
