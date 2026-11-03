// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Render a recorded terminal session (`capture-terminal.py`) to a picture.
 * A small VT100 with colour: enough for what `marina connect` draws (text,
 * CR/LF, cursor moves, erase, save/restore, 16/256/true colour, bold, dim,
 * italic, underline). OSC strings are dropped. The page a person would see
 * is laid out as a grid of spans and screenshotted with Playwright.
 *
 *   node site/scripts/capture-terminal.mjs <in.raw> <out.png> [cols rows]
 *   node site/scripts/capture-terminal.mjs <in.raw> <frames-dir> [cols rows] --frames --every=0.5
 *
 * With --frames, the recorder's timed stream (`<in.raw>.jsonl`) is replayed and
 * one PNG per `every` seconds lands in the directory (frame-00001.png …), for
 * ffmpeg to assemble: `ffmpeg -framerate 2 -i frame-%05d.png …`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.slice(2).split("="))
    .map(([k, v]) => [k, v ?? true]),
);
const [input, output = "terminal.png", colsArg = "108", rowsArg = "34"] = positional;
const cols = Number(colsArg);
const rows = Number(rowsArg);

const PALETTE = [
  "#0a0a0a",
  "#ff5f56",
  "#5af78e",
  "#ffdd00",
  "#57c7ff",
  "#ff6ac1",
  "#9aedfe",
  "#f0f0f0",
  "#686868",
  "#ff6e67",
  "#5af78e",
  "#ffdd00",
  "#57c7ff",
  "#ff6ac1",
  "#9aedfe",
  "#ffffff",
];
function color256(n) {
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const i = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const blank = () => ({ ch: " ", fg: null, bg: null, b: false, d: false, i: false, u: false });
let grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank));
let row = 0;
let col = 0;
let saved = [0, 0];
let attr = blank();
let pending = ""; // an escape sequence split across chunks waits for the rest

function sgr(params) {
  const p = params.length ? params : [0];
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) attr = blank();
    else if (n === 1) attr.b = true;
    else if (n === 2) attr.d = true;
    else if (n === 3) attr.i = true;
    else if (n === 4) attr.u = true;
    else if (n === 22) attr.b = attr.d = false;
    else if (n === 23) attr.i = false;
    else if (n === 24) attr.u = false;
    else if (n >= 30 && n <= 37) attr.fg = PALETTE[n - 30];
    else if (n >= 90 && n <= 97) attr.fg = PALETTE[n - 90 + 8];
    else if (n === 39) attr.fg = null;
    else if (n >= 40 && n <= 47) attr.bg = PALETTE[n - 40];
    else if (n >= 100 && n <= 107) attr.bg = PALETTE[n - 100 + 8];
    else if (n === 49) attr.bg = null;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      if (p[i + 1] === 5) {
        attr[key] = color256(p[i + 2] ?? 0);
        i += 2;
      } else if (p[i + 1] === 2) {
        attr[key] = `rgb(${p[i + 2] ?? 0},${p[i + 3] ?? 0},${p[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
}
function put(ch) {
  if (col >= cols) {
    col = 0;
    lf();
  }
  grid[row][col] = { ...attr, ch };
  col++;
}
function lf() {
  if (row === rows - 1) {
    grid.shift();
    grid.push(Array.from({ length: cols }, blank));
  } else row++;
}
function csi(final, params, priv) {
  const n = params[0] ?? 1;
  switch (final) {
    case "m":
      sgr(params);
      break;
    case "H":
    case "f":
      row = Math.min(rows - 1, (params[0] ?? 1) - 1);
      col = Math.min(cols - 1, (params[1] ?? 1) - 1);
      break;
    case "A":
      row = Math.max(0, row - n);
      break;
    case "B":
      row = Math.min(rows - 1, row + n);
      break;
    case "C":
      col = Math.min(cols - 1, col + n);
      break;
    case "D":
      col = Math.max(0, col - n);
      break;
    case "G":
      col = Math.min(cols - 1, n - 1);
      break;
    case "d":
      row = Math.min(rows - 1, n - 1);
      break;
    case "J": {
      const m = params[0] ?? 0;
      if (m === 2 || m === 3)
        grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank));
      else if (m === 0) {
        for (let c = col; c < cols; c++) grid[row][c] = blank();
        for (let r = row + 1; r < rows; r++) grid[r] = Array.from({ length: cols }, blank);
      } else {
        for (let c = 0; c <= col; c++) grid[row][c] = blank();
        for (let r = 0; r < row; r++) grid[r] = Array.from({ length: cols }, blank);
      }
      break;
    }
    case "K": {
      const m = params[0] ?? 0;
      const [from, to] = m === 0 ? [col, cols] : m === 1 ? [0, col + 1] : [0, cols];
      for (let c = from; c < to; c++) grid[row][c] = blank();
      break;
    }
    case "s":
      saved = [row, col];
      break;
    case "u":
      [row, col] = saved;
      break;
    case "L":
      for (let k = 0; k < n; k++) {
        grid.splice(row, 0, Array.from({ length: cols }, blank));
        grid.pop();
      }
      break;
    case "M":
      for (let k = 0; k < n; k++) {
        grid.splice(row, 1);
        grid.push(Array.from({ length: cols }, blank));
      }
      break;
    default:
      break; // h/l (modes), n, r, t, ? private: ignored
  }
  void priv;
}

/** Feed a chunk of terminal output (latin-1 text of the raw bytes) into the screen. */
function feed(chunk) {
  const bytes = Buffer.from(pending + chunk, "latin1").toString("utf8");
  pending = "";
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    if (ch === "\x1b") {
      const next = bytes[i + 1];
      if (next === undefined) {
        pending = Buffer.from(bytes.slice(i), "utf8").toString("latin1");
        return;
      }
      if (next === "[") {
        let j = i + 2;
        let priv = "";
        if (bytes[j] === "?" || bytes[j] === ">" || bytes[j] === "=") priv = bytes[j++];
        let s = "";
        while (j < bytes.length && /[0-9;]/.test(bytes[j])) s += bytes[j++];
        const final = bytes[j];
        if (final === undefined) {
          pending = Buffer.from(bytes.slice(i), "utf8").toString("latin1");
          return;
        }
        csi(final, s === "" ? [] : s.split(";").map((x) => (x === "" ? 0 : Number(x))), priv);
        i = j;
      } else if (next === "]") {
        let j = i + 2;
        while (
          j < bytes.length &&
          bytes[j] !== "\x07" &&
          !(bytes[j] === "\x1b" && bytes[j + 1] === "\\")
        )
          j++;
        i = bytes[j] === "\x07" ? j : j + 1;
      } else if (next === "7") {
        saved = [row, col];
        i++;
      } else if (next === "8") {
        [row, col] = saved;
        i++;
      } else if (next === "(" || next === ")") i += 2;
      else i++;
      continue;
    }
    if (ch === "\r") col = 0;
    else if (ch === "\n") {
      col = 0;
      lf();
    } else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
    else if (ch === "\x07" || ch < " " || ch === "\x7f") continue;
    else put(ch);
  }
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The screen as HTML spans, one line per row. */
function screenHtml() {
  return grid
    .map((line) => {
      let out = "";
      let cur = null;
      let run = "";
      const flush = () => {
        if (!cur) return;
        const style = [
          cur.fg ? `color:${cur.fg}` : "",
          cur.bg ? `background:${cur.bg}` : "",
          cur.b ? "font-weight:700" : "",
          cur.d ? "opacity:.6" : "",
          cur.i ? "font-style:italic" : "",
          cur.u ? "text-decoration:underline" : "",
        ]
          .filter(Boolean)
          .join(";");
        out += style ? `<span style="${style}">${esc(run)}</span>` : esc(run);
        run = "";
      };
      for (const c of line) {
        const key = `${c.fg}|${c.bg}|${c.b}|${c.d}|${c.i}|${c.u}`;
        if (!cur || key !== `${cur.fg}|${cur.bg}|${cur.b}|${cur.d}|${cur.i}|${cur.u}`) {
          flush();
          cur = c;
        }
        run += c.ch;
      }
      flush();
      return out.replace(/\s+$/, "");
    })
    .join("\n");
}

const pageFor = (html) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0a0a0a}
.win{display:inline-block;background:#0a0a0a;border:1px solid #3a3a3a;border-radius:12px;padding:14px 18px 18px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.bar{display:flex;gap:7px;margin-bottom:12px}.bar i{width:11px;height:11px;border-radius:50%;background:#2a2a2a;display:block}
pre{margin:0;width:${cols}ch;height:calc(${rows} * 1.42 * 14px);font:14px/1.42 "Geist Mono","JetBrains Mono","Cascadia Code",Menlo,monospace;color:#f0f0f0;white-space:pre;overflow:hidden}
</style></head><body><div class="win"><div class="bar"><i></i><i></i><i></i></div><pre>${html}</pre></div></body></html>`;

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
try {
  const scale = flags.frames ? 1 : 2;
  const pg = await browser.newPage({
    viewport: { width: cols * 9 + 80, height: rows * 20 + 80 },
    deviceScaleFactor: scale,
  });
  const shoot = async (path) => {
    await pg.setContent(pageFor(screenHtml()));
    await pg.locator(".win").screenshot({ path, omitBackground: true });
  };
  if (flags.frames) {
    const stream = `${input}.jsonl`;
    if (!existsSync(stream))
      throw new Error(`no timed stream at ${stream}; record with capture-terminal.py`);
    const chunks = readFileSync(stream, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const every = Number(flags.every ?? 0.5);
    mkdirSync(output, { recursive: true });
    let frame = 0;
    let k = 0;
    const end = chunks[chunks.length - 1][0] + every;
    for (let t = 0; t <= end; t += every) {
      while (k < chunks.length && chunks[k][0] <= t) feed(chunks[k++][1]);
      frame++;
      await shoot(join(output, `frame-${String(frame).padStart(5, "0")}.png`));
    }
    console.log(`wrote ${frame} frames (every ${every}s, ${end.toFixed(1)}s) to ${output}`);
  } else {
    feed(readFileSync(input, "latin1"));
    await shoot(output);
    console.log(`wrote ${output}`);
  }
} finally {
  await browser.close();
}
