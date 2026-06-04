/**
 * SVG path generators for room crown shapes and district color/shape mappings.
 *
 * Each shape function returns an SVG `d` path string centered at the origin
 * for the given radius. Used by RoomNode to render geometric crowns.
 */

/** Generate an SVG path string for a regular hexagon centered at origin. */
export function hexagonPath(r: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M ${points[0]} L ${points.slice(1).join(" L ")} Z`;
}

/** Generate an SVG path string for a regular octagon centered at origin. */
export function octagonPath(r: number): string {
  const points: string[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i - Math.PI / 2;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M ${points[0]} L ${points.slice(1).join(" L ")} Z`;
}

/** Generate an SVG path string for an equilateral triangle centered at origin. */
export function trianglePath(r: number): string {
  const top = `0,${(-r).toFixed(2)}`;
  const bottomRight = `${(r * 0.87).toFixed(2)},${(r * 0.5).toFixed(2)}`;
  const bottomLeft = `${(-r * 0.87).toFixed(2)},${(r * 0.5).toFixed(2)}`;
  return `M ${top} L ${bottomRight} L ${bottomLeft} Z`;
}

/** Generate an SVG path string for a diamond (rhombus) centered at origin. */
export function diamondPath(r: number): string {
  const top = `0,${(-r).toFixed(2)}`;
  const right = `${(r * 0.7).toFixed(2)},0`;
  const bottom = `0,${r.toFixed(2)}`;
  const left = `${(-r * 0.7).toFixed(2)},0`;
  return `M ${top} L ${right} L ${bottom} L ${left} Z`;
}

/** Generate an SVG path string for a circle centered at origin. */
export function circlePath(r: number): string {
  // Use two arc commands to form a complete circle
  return `M ${-r},0 A ${r},${r} 0 1,1 ${r},0 A ${r},${r} 0 1,1 ${-r},0 Z`;
}

/** Generate an SVG path string for an eye shape centered at origin. */
export function eyePath(r: number): string {
  const x1 = (-r).toFixed(2);
  const x2 = r.toFixed(2);
  const cpx1 = (-r * 0.6).toFixed(2);
  const cpx2 = (r * 0.6).toFixed(2);
  const cpy = (-r * 0.7).toFixed(2);
  const cpyb = (r * 0.7).toFixed(2);
  return (
    `M ${x1},0 ` +
    `C ${cpx1},${cpy} ${cpx2},${cpy} ${x2},0 ` +
    `C ${cpx2},${cpyb} ${cpx1},${cpyb} ${x1},0 Z`
  );
}

type ShapeFn = (r: number) => string;

/** Map from district name to crown shape generator function. */
export const DISTRICT_CROWNS: Record<string, ShapeFn> = {
  // Original design districts
  core: hexagonPath,
  build: octagonPath,
  knowledge: trianglePath,
  exchange: diamondPath,
  organic: circlePath,
  sense: eyePath,
  // Actual Marina default world districts
  world: hexagonPath, // hub/grid rooms
  mode: octagonPath, // agent mode rooms
  craft: diamondPath, // craft/build rooms
  demo: trianglePath, // demo rooms
  demos: trianglePath, // demo rooms (plural)
  market: eyePath, // market rooms
  markets: eyePath, // market rooms (plural)
  evolve: hexagonPath, // benchmark/evolve rooms
  bench: hexagonPath, // benchmark rooms
};

/** Map from district name to hex color. */
export const DISTRICT_COLORS: Record<string, string> = {
  // Original design districts
  core: "#FFDD00",
  build: "#FFB800",
  knowledge: "#22c55e",
  exchange: "#FF9500",
  organic: "#555555",
  sense: "#FFB800",
  // Actual Marina default world districts (derived from room ID prefix)
  world: "#FFDD00", // gold — hub/grid rooms
  mode: "#06b6d4", // cyan — agent mode rooms
  craft: "#FFB800", // amber — craft/build rooms
  demo: "#22c55e", // green — demo rooms
  demos: "#22c55e", // green — demo rooms (plural)
  market: "#FF9500", // orange — market rooms
  markets: "#FF9500", // orange — market rooms (plural)
  evolve: "#8b5cf6", // violet — benchmark/evolve rooms
  bench: "#8b5cf6", // violet — benchmark rooms
};

/** Get the shape function for a district, falling back to circle. */
export function getCrownShape(district: string): ShapeFn {
  return DISTRICT_CROWNS[district] ?? circlePath;
}

/** Get the color for a district, falling back to a dim gray. */
export function getDistrictColor(district: string): string {
  return DISTRICT_COLORS[district] ?? "#FFDD00"; // Default to gold, not grey
}
