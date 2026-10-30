// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic visual tasks with known answers, rendered from SVG with
 * `sharp`: counting coloured shapes among distractors, reading a small code
 * in a large page, ranking unlabeled bars against gridlines, and locating a
 * mark in a grid. The same seed always yields the same pixels and answers.
 * Nothing here is stored in Marina's memory.
 */

import sharp from "sharp";

import { fnv1a32 } from "../../src/stats";
export type VisualTaskKind = "count" | "code" | "chart" | "grid" | "dense";

/** The kinds run when none are named (`dense` is the harder counting set). */
export const DEFAULT_KINDS: readonly VisualTaskKind[] = ["count", "code", "chart", "grid"];

export interface VisualTask {
  id: string;
  kind: VisualTaskKind;
  question: string;
  answer: string;
  png: Uint8Array;
  width: number;
  height: number;
}

/** mulberry32 over a string-hashed seed. */
export function rng(seed: string): { next: () => number; int: (lo: number, hi: number) => number } {
  let a = fnv1a32(seed) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}

export const FONT = "DejaVu Sans, Liberation Sans, Arial, sans-serif";

export async function render(svg: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

export function svgDoc(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

/** Non-overlapping circle centres inside the canvas. */
function scatter(
  r: ReturnType<typeof rng>,
  count: number,
  w: number,
  h: number,
  radius: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let tries = 0; out.length < count && tries < 10_000; tries++) {
    const x = r.int(radius + 4, w - radius - 4);
    const y = r.int(radius + 4, h - radius - 4);
    if (out.every(([px, py]) => Math.hypot(px - x, py - y) > radius * 2 + 10)) out.push([x, y]);
  }
  return out;
}

async function countTask(seed: string): Promise<VisualTask> {
  const r = rng(seed);
  const [w, h] = [900, 650];
  const red = r.int(6, 13);
  const others = r.int(5, 9);
  const points = scatter(r, red + others, w, h, 26);
  const shapes = points.map(([x, y], i) => {
    const fill = i < red ? "#d62728" : ["#1f77b4", "#ff9896", "#9467bd"][i % 3]!;
    return `<circle cx="${x}" cy="${y}" r="${r.int(18, 26)}" fill="${fill}"/>`;
  });
  return {
    id: `count-${seed}`,
    kind: "count",
    question: "How many solid red circles are in the image (not pink, not blue, not purple)?",
    answer: String(red),
    png: await render(svgDoc(w, h, shapes.join(""))),
    width: w,
    height: h,
  };
}

/** Many small shapes: 18–30 red among 15–22 near-colour distractors. */
async function denseTask(seed: string): Promise<VisualTask> {
  const r = rng(`dense:${seed}`);
  const [w, h] = [1200, 900];
  const red = r.int(18, 30);
  const others = r.int(15, 22);
  const points = scatter(r, red + others, w, h, 14);
  const shapes = points.map(([x, y], i) => {
    const fill = i < red ? "#d62728" : ["#ff7f0e", "#e377c2", "#8c564b"][i % 3]!;
    return `<circle cx="${x}" cy="${y}" r="${r.int(9, 14)}" fill="${fill}"/>`;
  });
  return {
    id: `dense-${seed}`,
    kind: "dense",
    question:
      "How many solid red circles are in the image (not orange, not pink, not brown)? Answer with a number.",
    answer: String(points.slice(0, red).length),
    png: await render(svgDoc(w, h, shapes.join(""))),
    width: w,
    height: h,
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FILLER = ["ledger", "harbor", "signal", "orbit", "vector", "lumen", "quartz", "delta"];

async function codeTask(seed: string): Promise<VisualTask> {
  const r = rng(seed);
  const [w, h] = [2000, 1300];
  const code = Array.from({ length: 7 }, () => CODE_ALPHABET[r.int(0, 31)]).join("");
  const decoys: string[] = [];
  for (let row = 0; row < 14; row++) {
    for (let col = 0; col < 6; col++) {
      const word = `${FILLER[r.int(0, FILLER.length - 1)]}-${r.int(100, 999)}`;
      decoys.push(
        `<text x="${60 + col * 320}" y="${90 + row * 80}" font-family="${FONT}" font-size="24" fill="#555">${word}</text>`,
      );
    }
  }
  const cx = r.int(80, w - 420);
  const cy = r.int(h - 120, h - 40);
  const label = `<text x="${cx}" y="${cy}" font-family="${FONT}" font-size="20" fill="#111">ACCESS CODE: ${code}</text>`;
  return {
    id: `code-${seed}`,
    kind: "code",
    question: "What is the ACCESS CODE printed in the image? Answer with the code only.",
    answer: code,
    png: await render(svgDoc(w, h, decoys.join("") + label)),
    width: w,
    height: h,
  };
}

async function chartTask(seed: string): Promise<VisualTask> {
  const r = rng(seed);
  const [w, h] = [900, 600];
  const letters = ["A", "B", "C", "D", "E", "F"];
  const values = new Set<number>();
  while (values.size < letters.length) values.add(r.int(20, 95));
  const vals = [...values];
  const base = 540;
  const scale = 5;
  const grid = Array.from({ length: 10 }, (_, i) => {
    const y = base - (i + 1) * 10 * scale;
    return `<line x1="60" y1="${y}" x2="860" y2="${y}" stroke="#ddd"/><text x="20" y="${y + 5}" font-family="${FONT}" font-size="14" fill="#666">${(i + 1) * 10}</text>`;
  });
  const bars = vals.map((v, i) => {
    const x = 90 + i * 128;
    return `<rect x="${x}" y="${base - v * scale}" width="80" height="${v * scale}" fill="#4c78a8"/><text x="${x + 32}" y="${base + 30}" font-family="${FONT}" font-size="22" fill="#111">${letters[i]}</text>`;
  });
  const order = vals.map((v, i) => [v, letters[i]!] as const).sort((a, b) => b[0] - a[0]);
  return {
    id: `chart-${seed}`,
    kind: "chart",
    question: "In the bar chart, which bar is the SECOND tallest? Answer with its letter only.",
    answer: order[1]![1],
    png: await render(
      svgDoc(
        w,
        h,
        `${grid.join("")}<line x1="60" y1="${base}" x2="860" y2="${base}" stroke="#333"/>${bars.join("")}`,
      ),
    ),
    width: w,
    height: h,
  };
}

async function gridTask(seed: string): Promise<VisualTask> {
  const r = rng(seed);
  const n = 7;
  const cell = 80;
  const size = n * cell + 40;
  const lines: string[] = [];
  for (let i = 0; i <= n; i++) {
    lines.push(
      `<line x1="20" y1="${20 + i * cell}" x2="${20 + n * cell}" y2="${20 + i * cell}" stroke="#333"/>`,
      `<line x1="${20 + i * cell}" y1="20" x2="${20 + i * cell}" y2="${20 + n * cell}" stroke="#333"/>`,
    );
  }
  const taken = new Set<string>();
  const mark = (glyph: string): [number, number] => {
    for (;;) {
      const rc: [number, number] = [r.int(1, n), r.int(1, n)];
      if (taken.has(rc.join())) continue;
      taken.add(rc.join());
      const [row, col] = rc;
      lines.push(
        `<text x="${20 + (col - 1) * cell + 26}" y="${20 + (row - 1) * cell + 54}" font-family="${FONT}" font-size="40" fill="#111">${glyph}</text>`,
      );
      return rc;
    }
  };
  const target = mark("X");
  for (let i = 0; i < 5; i++) mark("O");
  return {
    id: `grid-${seed}`,
    kind: "grid",
    question: `The image shows a ${n}x${n} grid. In which cell is the X? Answer as row,column counting from 1 at the top-left.`,
    answer: `${target[0]},${target[1]}`,
    png: await render(svgDoc(size, size, lines.join(""))),
    width: size,
    height: size,
  };
}

const MAKERS: Record<VisualTaskKind, (seed: string) => Promise<VisualTask>> = {
  count: countTask,
  code: codeTask,
  chart: chartTask,
  grid: gridTask,
  dense: denseTask,
};

/** `perKind` tasks of each kind, seeded `s1…sN`. */
export async function visualTasks(
  perKind: number,
  kinds: readonly VisualTaskKind[] = DEFAULT_KINDS,
): Promise<VisualTask[]> {
  const out: VisualTask[] = [];
  for (let i = 1; i <= perKind; i++) {
    for (const kind of kinds) out.push(await MAKERS[kind](`s${i}`));
  }
  return out;
}

/** Score a final answer against the known one. */
export function scoreAnswer(task: VisualTask, raw: string): boolean {
  const text = raw.trim();
  switch (task.kind) {
    case "count":
    case "dense":
      return (/-?\d+/.exec(text)?.[0] ?? "") === task.answer;
    case "code":
      return text
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .includes(task.answer);
    case "chart":
      return (/\b([A-F])\b/.exec(text.toUpperCase())?.[1] ?? "") === task.answer;
    case "grid": {
      const m = /(\d+)\s*[,;/ ]\s*(\d+)/.exec(text);
      return m ? `${m[1]},${m[2]}` === task.answer : false;
    }
  }
}
