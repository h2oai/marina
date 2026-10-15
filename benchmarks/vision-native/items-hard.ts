// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `hard` visual set: generated tasks whose answers are known by
 * construction and that stress what a text description of an image tends to
 * lose — exact chart readings, dense small text, spatial relations under
 * clutter, comparisons across several images, measurement, and detail only
 * the small print carries. Every task is built from a seeded scene; the answer
 * is computed from the scene, never from the pixels. Nothing here is stored in
 * Marina's memory, and nothing is downloaded.
 */

import { FONT, render, rng, svgDoc } from "./items";

export type HardKind =
  | "bar-read"
  | "series-compare"
  | "log-axis"
  | "table-lookup"
  | "table-sum"
  | "inside-count"
  | "clutter-count"
  | "spot-diff"
  | "match-spec"
  | "line-length"
  | "angle"
  | "small-print";

export const HARD_KINDS: readonly HardKind[] = [
  "bar-read",
  "series-compare",
  "log-axis",
  "table-lookup",
  "table-sum",
  "inside-count",
  "clutter-count",
  "spot-diff",
  "match-spec",
  "line-length",
  "angle",
  "small-print",
];

/** The capability family each kind measures. */
export const HARD_FAMILY: Record<HardKind, string> = {
  "bar-read": "chart",
  "series-compare": "chart",
  "log-axis": "chart",
  "table-lookup": "text",
  "table-sum": "text",
  "inside-count": "spatial",
  "clutter-count": "spatial",
  "spot-diff": "multi-image",
  "match-spec": "multi-image",
  "line-length": "geometry",
  angle: "geometry",
  "small-print": "detail",
};

export type Scoring =
  | { type: "number"; abs?: number; rel?: number }
  | { type: "choice"; options: readonly string[] }
  | { type: "cell" };

export interface HardImage {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface HardTask {
  id: string;
  kind: HardKind;
  /** Asks about "image 1", "image 2", … when there is more than one image. */
  question: string;
  answer: string;
  scoring: Scoring;
  images: HardImage[];
  /** The scene the answer was computed from (for tests; never sent to a model). */
  meta: Record<string, unknown>;
}

type Rng = ReturnType<typeof rng>;
type ShapeType = "circle" | "square" | "triangle" | "diamond";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A shape centred on (x, y) whose bounding box is ±s on both axes. */
export function shapeSvg(type: ShapeType, x: number, y: number, s: number, fill: string): string {
  switch (type) {
    case "circle":
      return `<circle cx="${x}" cy="${y}" r="${s}" fill="${fill}"/>`;
    case "square":
      return `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" fill="${fill}"/>`;
    case "triangle":
      return `<polygon points="${x},${y - s} ${x - s},${y + s} ${x + s},${y + s}" fill="${fill}"/>`;
    case "diamond":
      return `<polygon points="${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}" fill="${fill}"/>`;
  }
}

function text(x: number, y: number, size: number, body: string, extra = ""): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ${extra}>${body}</text>`;
}

function shuffle<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function pick<T>(r: Rng, items: readonly T[]): T {
  return items[r.int(0, items.length - 1)]!;
}

/** Up to `count` centres at least `gap` apart inside the box. */
function place(
  r: Rng,
  count: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  gap: number,
  avoid: Array<[number, number, number]> = [],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let tries = 0; out.length < count && tries < 20_000; tries++) {
    const x = r.int(box.x0, box.x1);
    const y = r.int(box.y0, box.y1);
    if (
      out.every(([px, py]) => Math.hypot(px - x, py - y) >= gap) &&
      avoid.every(([ax, ay, d]) => Math.hypot(ax - x, ay - y) >= d)
    )
      out.push([x, y]);
  }
  return out;
}

async function image(width: number, height: number, body: string): Promise<HardImage> {
  return { png: await render(svgDoc(width, height, body)), width, height };
}

// ─── Charts ────────────────────────────────────────────────────────────────

async function barRead(seed: string): Promise<HardTask> {
  const r = rng(`bar-read:${seed}`);
  const [w, h, base, scale] = [1000, 640, 580, 5];
  const values: number[] = [];
  while (values.length < 8) {
    const v = r.int(12, 97);
    if (v % 5 !== 0 && !values.includes(v)) values.push(v);
  }
  const parts: string[] = [];
  for (let v = 5; v <= 100; v += 5) {
    const y = base - v * scale;
    const major = v % 10 === 0;
    parts.push(
      `<line x1="70" y1="${y}" x2="980" y2="${y}" stroke="${major ? "#bbb" : "#e8e8e8"}"/>`,
    );
    if (major) parts.push(text(28, y + 5, 14, String(v), 'fill="#555"'));
  }
  parts.push(`<line x1="70" y1="${base}" x2="980" y2="${base}" stroke="#333"/>`);
  values.forEach((v, i) => {
    const x = 100 + i * 110;
    parts.push(
      `<rect x="${x}" y="${base - v * scale}" width="70" height="${v * scale}" fill="#4c78a8"/>`,
      text(x + 28, base + 30, 20, LETTERS[i]!, 'fill="#111"'),
    );
  });
  const target = r.int(0, 7);
  return {
    id: `bar-read-${seed}`,
    kind: "bar-read",
    question: `In the bar chart, what is the value of bar ${LETTERS[target]}? Read it against the axis gridlines; answer with a number (scored to within ±1).`,
    answer: String(values[target]),
    scoring: { type: "number", abs: 1 },
    images: [await image(w, h, parts.join(""))],
    meta: { values, target },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function seriesCompare(seed: string): Promise<HardTask> {
  const r = rng(`series-compare:${seed}`);
  const [w, h, base, top, lo, hi] = [1100, 640, 560, 60, 20, 80];
  const yOf = (v: number) => base - ((v - lo) / (hi - lo)) * (base - top);
  const blue: number[] = [];
  let v = r.int(35, 65);
  for (let i = 0; i < 12; i++) {
    v = Math.max(28, Math.min(72, v + r.int(-6, 6)));
    blue.push(v);
  }
  let gaps: number[] = [];
  do {
    gaps = blue.map(() => (r.next() < 0.5 ? -1 : 1) * r.int(2, 4));
  } while (gaps.filter((g) => g < 0).length < 3 || gaps.filter((g) => g < 0).length > 9);
  const orange = blue.map((b, i) => b + gaps[i]!);
  const xOf = (i: number) => 120 + i * 82;
  const parts: string[] = [];
  for (let g = lo; g <= hi; g += 10) {
    parts.push(
      `<line x1="90" y1="${yOf(g)}" x2="1060" y2="${yOf(g)}" stroke="#ddd"/>`,
      text(50, yOf(g) + 5, 14, String(g), 'fill="#555"'),
    );
  }
  MONTHS.forEach((m, i) => {
    parts.push(text(xOf(i) - 14, base + 30, 15, m, 'fill="#333"'));
  });
  for (const [series, colour] of [
    [blue, "#1f77b4"],
    [orange, "#ff7f0e"],
  ] as const) {
    parts.push(
      `<polyline fill="none" stroke="${colour}" stroke-width="2.5" points="${series.map((s, i) => `${xOf(i)},${yOf(s)}`).join(" ")}"/>`,
      ...series.map((s, i) => `<circle cx="${xOf(i)}" cy="${yOf(s)}" r="4" fill="${colour}"/>`),
    );
  }
  parts.push(
    `<rect x="820" y="16" width="14" height="14" fill="#1f77b4"/>`,
    text(840, 28, 14, "Blue series", 'fill="#333"'),
    `<rect x="940" y="16" width="14" height="14" fill="#ff7f0e"/>`,
    text(960, 28, 14, "Orange series", 'fill="#333"'),
  );
  const answer = gaps.filter((g) => g < 0).length;
  return {
    id: `series-compare-${seed}`,
    kind: "series-compare",
    question:
      "The line chart shows a blue and an orange series over 12 months. In how many of the 12 months is the blue value higher than the orange value? Answer with a number.",
    answer: String(answer),
    scoring: { type: "number", abs: 0 },
    images: [await image(w, h, parts.join(""))],
    meta: { blue, orange },
  };
}

function twoSig(v: number): number {
  return Number(v.toPrecision(2));
}

async function logAxis(seed: string): Promise<HardTask> {
  const r = rng(`log-axis:${seed}`);
  const [w, h, base, perDecade] = [900, 680, 600, 100];
  const yOf = (v: number) => base - Math.log10(v) * perDecade;
  const parts: string[] = [];
  const decadeLabels = ["1", "10", "100", "1,000", "10,000", "100,000"];
  for (let d = 0; d <= 5; d++) {
    parts.push(
      `<line x1="110" y1="${yOf(10 ** d)}" x2="880" y2="${yOf(10 ** d)}" stroke="#aaa"/>`,
      text(20, yOf(10 ** d) + 5, 14, decadeLabels[d]!, 'fill="#444"'),
    );
    if (d < 5) {
      for (let k = 2; k <= 9; k++) {
        const y = yOf(k * 10 ** d);
        parts.push(`<line x1="110" y1="${y}" x2="880" y2="${y}" stroke="#eee"/>`);
      }
    }
  }
  parts.push(`<line x1="110" y1="${base - 500}" x2="110" y2="${base}" stroke="#333"/>`);
  const values = Array.from({ length: 8 }, () => twoSig(10 ** (0.2 + r.next() * 4.6)));
  values.forEach((v, i) => {
    const x = 170 + i * 90;
    parts.push(
      `<circle cx="${x}" cy="${yOf(v)}" r="6" fill="#d62728"/>`,
      text(x - 6, yOf(v) - 12, 16, LETTERS[i]!, 'fill="#111"'),
    );
  });
  const target = r.int(0, 7);
  return {
    id: `log-axis-${seed}`,
    kind: "log-axis",
    question: `The scatter plot's vertical axis is logarithmic. What is the value of point ${LETTERS[target]}? Answer with a number (scored to within ±10%).`,
    answer: String(values[target]),
    scoring: { type: "number", rel: 0.1 },
    images: [await image(w, h, parts.join(""))],
    meta: { values, target },
  };
}

// ─── Dense text and tables ─────────────────────────────────────────────────

const COLUMN_NAMES = [
  "Alder",
  "Birch",
  "Cedar",
  "Damson",
  "Elm",
  "Fir",
  "Gorse",
  "Hazel",
  "Ivy",
  "Juniper",
];

function uniqueIds(r: Rng, n: number, prefix: string): string[] {
  const ids = new Set<string>();
  while (ids.size < n) ids.add(`${prefix}${r.int(100, 999)}`);
  return [...ids];
}

async function tableLookup(seed: string): Promise<HardTask> {
  const r = rng(`table-lookup:${seed}`);
  const [rows, cols, cw, rh, x0, y0] = [18, 10, 120, 34, 130, 60];
  const rowIds = uniqueIds(r, rows, "K-");
  const colNames = shuffle(r, COLUMN_NAMES);
  const cells = rowIds.map(() => Array.from({ length: cols }, () => r.int(100, 999)));
  const w = x0 + cols * cw + 20;
  const h = y0 + rows * rh + 20;
  const parts: string[] = [];
  colNames.forEach((c, j) => {
    parts.push(text(x0 + j * cw + 20, y0 - 14, 15, c, 'fill="#111" font-weight="bold"'));
  });
  rowIds.forEach((id, i) => {
    const y = y0 + i * rh;
    if (i % 2 === 0)
      parts.push(`<rect x="10" y="${y}" width="${w - 20}" height="${rh}" fill="#f2f2f2"/>`);
    parts.push(text(20, y + 23, 14, id, 'fill="#111" font-weight="bold"'));
    cells[i]!.forEach((v, j) => {
      parts.push(text(x0 + j * cw + 30, y + 23, 14, String(v), 'fill="#222"'));
    });
  });
  const [ti, tj] = [r.int(0, rows - 1), r.int(0, cols - 1)];
  return {
    id: `table-lookup-${seed}`,
    kind: "table-lookup",
    question: `In the table, what is the value in the row labelled ${rowIds[ti]} and the column headed "${colNames[tj]}"? Answer with the number only.`,
    answer: String(cells[ti]![tj]),
    scoring: { type: "number", abs: 0 },
    images: [await image(w, h, parts.join(""))],
    meta: { rowIds, colNames, cells, target: [ti, tj] },
  };
}

const REGIONS = ["North", "South", "East", "West"];

async function tableSum(seed: string): Promise<HardTask> {
  const r = rng(`table-sum:${seed}`);
  const rows = 16;
  const items = uniqueIds(r, rows, "P-");
  const region = pick(r, REGIONS);
  let regions: string[] = [];
  do {
    regions = items.map(() => pick(r, REGIONS));
  } while (
    regions.filter((g) => g === region).length < 3 ||
    regions.filter((g) => g === region).length > 6
  );
  const units = items.map(() => r.int(10, 99));
  const price = items.map(() => r.int(100, 999) / 100);
  const stock = items.map(() => r.int(10, 99));
  const headers = ["Item", "Region", "Units", "Price", "Stock"];
  const xs = [30, 170, 330, 470, 610];
  const [y0, rh, w] = [60, 32, 740];
  const h = y0 + rows * rh + 20;
  const parts = headers.map((c, j) =>
    text(xs[j]!, y0 - 14, 15, c, 'fill="#111" font-weight="bold"'),
  );
  items.forEach((id, i) => {
    const y = y0 + i * rh;
    if (i % 2 === 0)
      parts.push(`<rect x="10" y="${y}" width="${w - 20}" height="${rh}" fill="#f2f2f2"/>`);
    const row = [id, regions[i]!, String(units[i]), price[i]!.toFixed(2), String(stock[i])];
    row.forEach((v, j) => {
      parts.push(text(xs[j]!, y + 22, 14, v, 'fill="#222"'));
    });
  });
  const answer = units.reduce((s, u, i) => s + (regions[i] === region ? u : 0), 0);
  return {
    id: `table-sum-${seed}`,
    kind: "table-sum",
    question: `In the table, what is the total of the Units column over the rows whose Region is ${region}? Answer with the number only.`,
    answer: String(answer),
    scoring: { type: "number", abs: 0 },
    images: [await image(w, h, parts.join(""))],
    meta: { items, regions, units, region },
  };
}

// ─── Spatial relations and counting under clutter ──────────────────────────

const RED = "#d62728";
const INSIDE_KINDS: ReadonlyArray<{ type: ShapeType; fill: string; target?: true }> = [
  { type: "square", fill: RED, target: true },
  { type: "square", fill: RED, target: true },
  { type: "circle", fill: RED },
  { type: "triangle", fill: RED },
  { type: "square", fill: "#ff7f0e" },
  { type: "square", fill: "#e377c2" },
  { type: "square", fill: "#7f7f7f" },
  { type: "circle", fill: "#1f77b4" },
];

async function insideCount(seed: string): Promise<HardTask> {
  const r = rng(`inside-count:${seed}`);
  const [w, h] = [1100, 800];
  for (;;) {
    const x0 = r.int(150, 350);
    const y0 = r.int(120, 250);
    const rect = { x0, y0, x1: x0 + r.int(420, 560), y1: y0 + r.int(320, 420) };
    const shapes: Array<{
      type: ShapeType;
      fill: string;
      x: number;
      y: number;
      s: number;
      inside: boolean;
      target: boolean;
    }> = [];
    for (const [x, y] of place(r, 60, { x0: 30, y0: 30, x1: w - 30, y1: h - 30 }, 34)) {
      const s = r.int(10, 14);
      const m = 6;
      const inside =
        x - s > rect.x0 + m && x + s < rect.x1 - m && y - s > rect.y0 + m && y + s < rect.y1 - m;
      const outside =
        x + s < rect.x0 - m || x - s > rect.x1 + m || y + s < rect.y0 - m || y - s > rect.y1 + m;
      if (!inside && !outside) continue;
      const k = pick(r, INSIDE_KINDS);
      shapes.push({ type: k.type, fill: k.fill, x, y, s, inside, target: !!k.target });
    }
    const answer = shapes.filter((s) => s.inside && s.target).length;
    const outsideTargets = shapes.filter((s) => !s.inside && s.target).length;
    if (answer < 3 || answer > 12 || outsideTargets < 2) continue;
    const body = [
      ...shapes.map((s) => shapeSvg(s.type, s.x, s.y, s.s, s.fill)),
      `<rect x="${rect.x0}" y="${rect.y0}" width="${rect.x1 - rect.x0}" height="${rect.y1 - rect.y0}" fill="none" stroke="#1f4fd6" stroke-width="4"/>`,
    ].join("");
    return {
      id: `inside-count-${seed}`,
      kind: "inside-count",
      question:
        "How many solid red squares lie completely inside the blue rectangle outline? Do not count red circles or red triangles, squares of other colours, or anything outside the rectangle. Answer with a number.",
      answer: String(answer),
      scoring: { type: "number", abs: 0 },
      images: [await image(w, h, body)],
      meta: { rect, shapes },
    };
  }
}

const GREEN = "#2ca02c";
const CLUTTER_KINDS: ReadonlyArray<{ type: ShapeType; fill: string }> = [
  { type: "circle", fill: GREEN },
  { type: "square", fill: GREEN },
  { type: "diamond", fill: GREEN },
  { type: "triangle", fill: "#17becf" },
  { type: "triangle", fill: "#bcbd22" },
  { type: "triangle", fill: "#1f77b4" },
  { type: "circle", fill: "#9467bd" },
  { type: "square", fill: "#8c564b" },
];

async function clutterCount(seed: string): Promise<HardTask> {
  const r = rng(`clutter-count:${seed}`);
  const [w, h] = [1200, 900];
  const box = { x0: 30, y0: 30, x1: w - 30, y1: h - 30 };
  const n = r.int(8, 18);
  const targets = place(r, n, box, 2 * 17 + 10).map(([x, y]) => ({ x, y, s: r.int(13, 17) }));
  // A green distractor never touches a target (two green shapes would merge
  // into one ambiguous blob); other colours may partly cover a target drawn
  // beneath them, but never its centre.
  const clear = (d: { x: number; y: number; s: number; fill: string }, ratio: number) =>
    targets.every(
      (t) =>
        Math.hypot(t.x - d.x, t.y - d.y) >=
        (d.fill === GREEN ? t.s + d.s + 6 : (t.s + d.s) * ratio),
    );
  const distractors = (count: number, ratio: number) =>
    place(r, count * 3, box, 0)
      .map(([x, y]) => ({ x, y, s: r.int(10, 17), ...pick(r, CLUTTER_KINDS) }))
      .filter((d) => clear(d, ratio))
      .slice(0, count);
  const below = distractors(r.int(22, 28), 0);
  const above = distractors(r.int(20, 28), 0.75);
  const body = [
    ...below.map((d) => shapeSvg(d.type, d.x, d.y, d.s, d.fill)),
    ...targets.map((t) => shapeSvg("triangle", t.x, t.y, t.s, GREEN)),
    ...above.map((d) => shapeSvg(d.type, d.x, d.y, d.s, d.fill)),
  ].join("");
  return {
    id: `clutter-count-${seed}`,
    kind: "clutter-count",
    question:
      "How many green triangles are in the image? Count every green triangle, including ones partly covered by other shapes; do not count green circles, squares or diamonds, or teal, olive or blue triangles. Answer with a number.",
    answer: String(targets.length),
    scoring: { type: "number", abs: 0 },
    images: [await image(w, h, body)],
    meta: { targets, distractors: below.length + above.length },
  };
}

// ─── Several images ────────────────────────────────────────────────────────

const PALETTE = ["#d62728", "#1f77b4", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b"];
const SHAPES: readonly ShapeType[] = ["circle", "square", "triangle", "diamond"];

interface Cell {
  type: ShapeType;
  fill: string;
  s: number;
}

function gridSvg(cells: Cell[][]): string {
  const [cell, x0, y0] = [80, 50, 50];
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    parts.push(
      text(x0 + i * cell + 34, 32, 18, LETTERS[i]!, 'fill="#333"'),
      text(18, y0 + i * cell + 46, 18, String(i + 1), 'fill="#333"'),
    );
  }
  for (let i = 0; i <= 7; i++) {
    parts.push(
      `<line x1="${x0}" y1="${y0 + i * cell}" x2="${x0 + 7 * cell}" y2="${y0 + i * cell}" stroke="#ccc"/>`,
      `<line x1="${x0 + i * cell}" y1="${y0}" x2="${x0 + i * cell}" y2="${y0 + 7 * cell}" stroke="#ccc"/>`,
    );
  }
  cells.forEach((row, i) => {
    row.forEach((c, j) => {
      parts.push(shapeSvg(c.type, x0 + j * cell + 40, y0 + i * cell + 40, c.s, c.fill));
    });
  });
  return parts.join("");
}

async function spotDiff(seed: string): Promise<HardTask> {
  const r = rng(`spot-diff:${seed}`);
  const a: Cell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 7 }, () => ({ type: pick(r, SHAPES), fill: pick(r, PALETTE), s: 22 })),
  );
  const b = a.map((row) => row.map((c) => ({ ...c })));
  const [ri, ci] = [r.int(0, 6), r.int(0, 6)];
  const change = (["colour", "shape", "size"] as const)[r.int(0, 2)]!;
  const orig = a[ri]![ci]!;
  if (change === "colour")
    b[ri]![ci]!.fill = pick(
      r,
      PALETTE.filter((p) => p !== orig.fill),
    );
  else if (change === "shape")
    b[ri]![ci]!.type = pick(
      r,
      SHAPES.filter((s) => s !== orig.type),
    );
  else b[ri]![ci]!.s = 14;
  const size = 50 + 7 * 80 + 20;
  return {
    id: `spot-diff-${seed}`,
    kind: "spot-diff",
    question:
      "Image 1 and image 2 show the same 7×7 grid of shapes and are identical except for exactly one cell (a different shape, colour or size). Which cell differs? Answer with the column letter and row number, e.g. B5.",
    answer: `${LETTERS[ci]}${ri + 1}`,
    scoring: { type: "cell" },
    images: [await image(size, size, gridSvg(a)), await image(size, size, gridSvg(b))],
    meta: { a, b, change },
  };
}

export type Quadrant = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const QUADRANTS: readonly Quadrant[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export interface SpecScene {
  blueSquares: number;
  quadrant: Quadrant;
  triangles: number;
}

/** Whether a match-spec scene satisfies the spec (used by the generator and tests). */
export function matchesSpec(scene: SpecScene, spec: { n: number; quadrant: Quadrant }): boolean {
  return scene.blueSquares === spec.n && scene.quadrant === spec.quadrant && scene.triangles === 0;
}

async function specImage(r: Rng, scene: SpecScene): Promise<HardImage> {
  const [w, h] = [640, 480];
  const left = scene.quadrant.endsWith("left");
  const topQ = scene.quadrant.startsWith("top");
  const cx = left ? r.int(60, w / 2 - 70) : r.int(w / 2 + 70, w - 60);
  const cy = topQ ? r.int(60, h / 2 - 70) : r.int(h / 2 + 70, h - 60);
  const box = { x0: 30, y0: 30, x1: w - 30, y1: h - 30 };
  const greens = r.int(4, 7);
  const need = scene.blueSquares + greens + scene.triangles;
  const pts = place(r, need, box, 44, [[cx, cy, 60]]);
  if (pts.length < need) throw new Error("match-spec: could not place every shape");
  const parts = [shapeSvg("circle", cx, cy, 24, RED)];
  pts.forEach(([x, y], i) => {
    if (i < scene.blueSquares) parts.push(shapeSvg("square", x, y, 16, "#1f77b4"));
    else if (i < scene.blueSquares + greens) parts.push(shapeSvg("circle", x, y, 14, GREEN));
    else parts.push(shapeSvg("triangle", x, y, 9, "#ff7f0e"));
  });
  return image(w, h, parts.join(""));
}

async function matchSpec(seed: string): Promise<HardTask> {
  const r = rng(`match-spec:${seed}`);
  const spec = { n: r.int(3, 6), quadrant: pick(r, QUADRANTS) };
  const correct = r.int(0, 2);
  const violations = shuffle(r, ["count", "quadrant", "triangle"] as const).slice(0, 2);
  const scenes: SpecScene[] = [];
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const scene: SpecScene = { blueSquares: spec.n, quadrant: spec.quadrant, triangles: 0 };
    if (i !== correct) {
      const kind = violations[v++]!;
      if (kind === "count") scene.blueSquares += r.next() < 0.5 ? -1 : 1;
      else if (kind === "quadrant")
        scene.quadrant = pick(
          r,
          QUADRANTS.filter((q) => q !== spec.quadrant),
        );
      else scene.triangles = 1;
    }
    scenes.push(scene);
  }
  const images: HardImage[] = [];
  for (const scene of scenes) images.push(await specImage(r, scene));
  return {
    id: `match-spec-${seed}`,
    kind: "match-spec",
    question: `Exactly one of images 1, 2 and 3 matches this spec: exactly ${spec.n} blue squares, the red circle in the ${spec.quadrant} quadrant, and no triangles of any colour. Which image matches? Answer 1, 2 or 3.`,
    answer: String(correct + 1),
    scoring: { type: "choice", options: ["1", "2", "3"] },
    images,
    meta: { spec, scenes },
  };
}

// ─── Geometry and measurement ──────────────────────────────────────────────

async function lineLength(seed: string): Promise<HardTask> {
  const r = rng(`line-length:${seed}`);
  const longest = r.int(260, 330);
  const lengths = [
    longest,
    longest * (0.935 + r.next() * 0.027),
    longest * (0.8 + r.next() * 0.12),
    longest * (0.8 + r.next() * 0.12),
  ];
  const order = shuffle(r, [0, 1, 2, 3]);
  const centres: Array<[number, number]> = [
    [250, 190],
    [750, 190],
    [250, 570],
    [750, 570],
  ];
  const parts: string[] = [];
  const segs: Array<{ letter: string; length: number }> = [];
  order.forEach((li, slot) => {
    const len = lengths[li]!;
    const theta = ((r.int(0, 179) + slot * 45) % 180) * (Math.PI / 180);
    const [cx, cy] = centres[slot]!;
    const [dx, dy] = [(Math.cos(theta) * len) / 2, (Math.sin(theta) * len) / 2];
    const letter = LETTERS[slot]!;
    segs.push({ letter, length: len });
    parts.push(
      `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="#111" stroke-width="4" stroke-linecap="butt"/>`,
      text(cx - Math.sin(theta) * 24 - 6, cy + Math.cos(theta) * 24 + 6, 20, letter, 'fill="#c00"'),
    );
  });
  const answer = segs.reduce((a, b) => (b.length > a.length ? b : a)).letter;
  return {
    id: `line-length-${seed}`,
    kind: "line-length",
    question:
      "Which of the four line segments A, B, C and D is the longest? Answer with its letter.",
    answer,
    scoring: { type: "choice", options: ["A", "B", "C", "D"] },
    images: [await image(1000, 760, parts.join(""))],
    meta: { segs },
  };
}

async function angle(seed: string): Promise<HardTask> {
  const r = rng(`angle:${seed}`);
  const deg = r.int(20, 160);
  const phi = r.int(0, 359);
  const [vx, vy] = [r.int(360, 440), r.int(360, 440)];
  const ray = (a: number, len: number) => {
    const rad = (a * Math.PI) / 180;
    return `<line x1="${vx}" y1="${vy}" x2="${(vx + Math.cos(rad) * len).toFixed(1)}" y2="${(vy - Math.sin(rad) * len).toFixed(1)}" stroke="#111" stroke-width="4"/>`;
  };
  const body = `${ray(phi, r.int(230, 320))}${ray(phi + deg, r.int(230, 320))}<circle cx="${vx}" cy="${vy}" r="6" fill="#111"/>`;
  return {
    id: `angle-${seed}`,
    kind: "angle",
    question:
      "Two rays meet at a vertex. What is the angle between them in degrees (the one under 180°)? Answer with a number (scored to within ±4°).",
    answer: String(deg),
    scoring: { type: "number", abs: 4 },
    images: [await image(800, 800, body)],
    meta: { deg, phi },
  };
}

// ─── Detail only the small print carries ───────────────────────────────────

function stepsText(dr: number, dc: number): string {
  const words = ["", "one", "two"];
  const parts: string[] = [];
  if (dr)
    parts.push(
      `${words[Math.abs(dr)]} row${Math.abs(dr) > 1 ? "s" : ""} ${dr > 0 ? "down" : "up"}`,
    );
  if (dc)
    parts.push(
      `${words[Math.abs(dc)]} column${Math.abs(dc) > 1 ? "s" : ""} ${dc > 0 ? "right" : "left"}`,
    );
  return parts.join(" and ");
}

function starSvg(x: number, y: number, rOut: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? rOut : rOut * 0.45;
    pts.push(`${(x + Math.cos(rad) * rr).toFixed(1)},${(y + Math.sin(rad) * rr).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="#e6a700"/>`;
}

async function smallPrint(seed: string): Promise<HardTask> {
  const r = rng(`small-print:${seed}`);
  const n = 6;
  const codes = new Set<string>();
  while (codes.size < n * n)
    codes.add(Array.from({ length: 3 }, () => pick(r, [...CODE_ALPHABET])).join(""));
  const grid = [...codes];
  const [sr, sc] = [r.int(0, n - 1), r.int(0, n - 1)];
  let dr = 0;
  let dc = 0;
  do {
    dr = r.int(-2, 2);
    dc = r.int(-2, 2);
  } while ((dr === 0 && dc === 0) || sr + dr < 0 || sr + dr >= n || sc + dc < 0 || sc + dc >= n);
  const [tw, th, x0, y0] = [140, 100, 30, 30];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const [x, y] = [x0 + j * tw, y0 + i * th];
      parts.push(
        `<rect x="${x + 4}" y="${y + 4}" width="${tw - 8}" height="${th - 8}" rx="8" fill="#eef3fb" stroke="#9fb3d1"/>`,
        text(x + 44, y + 58, 22, grid[i * n + j]!, 'fill="#1b2b44"'),
      );
      if (i === sr && j === sc) parts.push(starSvg(x + tw - 22, y + 22, 12));
    }
  }
  const w = x0 * 2 + n * tw;
  const h = y0 + n * th + 50;
  parts.push(
    text(
      x0 + 4,
      h - 18,
      12,
      `Target: the tile ${stepsText(dr, dc)} of the starred tile.`,
      'fill="#777"',
    ),
  );
  return {
    id: `small-print-${seed}`,
    kind: "small-print",
    question:
      "The small print at the bottom of the image names a target tile relative to the starred tile. Reply with the code printed on that target tile only.",
    answer: grid[(sr + dr) * n + (sc + dc)]!,
    scoring: { type: "choice", options: grid },
    images: [await image(w, h, parts.join(""))],
    meta: { grid, star: [sr, sc], step: [dr, dc] },
  };
}

const MAKERS: Record<HardKind, (seed: string) => Promise<HardTask>> = {
  "bar-read": barRead,
  "series-compare": seriesCompare,
  "log-axis": logAxis,
  "table-lookup": tableLookup,
  "table-sum": tableSum,
  "inside-count": insideCount,
  "clutter-count": clutterCount,
  "spot-diff": spotDiff,
  "match-spec": matchSpec,
  "line-length": lineLength,
  angle,
  "small-print": smallPrint,
};

/** `perKind` tasks of each kind, seeded `h1…hN`. */
export async function hardTasks(
  perKind: number,
  kinds: readonly HardKind[] = HARD_KINDS,
): Promise<HardTask[]> {
  const out: HardTask[] = [];
  for (let i = 1; i <= perKind; i++) {
    for (const kind of kinds) out.push(await MAKERS[kind](`h${i}`));
  }
  return out;
}

/**
 * The text a reply's final answer is read from. A short last line (a bare
 * answer after shown working) wins; otherwise the last bold span holding a
 * digit or a short code (an answer stated, then explained); otherwise the
 * last line.
 */
export function finalAnswerText(raw: string): string {
  const last =
    raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  if (last.length <= 24) return last;
  const bold = [...raw.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((m) => m[1]!.trim())
    .filter((t) => /\d/.test(t) || /^[A-Z0-9]{1,4}$/i.test(t))
    .at(-1);
  return bold ?? last;
}

/** Score a final answer against the known one; a number is the last one in the answer text. */
export function scoreHard(task: Pick<HardTask, "answer" | "scoring">, raw: string): boolean {
  const s = task.scoring;
  const text = finalAnswerText(raw);
  switch (s.type) {
    case "number": {
      const m = text.match(/-?\d[\d,]*(?:\.\d+)?/g)?.at(-1);
      if (!m) return false;
      const got = Number(m.replace(/,/g, ""));
      const want = Number(task.answer);
      if (!Number.isFinite(got)) return false;
      const tol = Math.max(s.abs ?? 0, (s.rel ?? 0) * Math.abs(want));
      return Math.abs(got - want) <= tol + 1e-9;
    }
    case "choice": {
      const tokens = new Set(
        text
          .toUpperCase()
          .split(/[^A-Z0-9]+/)
          .filter(Boolean),
      );
      const hits = s.options.filter((o) => tokens.has(o.toUpperCase()));
      return hits.length === 1 && hits[0]!.toUpperCase() === task.answer.toUpperCase();
    }
    case "cell": {
      const up = text.toUpperCase();
      const m = /\b([A-G])\s*-?\s*([1-7])\b/.exec(up) ?? /\b([1-7])\s*-?\s*([A-G])\b/.exec(up);
      if (!m) return false;
      const cell = /[A-G]/.test(m[1]!) ? `${m[1]}${m[2]}` : `${m[2]}${m[1]}`;
      return cell === task.answer;
    }
  }
}
