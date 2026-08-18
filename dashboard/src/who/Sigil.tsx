// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sigil — deterministic visual identity from a name string.
 *
 * Pure client-side: hashes the name to two HSL colors and an asymmetric SVG
 * glyph. Same name → same sigil, every load, no backend, no storage. Good
 * enough to give each /who page visual personality without an avatar
 * pipeline.
 */

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function Sigil({ name, size = 88 }: { name: string; size?: number }) {
  const h = hash(name.toLowerCase());
  const hue1 = h % 360;
  const hue2 = (h >>> 8) % 360;
  // Bit-pattern grid: 5×5 mirrored sigil — classic identicon trick, cheap
  // and instantly recognizable across runs.
  const cells: { x: number; y: number; on: boolean }[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (h >>> (y * 3 + x)) & 1;
      cells.push({ x, y, on: bit === 1 });
      if (x < 2) cells.push({ x: 4 - x, y, on: bit === 1 });
    }
  }
  const cell = size / 5;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      role="img"
      style={{
        background: `linear-gradient(135deg, hsl(${hue1} 50% 14%), hsl(${hue2} 50% 8%))`,
        borderRadius: 6,
        boxShadow: `0 0 18px hsl(${hue1} 80% 50% / 0.18)`,
      }}
    >
      {cells.map((c) =>
        c.on ? (
          <rect
            key={`${c.x}-${c.y}`}
            x={c.x * cell + cell * 0.1}
            y={c.y * cell + cell * 0.1}
            width={cell * 0.8}
            height={cell * 0.8}
            fill={`hsl(${hue1} 70% 60%)`}
            rx={1.5}
          />
        ) : null,
      )}
    </svg>
  );
}
