import { describe, expect, it } from "bun:test";
import { validateFetchUrl } from "../src/net/url-guard";

describe("validateFetchUrl", () => {
  // 1. Valid public URLs pass
  describe("public URLs", () => {
    it("should allow http://example.com", () => {
      expect(validateFetchUrl("http://example.com")).toBeNull();
    });

    it("should allow https://github.com", () => {
      expect(validateFetchUrl("https://github.com")).toBeNull();
    });

    it("should allow https://example.com/path?query=1", () => {
      expect(validateFetchUrl("https://example.com/path?query=1")).toBeNull();
    });
  });

  // 2. Private IPv4 ranges blocked
  describe("private IPv4 ranges", () => {
    it("should block 127.0.0.1 (loopback)", () => {
      expect(validateFetchUrl("http://127.0.0.1")).not.toBeNull();
    });

    it("should block 127.255.255.255 (loopback /8)", () => {
      expect(validateFetchUrl("http://127.255.255.255")).not.toBeNull();
    });

    it("should block 10.0.0.1 (class A private)", () => {
      expect(validateFetchUrl("http://10.0.0.1")).not.toBeNull();
    });

    it("should block 172.16.0.1 (class B private)", () => {
      expect(validateFetchUrl("http://172.16.0.1")).not.toBeNull();
    });

    it("should block 172.31.255.255 (class B private upper bound)", () => {
      expect(validateFetchUrl("http://172.31.255.255")).not.toBeNull();
    });

    it("should allow 172.15.0.1 (just below private range)", () => {
      expect(validateFetchUrl("http://172.15.0.1")).toBeNull();
    });

    it("should allow 172.32.0.1 (just above private range)", () => {
      expect(validateFetchUrl("http://172.32.0.1")).toBeNull();
    });

    it("should block 192.168.1.1 (class C private)", () => {
      expect(validateFetchUrl("http://192.168.1.1")).not.toBeNull();
    });
  });

  // 3. IPv6 loopback blocked
  describe("IPv6 loopback", () => {
    it("should block ::1", () => {
      expect(validateFetchUrl("http://[::1]")).not.toBeNull();
    });

    it("should block :: (unspecified)", () => {
      expect(validateFetchUrl("http://[::]")).not.toBeNull();
    });
  });

  // 4. Link-local blocked
  describe("link-local addresses", () => {
    it("should block 169.254.0.1 (IPv4 link-local)", () => {
      expect(validateFetchUrl("http://169.254.0.1")).not.toBeNull();
    });

    it("should block 169.254.255.255 (IPv4 link-local upper)", () => {
      expect(validateFetchUrl("http://169.254.255.255")).not.toBeNull();
    });

    it("should block fe80:: (IPv6 link-local)", () => {
      expect(validateFetchUrl("http://[fe80::1]")).not.toBeNull();
    });
  });

  // 5. Cloud metadata endpoints blocked
  describe("cloud metadata endpoints", () => {
    it("should block 169.254.169.254 (AWS/Azure metadata)", () => {
      expect(validateFetchUrl("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
    });

    it("should block metadata.google.internal", () => {
      expect(
        validateFetchUrl("http://metadata.google.internal/computeMetadata/v1/"),
      ).not.toBeNull();
    });

    it("should block metadata.goog", () => {
      expect(validateFetchUrl("http://metadata.goog/computeMetadata/v1/")).not.toBeNull();
    });
  });

  // 6. IPv4-mapped IPv6 — URL parsers normalise [::ffff:x.x.x.x] to hex form
  //    (::ffff:a00:1). The guard handles both dotted-quad and hex forms.
  describe("IPv4-mapped IPv6", () => {
    it("should block ::ffff:127.0.0.1 (loopback via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:127.0.0.1]")).not.toBeNull();
    });

    it("should block ::ffff:10.0.0.1 (class A private via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:10.0.0.1]")).not.toBeNull();
    });

    it("should block ::ffff:192.168.1.1 (class C private via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:192.168.1.1]")).not.toBeNull();
    });

    it("should block ::ffff:169.254.169.254 (cloud metadata via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:169.254.169.254]")).not.toBeNull();
    });

    it("should block ::ffff:172.16.0.1 (class B private via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:172.16.0.1]")).not.toBeNull();
    });

    it("should allow ::ffff:8.8.8.8 (public IP via mapped IPv6)", () => {
      expect(validateFetchUrl("http://[::ffff:8.8.8.8]")).toBeNull();
    });
  });

  // 7. Non-http/https protocols blocked
  describe("blocked protocols", () => {
    it("should block ftp://", () => {
      const result = validateFetchUrl("ftp://example.com/file");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked protocol");
    });

    it("should block file://", () => {
      const result = validateFetchUrl("file:///etc/passwd");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked protocol");
    });

    it("should block data:", () => {
      const result = validateFetchUrl("data:text/html,<h1>hi</h1>");
      expect(result).not.toBeNull();
    });
  });

  // 8. Malformed URLs blocked
  describe("malformed URLs", () => {
    it("should block a completely invalid URL", () => {
      const result = validateFetchUrl("not-a-url");
      expect(result).toBe("Invalid URL");
    });

    it("should block a URL missing protocol", () => {
      const result = validateFetchUrl("://missing-scheme.com");
      expect(result).not.toBeNull();
    });
  });

  // 9. Null/empty input handled
  describe("null/empty input", () => {
    it("should block an empty string", () => {
      const result = validateFetchUrl("");
      expect(result).toBe("Invalid URL");
    });

    it("should block whitespace-only input", () => {
      const result = validateFetchUrl("   ");
      expect(result).not.toBeNull();
    });
  });

  // 10. Edge cases
  describe("edge cases", () => {
    it("should block localhost", () => {
      const result = validateFetchUrl("http://localhost:8080/api");
      expect(result).not.toBeNull();
      expect(result).toContain("Blocked host");
    });

    it("should block 0.0.0.0", () => {
      expect(validateFetchUrl("http://0.0.0.0")).not.toBeNull();
    });

    it("should block fc00::/7 unique-local IPv6", () => {
      expect(validateFetchUrl("http://[fd12::1]")).not.toBeNull();
    });

    it("should block fc-prefix unique-local IPv6", () => {
      expect(validateFetchUrl("http://[fc00::1]")).not.toBeNull();
    });
  });
});
