// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Starship-style formats for the prompt, the status bar and the rule above
 * the input. A format is text with:
 *
 *   $segment           a live value with its own icon and colour ($room, $agents …)
 *   [text](style)      text (and segments) in a style: theme tokens such as
 *                      accent, muted, success; bold, italic, underline; #rrggbb
 *   ( … )              a group shown only when a segment inside it has a value
 *   \$ \[ \( \\        literal characters
 *
 * e.g. `MARINA_PROMPT='[$room](bold accent)( [$git](accent2)) $character '`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { glyphsFor } from "./term-render";
import type { WorldSnapshot } from "./term-status";
import { fgParams, type Theme, type Token } from "./term-theme";

export interface SegmentContext {
  theme: Theme;
  name: string;
  connected: boolean;
  snapshot: WorldSnapshot;
  room?: string;
  here?: number;
  /** Outcome and duration of the last command you ran. */
  last?: { ok: boolean; ms: number };
  queued: number;
  cwd?: string;
  now?: Date;
}

export interface Segment {
  plain: string;
  styled: string;
}

type SegmentFn = (c: SegmentContext) => Segment | undefined;

const seg = (plain: string, styled: string): Segment => ({ plain, styled });

const RUNNING = new Set(["connected", "autonomous", "idle", "starting"]);

function money(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m${Math.floor((ms % 60_000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`;
}

/** A small meter: `━━━╸───` (or `[##--]`). */
export function meter(theme: Theme, ratio: number, width = 6, tone?: Token): string {
  const r = Math.min(1, Math.max(0, ratio));
  // Without a fixed tone the meter is a budget: it warms as it fills.
  tone ??= r >= 0.9 ? "error" : r >= 0.75 ? "warning" : "accent";
  if (!theme.unicode) {
    const filled = Math.round(r * width);
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
  }
  const cells = r * width;
  const full = Math.floor(cells);
  const half = cells - full >= 0.5 && full < width ? 1 : 0;
  return (
    theme.fg(tone)(`${"━".repeat(full)}${half ? "╸" : ""}`) +
    theme.fg("border")("─".repeat(width - full - half))
  );
}

function gitBranch(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      try {
        let gitdir = dotgit;
        if (statSync(dotgit).isFile()) {
          const ref = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1];
          if (!ref) return undefined;
          gitdir = resolve(dir, ref.trim());
        }
        const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
        const branch = head.match(/^ref: refs\/heads\/(.+)$/)?.[1];
        return branch ?? head.slice(0, 7);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export const SEGMENTS: Record<string, { describe: string; render: SegmentFn }> = {
  character: {
    describe: "the prompt chevron; turns red after a refused command",
    render: (c) => {
      const g = glyphsFor(c.theme).prompt;
      const tone: Token = c.last && !c.last.ok ? "error" : "accent";
      return seg(g, c.theme.bold(c.theme.fg(tone)(g)));
    },
  },
  name: {
    describe: "who you are connected as, in your identity colour",
    render: (c) => seg(c.name, c.theme.identity(c.name)(c.name)),
  },
  connection: {
    describe: "● connected / ○ disconnected",
    render: (c) =>
      c.connected
        ? seg("●", c.theme.fg("success")(glyphsFor(c.theme).voice))
        : seg("○ offline", c.theme.fg("error")("○ offline")),
  },
  room: {
    describe: "the room you are in",
    render: (c) => (c.room ? seg(c.room, c.theme.fg("accent")(c.room)) : undefined),
  },
  here: {
    describe: "participants in your room",
    render: (c) =>
      c.here ? seg(`${c.here} here`, c.theme.fg("muted")(`${c.here} here`)) : undefined,
  },
  world: {
    describe: "the world's name",
    render: (c) => {
      const w = c.snapshot.world?.name;
      return w ? seg(w, c.theme.fg("muted")(w)) : undefined;
    },
  },
  health: {
    describe: "server tick health: live / slow / stalled",
    render: (c) => {
      const h = c.snapshot.health;
      if (!h) return undefined;
      const g = glyphsFor(c.theme);
      if (h.status !== "ok" || h.tickAgoMs > 30_000)
        return seg(`${g.error} stalled`, c.theme.fg("error")(`${g.error} stalled`));
      if (h.tickAgoMs > 5_000)
        return seg(`${g.warn} slow tick`, c.theme.fg("warning")(`${g.warn} slow tick`));
      return seg(
        `${g.voice} live`,
        `${c.theme.fg("success")(g.voice)} ${c.theme.fg("muted")("live")}`,
      );
    },
  },
  uptime: {
    describe: "server uptime",
    render: (c) => {
      const ms = c.snapshot.health?.uptimeMs;
      return ms ? seg(`up ${duration(ms)}`, c.theme.fg("muted")(`up ${duration(ms)}`)) : undefined;
    },
  },
  online: {
    describe: "live connections",
    render: (c) => {
      const n = c.snapshot.health?.connections;
      return n === undefined ? undefined : seg(`${n} online`, c.theme.fg("muted")(`${n} online`));
    },
  },
  agents: {
    describe: "running agents (paused and erroring called out)",
    render: (c) => {
      const g = glyphsFor(c.theme);
      const rows = c.snapshot.ops?.agents;
      const t = c.theme;
      if (!rows) {
        const n = c.snapshot.health?.agents;
        return n === undefined
          ? undefined
          : seg(
              `${g.agent} ${n} agents`,
              `${t.fg("accent2")(g.agent)} ${t.fg("muted")(`${n} agents`)}`,
            );
      }
      const running = rows.filter((a) => RUNNING.has(a.state) && !a.paused).length;
      const paused = rows.filter((a) => a.paused).length;
      const failing = rows.filter((a) => a.state === "error" || a.consecutiveErrors >= 3).length;
      const parts = [`${running} agent${running === 1 ? "" : "s"}`];
      const styled = [t.fg("muted")(parts[0]!)];
      if (paused) {
        parts.push(`${paused} paused`);
        styled.push(t.fg("warning")(`${paused} paused`));
      }
      if (failing) {
        parts.push(`${failing} failing`);
        styled.push(t.fg("error")(`${failing} failing`));
      }
      return seg(
        `${g.agent} ${parts.join(" ")}`,
        `${t.fg("accent2")(g.agent)} ${styled.join(" ")}`,
      );
    },
  },
  tasks: {
    describe: "open tasks, and submissions waiting for review",
    render: (c) => {
      const tk = c.snapshot.system?.tasks;
      if (!tk) return undefined;
      const t = c.theme;
      const icon = t.unicode ? "◇" : "#";
      const review = tk.submitted ? ` ${tk.submitted} to review` : "";
      return seg(
        `${icon} ${tk.open} open${review}`,
        `${t.fg("info")(icon)} ${t.fg("muted")(`${tk.open} open`)}${review ? t.fg("warning")(review) : ""}`,
      );
    },
  },
  approvals: {
    describe: "held actions waiting for a person (hidden when none)",
    render: (c) => {
      const n = c.snapshot.alerts?.filter((a) => a.attention === "approval").length ?? 0;
      if (!n) return undefined;
      const g = glyphsFor(c.theme);
      const text = `${g.approval} ${n} approval${n === 1 ? "" : "s"}`;
      return seg(text, c.theme.bold(c.theme.fg("warning")(text)));
    },
  },
  alerts: {
    describe: "open operational alerts (hidden when none)",
    render: (c) => {
      const rows = c.snapshot.alerts?.filter((a) => a.attention !== "approval");
      if (!rows?.length) return undefined;
      const g = glyphsFor(c.theme);
      const critical = rows.filter((a) => a.severity === "critical").length;
      const text = `${critical ? g.error : g.warn} ${rows.length} alert${rows.length === 1 ? "" : "s"}`;
      return seg(text, c.theme.fg(critical ? "error" : "warning")(text));
    },
  },
  spend: {
    describe: "upstream spend today (UTC), with a meter when a cap is set",
    render: (c) => {
      const s = c.snapshot.ops?.spend;
      if (!s) return undefined;
      const t = c.theme;
      if (s.capUsd) {
        const ratio = s.todayUsd / s.capUsd;
        return seg(
          `${money(s.todayUsd)}/${money(s.capUsd)}`,
          `${t.fg("muted")(`${money(s.todayUsd)}/${money(s.capUsd)}`)} ${meter(t, ratio, 5)}`,
        );
      }
      return seg(`${money(s.todayUsd)} today`, t.fg("muted")(`${money(s.todayUsd)} today`));
    },
  },
  standing: {
    describe: "your standing (verified work) and rank",
    render: (c) => {
      const p = c.snapshot.profile;
      if (!p) return undefined;
      const t = c.theme;
      const icon = t.unicode ? "◈" : "*";
      const text = `${p.standing.toFixed(1)} r${p.rank}`;
      return seg(`${icon} ${text}`, `${t.fg("highlight")(icon)} ${t.fg("muted")(text)}`);
    },
  },
  ready: {
    describe: "capability readiness: ok / degraded / off",
    render: (c) => {
      const checks = c.snapshot.readiness?.checks;
      if (!checks) return undefined;
      const t = c.theme;
      const ok = checks.filter((x) => x.status === "ok").length;
      const degraded = checks.filter((x) => x.status === "degraded").length;
      const off = checks.filter((x) => x.status === "off").length;
      const g = glyphsFor(t);
      const plain = `${g.ok} ${ok}${degraded ? ` ${g.warn} ${degraded}` : ""}${off ? ` ${g.error} ${off}` : ""}`;
      return seg(
        plain,
        `${t.fg("success")(g.ok)} ${t.fg("muted")(String(ok))}${degraded ? ` ${t.fg("warning")(`${g.warn} ${degraded}`)}` : ""}${off ? ` ${t.fg("error")(`${g.error} ${off}`)}` : ""}`,
      );
    },
  },
  profile: {
    describe: "the server's trust profile (local / shared / public)",
    render: (c) => {
      const p = c.snapshot.readiness?.profile;
      return p ? seg(p, c.theme.fg("muted")(p)) : undefined;
    },
  },
  cwd: {
    describe: "this terminal's working folder (~ for home)",
    render: (c) => {
      const cwd = c.cwd ?? process.cwd();
      const home = homedir();
      const short =
        cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
      const parts = short.split("/");
      const trimmed = parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)].join("/") : short;
      return seg(trimmed, c.theme.bold(c.theme.fg("info")(trimmed)));
    },
  },
  git: {
    describe: "the git branch of the working folder",
    render: (c) => {
      const b = gitBranch(c.cwd ?? process.cwd());
      if (!b) return undefined;
      const icon = c.theme.unicode ? "⎇ " : "git:";
      return seg(`${icon}${b}`, c.theme.fg("accent2")(`${icon}${b}`));
    },
  },
  time: {
    describe: "local time",
    render: (c) => {
      const d = c.now ?? new Date();
      const s = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return seg(s, c.theme.fg("faint")(s));
    },
  },
  took: {
    describe: "how long the last command took (when 2 s or more)",
    render: (c) =>
      c.last && c.last.ms >= 2_000
        ? seg(`took ${duration(c.last.ms)}`, c.theme.fg("warning")(`took ${duration(c.last.ms)}`))
        : undefined,
  },
  queued: {
    describe: "commands waiting behind the one running",
    render: (c) =>
      c.queued ? seg(`${c.queued} queued`, c.theme.fg("warning")(`${c.queued} queued`)) : undefined,
  },
};

// ── Format language ─────────────────────────────────────────────────────────

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string }
  | { kind: "style"; children: Node[]; style: string }
  | { kind: "optional"; children: Node[] };

/** Parse a format. Unbalanced brackets fall back to literal text, never an error. */
export function parseFormat(format: string): Node[] {
  let i = 0;
  const parse = (end?: string): Node[] => {
    const nodes: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push({ kind: "text", text });
      text = "";
    };
    while (i < format.length) {
      const ch = format[i]!;
      if (end && ch === end) {
        flush();
        return nodes;
      }
      if (ch === "\\" && i + 1 < format.length) {
        text += format[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$") {
        const m = format.slice(i + 1).match(/^[a-z_]+/);
        if (m) {
          flush();
          nodes.push({ kind: "var", name: m[0] });
          i += 1 + m[0].length;
          continue;
        }
      }
      if (ch === "[") {
        const start = i;
        i++;
        const children = parse("]");
        if (format[i] === "]" && format[i + 1] === "(") {
          const close = format.indexOf(")", i + 2);
          if (close > 0) {
            flush();
            nodes.push({ kind: "style", children, style: format.slice(i + 2, close) });
            i = close + 1;
            continue;
          }
        }
        i = start + 1;
        text += "[";
        continue;
      }
      if (ch === "(") {
        const start = i;
        i++;
        const children = parse(")");
        if (format[i] === ")") {
          flush();
          nodes.push({ kind: "optional", children });
          i++;
          continue;
        }
        i = start + 1;
        text += "(";
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return nodes;
  };
  return parse();
}

function styleFn(theme: Theme, style: string): (text: string) => string {
  const words = style.split(/\s+/).filter(Boolean);
  return (text) => {
    if (!theme.level || !text) return text;
    const params: string[] = [];
    for (const w of words) {
      if (w === "bold") params.push("1");
      else if (w === "italic") params.push("3");
      else if (w === "underline") params.push("4");
      else if (w === "dim") params.push(theme.params("muted"));
      else if (/^#[0-9a-f]{6}$/i.test(w)) params.push(fgParams(w, theme.level));
      else if (w in theme.palette.tokens) params.push(theme.params(w as Token));
    }
    return params.length ? `\x1b[${params.join(";")}m${text}\x1b[0m` : text;
  };
}

/** Render a format against live segments. */
export function renderFormat(format: string, context: SegmentContext): string {
  const nodes = parseFormat(format);
  const walk = (list: Node[], styled: boolean): { out: string; filled: boolean } => {
    let out = "";
    let filled = false;
    for (const node of list) {
      if (node.kind === "text") out += styled ? node.text : node.text;
      else if (node.kind === "var") {
        const segment = SEGMENTS[node.name]?.render(context);
        if (segment) {
          out += styled ? segment.plain : segment.styled;
          filled = true;
        }
      } else if (node.kind === "style") {
        const inner = walk(node.children, true);
        out += styleFn(context.theme, node.style)(inner.out);
        filled ||= inner.filled;
      } else {
        const inner = walk(node.children, styled);
        if (inner.filled) {
          out += inner.out;
          filled = true;
        }
      }
    }
    return { out, filled };
  };
  return walk(nodes, false).out;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface CliFormats {
  prompt: string;
  status: string;
  statusRight: string;
  rule: string;
}

export const DEFAULT_FORMATS: CliFormats = {
  prompt: "$character ",
  status:
    "$health( · $agents)( · $tasks)( · $approvals)( · $alerts)( · $spend)( · $standing)( · $took)",
  statusRight: "$connection $name",
  rule: "($room)( · $here)",
};

export const FORMAT_ENV: Record<keyof CliFormats, string> = {
  prompt: "MARINA_PROMPT",
  status: "MARINA_STATUSLINE",
  statusRight: "MARINA_STATUSLINE_RIGHT",
  rule: "MARINA_PROMPT_RULE",
};

const CONFIG_FILE = join(homedir(), ".marina", "cli.json");

export interface CliConfig extends CliFormats {
  theme?: string;
}

function readConfig(file: string): Partial<CliConfig> {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Partial<CliConfig> = {};
    for (const key of [...Object.keys(DEFAULT_FORMATS), "theme"] as (keyof CliConfig)[])
      if (typeof parsed[key] === "string") out[key] = parsed[key] as string;
    return out;
  } catch {
    return {};
  }
}

/** Defaults, then ~/.marina/cli.json, then environment variables (env wins). */
export function loadCliConfig(env = process.env, file = CONFIG_FILE): CliConfig {
  const config: CliConfig = { ...DEFAULT_FORMATS, ...readConfig(file) };
  for (const key of Object.keys(FORMAT_ENV) as (keyof CliFormats)[]) {
    const value = env[FORMAT_ENV[key]];
    if (value !== undefined) config[key] = value;
  }
  if (env.MARINA_THEME) config.theme = env.MARINA_THEME;
  return config;
}

/** Persist one setting (undefined resets it to the default). Mode 0600. */
export function saveCliSetting(
  key: keyof CliConfig,
  value: string | undefined,
  file = CONFIG_FILE,
): void {
  const current = readConfig(file) as Record<string, string>;
  if (value === undefined) delete current[key];
  else current[key] = value;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
