import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string compare for shared-secret authentication. Returns
 * false fast on length mismatch (length itself is not a secret); equal-length
 * inputs are compared via `crypto.timingSafeEqual` to avoid leaking the
 * matching-prefix length through wall-clock timing.
 */
export function secretsEqual(a: string, b: string): boolean {
  // Compare as plain Uint8Array views. Buffer is a Uint8Array at runtime, but
  // some bun-types/TS combinations don't see `Buffer` as assignable to
  // `timingSafeEqual`'s `ArrayBufferView` parameter; constructing Uint8Arrays
  // is unambiguous across toolchains. Length is checked first, so the copies
  // never leak timing.
  const ab = new Uint8Array(Buffer.from(a, "utf8"));
  const bb = new Uint8Array(Buffer.from(b, "utf8"));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
