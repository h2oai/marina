// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One stable colour per participant, as chat apps give each sender: the same
 * FNV-1a name hash the terminal uses (`scripts/term-theme.ts`), so a person
 * keeps their colour across the CLI and the dashboard. Each hue is mixed with
 * the theme's bright text colour, which lightens it on dark themes and darkens
 * it on light ones, so names stay readable in every theme.
 */

const HUES = [
  "#3b9fd8",
  "#e0803c",
  "#9370db",
  "#4caf50",
  "#d9609a",
  "#c9a227",
  "#2bb39a",
  "#6878e0",
] as const;

export function nameHash(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The participant's colour as a CSS value. */
export function identityColor(name: string): string {
  const hue = HUES[nameHash(name) % HUES.length]!;
  return `color-mix(in srgb, ${hue} 78%, var(--color-text-bright))`;
}

/** Up to two initials for an avatar: "Builder" → "Bu", "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  const w = words[0] ?? "?";
  return `${w[0]!.toUpperCase()}${w.slice(1, 2)}`;
}
