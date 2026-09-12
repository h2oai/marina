// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Locale-independent canonical JSON for the versioned portable bundle contract. */
export function canonicalPortableMemory(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPortableMemory).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalPortableMemory(value)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function memoryPortableDigest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPortableMemory(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
