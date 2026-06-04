// ─── SSRF Protection ─────────────────────────────────────────────────────────
//
// Blocks fetch() requests to private/internal networks and cloud metadata endpoints.

/** Hostnames that must never be accessed from user-initiated requests. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.goog"]);

/**
 * Check if an IP address belongs to a private, loopback, or link-local range.
 *
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         169.254.0.0/16 (link-local / cloud metadata), 0.0.0.0,
 *         ::1, ::, fe80::/10, fc00::/7, and IPv4-mapped IPv6 (::ffff:x.x.x.x).
 */
function isPrivateIp(hostname: string): boolean {
  // IPv4
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }

  // IPv6
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local (fc00::/7)

  // IPv4-mapped IPv6 — dotted form: ::ffff:10.0.0.1
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]!);

  // IPv4-mapped IPv6 — hex form (URL parser normalizes to this): ::ffff:a00:1
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    // Each hex group is bounded by the regex to 0–0xffff, and the bit-masks
    // below clamp each reconstructed byte to 0–255. Belt-and-braces: if the
    // regex is ever loosened in the future without updating the math here,
    // fail closed (treat as private) rather than silently letting through.
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) {
      return true;
    }
    const ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIp(ip);
  }

  return false;
}

/**
 * Validate a URL for SSRF safety. Returns an error string if the URL is blocked,
 * or `null` if it's safe to fetch.
 */
export function validateFetchUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    return `Blocked host: ${hostname}`;
  }

  // Block private/internal IPs
  if (isPrivateIp(hostname)) {
    return `Blocked private/internal IP: ${hostname}`;
  }

  return null;
}
