// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash panels for the interactive CLI: `/status`, `/agents`, `/spend` …
 * Dashboard views drawn as terminal cards from the same snapshot the status
 * bar reads. Panels are local and read-only; world commands never start
 * with `/`, so the two never collide.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_FORMATS, meter, renderFormat, SEGMENTS, type SegmentContext } from "./term-prompt";
import { glyphsFor } from "./term-render";
import { sanitizeServerText } from "./term-sanitize";
import type { Part } from "./term-status";
import { PALETTES, type Theme, type Token } from "./term-theme";

export interface Panel {
  name: string;
  aliases?: string[];
  describe: string;
  /** Snapshot parts to refresh before drawing. */
  needs?: Part[];
  render: (c: SegmentContext) => string[];
}

const cardWidth = (theme: Theme) => Math.min(theme.columns, 100);

/** A rounded card: `╭─ Title ───── right ─╮`, body lines, `╰──╯`. */
export function card(theme: Theme, title: string, body: string[], right = ""): string[] {
  const g = glyphsFor(theme).box;
  const width = cardWidth(theme);
  const inner = width - 4;
  const b = theme.fg("border");
  const head = ` ${theme.bold(theme.fg("accent")(title))} `;
  const tail = right ? ` ${theme.fg("muted")(right)} ` : "";
  const fill = Math.max(1, width - 3 - visibleWidth(head) - visibleWidth(tail) - 1);
  const top = `${b(`${g.tl}${g.h}`)}${head}${b(g.h.repeat(fill))}${tail}${b(`${g.h}${g.tr}`)}`;
  const rows = (body.length ? body : [theme.fg("faint")("nothing to show")]).map((line) => {
    const cut = truncateToWidth(line, inner);
    return `${b(g.v)} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${b(g.v)}`;
  });
  return [top, ...rows, b(`${g.bl}${g.h.repeat(width - 2)}${g.br}`)];
}

/** Two-column key/value rows with aligned keys. */
function kv(theme: Theme, rows: [string, string | undefined][]): string[] {
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  const pad = Math.max(...shown.map(([k]) => k.length), 0) + 2;
  return shown.map(([k, v]) => `${theme.fg("muted")(k.padEnd(pad))}${v}`);
}

/** Aligned columns; widths from the widest cell. */
function columns(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows)
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleWidth(cell) + gap),
      )
      .join(""),
  );
}

const fmtDuration = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
};
const money = (usd: number) => `$${usd.toFixed(2)}`;
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const clean = (theme: Theme, s: string) => sanitizeServerText(s, theme);

function waiting(c: SegmentContext, what: string): string[] {
  return [
    c.theme.fg("faint")(`${what} not available yet (the server may not expose it to this session)`),
  ];
}

const STATUS_TONE: Record<string, Token> = {
  ok: "success",
  degraded: "warning",
  off: "error",
  optional: "faint",
};

export const PANELS: Panel[] = [
  {
    name: "status",
    aliases: ["s"],
    describe: "the world at a glance — health, people, agents, work, spend",
    render: (c) => {
      const t = c.theme;
      const s = c.snapshot;
      const seg = (name: string) => SEGMENTS[name]?.render(c)?.styled;
      const h = s.health;
      const sys = s.system;
      const lines = kv(t, [
        [
          "world",
          s.world
            ? `${t.bold(clean(t, s.world.name))}${c.room ? t.fg("muted")(`  ·  you are in ${clean(t, c.room)}`) : ""}`
            : undefined,
        ],
        [
          "server",
          h
            ? `${seg("health")}${t.fg("muted")(`  ·  up ${fmtDuration(h.uptimeMs)}  ·  tick ${h.tickAgoMs}ms ago${h.tickErrors ? `  ·  ${h.tickErrors} tick errors` : ""}`)}`
            : undefined,
        ],
        [
          "people",
          h && sys
            ? t.fg("muted")(
                `${h.connections} connected  ·  ${sys.entities.total} entities  ·  ${sys.rooms} rooms`,
              )
            : undefined,
        ],
        ["agents", seg("agents")],
        [
          "tasks",
          sys
            ? `${seg("tasks")}${t.fg("muted")(`  ·  ${sys.tasks.claimed} claimed  ·  ${sys.tasks.completed} done`)}`
            : undefined,
        ],
        ["spend", seg("spend")],
        [
          "you",
          s.profile
            ? `${t.identity(c.name)(c.name)}  ${seg("standing")}${t.fg("muted")(`  ·  ${s.profile.actions} actions  ·  ${s.profile.gates} gates passed`)}`
            : t.identity(c.name)(c.name),
        ],
        ["ready", seg("ready")],
        [
          "attention",
          [seg("approvals"), seg("alerts")].filter(Boolean).join("  ") ||
            t.fg("success")("nothing waiting"),
        ],
      ]);
      return card(t, "Status", lines, s.readiness?.profile ? `${s.readiness.profile} profile` : "");
    },
  },
  {
    name: "agents",
    aliases: ["a"],
    describe: "agents you may see: state, model, uptime, tokens, cost",
    needs: ["ops"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      const rows = c.snapshot.ops?.agents;
      if (!rows) return card(t, "Agents", waiting(c, "agent operator data"));
      if (!rows.length)
        return card(
          t,
          "Agents",
          [t.fg("faint")("no agents running — agent spawn <name> … starts one")],
          c.snapshot.ops?.scope ?? "",
        );
      const body = columns(
        rows.map((a) => {
          const tone: Token = a.paused
            ? "warning"
            : a.state === "error" || a.consecutiveErrors >= 3
              ? "error"
              : ["stopped", "stopping"].includes(a.state)
                ? "faint"
                : "success";
          const state = a.paused ? `paused · ${a.paused.kind}` : a.state;
          return [
            `${t.fg(tone)(g.voice)} ${t.identity(a.name)(clean(t, a.name))}`,
            t.fg("muted")(clean(t, a.role || "—")),
            t.fg("code")(clean(t, a.model || "—")),
            t.fg(tone)(state),
            t.fg("muted")(fmtDuration(a.uptimeMs)),
            t.fg("muted")(`${tokens(a.tokens.input + a.tokens.output)} tok`),
            t.fg("muted")(money(a.cost.totalUsd)),
          ];
        }),
      );
      return card(t, "Agents", body, `${rows.length} · ${c.snapshot.ops?.scope ?? ""}`);
    },
  },
  {
    name: "spend",
    aliases: ["cost", "$"],
    describe: "upstream spend today by scope, against the daily cap",
    needs: ["ops"],
    render: (c) => {
      const t = c.theme;
      const s = c.snapshot.ops?.spend;
      if (!s) return card(t, "Spend", waiting(c, "spend"));
      const top = Math.max(s.todayUsd, ...s.scopes.map((x) => x.spentUsd), 0.0001);
      const lines = [
        ...kv(t, [
          [
            "today",
            `${t.bold(money(s.todayUsd))}${s.capUsd ? t.fg("muted")(` of ${money(s.capUsd)} cap  `) + meter(t, s.todayUsd / s.capUsd, 20) : t.fg("muted")("  · uncapped")}`,
          ],
          ["last hour", t.fg("muted")(money(s.lastHourUsd))],
        ]),
        "",
        ...columns(
          [...s.scopes]
            .sort((a, b) => b.spentUsd - a.spentUsd)
            .map((x) => [
              t.fg("muted")(clean(t, x.scope)),
              money(x.spentUsd),
              meter(t, x.spentUsd / top, 24, "accent"),
            ]),
        ),
      ];
      return card(t, "Spend", lines, "UTC day");
    },
  },
  {
    name: "alerts",
    aliases: ["inbox", "approvals"],
    describe: "open alerts and held actions that wait for a person",
    needs: ["alerts"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      const rows = c.snapshot.alerts;
      if (!rows) return card(t, "Attention", waiting(c, "alerts"));
      const order = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
      const body: string[] = [];
      for (const a of [...rows].sort(
        (x, y) => (order[x.severity] ?? 3) - (order[y.severity] ?? 3),
      )) {
        const approval = a.attention === "approval";
        const tone: Token = approval
          ? "warning"
          : a.severity === "critical"
            ? "error"
            : a.severity === "warning"
              ? "warning"
              : "info";
        const glyph = approval ? g.approval : a.severity === "critical" ? g.error : g.warn;
        body.push(
          `${t.fg(tone)(glyph)} ${t.bold(clean(t, a.title))}${t.fg("faint")(a.occurrences > 1 ? `  ×${a.occurrences}` : "")}`,
        );
        if (a.detail) body.push(`  ${t.fg("muted")(clean(t, a.detail))}`);
        if (a.remedy) body.push(`  ${t.fg("faint")("try")} ${t.fg("code")(clean(t, a.remedy))}`);
      }
      return card(
        t,
        "Attention",
        body.length ? body : [t.fg("success")(`${g.ok} nothing waiting`)],
        `${rows.length} open`,
      );
    },
  },
  {
    name: "readiness",
    aliases: ["ready", "doctor"],
    describe: "what is configured, degraded or missing (the readiness report)",
    needs: ["readiness"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      const checks = c.snapshot.readiness?.checks;
      if (!checks) return card(t, "Readiness", waiting(c, "readiness"));
      const glyph: Record<string, string> = {
        ok: g.ok,
        degraded: g.warn,
        off: g.error,
        optional: "○",
      };
      const pad = Math.min(34, Math.max(...checks.map((x) => x.label.length)) + 2);
      const body = checks.flatMap((x) => {
        const tone = STATUS_TONE[x.status] ?? "muted";
        const lines = [
          `${t.fg(tone)(glyph[x.status] ?? "·")} ${clean(t, x.label).padEnd(pad)}${t.fg("muted")(clean(t, x.detail))}`,
        ];
        if (x.remediation && x.status !== "ok")
          lines.push(`  ${t.fg("faint")(`${g.arrive} ${clean(t, x.remediation)}`)}`);
        return lines;
      });
      return card(t, "Readiness", body, SEGMENTS.ready?.render(c)?.plain ?? "");
    },
  },
  {
    name: "world",
    aliases: ["map", "rooms"],
    describe: "rooms, who is where",
    needs: ["world"],
    render: (c) => {
      const t = c.theme;
      const w = c.snapshot.world;
      if (!w) return card(t, "World", waiting(c, "the world map"));
      const here = w.entities.find((e) => e.name === c.name)?.room;
      const body = w.rooms.map((r) => {
        const people = w.entities
          .filter((e) => e.room === r.id)
          .map((e) => t.identity(e.name)(clean(t, e.name)));
        const mark = r.id === here ? t.fg("accent")(glyphsFor(t).prompt) : " ";
        return `${mark} ${(r.id === here ? t.bold : (x: string) => x)(clean(t, r.short))}${" ".repeat(Math.max(1, 22 - visibleWidth(clean(t, r.short))))}${t.fg("faint")(clean(t, r.id))}${people.length ? `  ${people.join(", ")}` : ""}`;
      });
      return card(
        t,
        clean(t, w.name) || "World",
        body,
        `${w.rooms.length} rooms · ${w.entities.length} present`,
      );
    },
  },
  {
    name: "me",
    aliases: ["whoami", "profile"],
    describe: "your identity, standing, rank and gates",
    needs: ["profile"],
    render: (c) => {
      const t = c.theme;
      const p = c.snapshot.profile;
      const lines = kv(t, [
        ["name", t.identity(c.name)(c.name)],
        ["room", c.room ? clean(t, c.room) : undefined],
        ["kind", p ? clean(t, p.kind) : undefined],
        [
          "standing",
          p
            ? `${t.bold(p.standing.toFixed(1))}${t.fg("muted")("  verified work, 60-day half-life")}`
            : undefined,
        ],
        ["rank", p ? String(p.rank) : undefined],
        ["gates", p ? t.fg("muted")(`${p.gates} passed`) : undefined],
        [
          "activity",
          p ? t.fg("muted")(`${p.actions} actions · ${p.achievements} achievements`) : undefined,
        ],
      ]);
      return card(t, "You", lines);
    },
  },
  {
    name: "prompt",
    describe: "show or change the prompt and status bar formats (starship-style)",
    render: (c) => {
      const t = c.theme;
      const pad = Math.max(...Object.keys(SEGMENTS).map((k) => k.length)) + 3;
      const body = [
        t.fg("muted")(
          "Formats: $segment · [text](style) · ( shown only when a segment inside has a value )",
        ),
        t.fg("muted")(
          "Styles: theme tokens (accent accent2 muted faint success warning error info code), bold italic underline, #rrggbb",
        ),
        "",
        ...Object.entries(SEGMENTS).map(([name, s]) => {
          const sample = s.render(c)?.styled ?? t.fg("faint")("(empty now)");
          return `${t.fg("code")(`$${name}`.padEnd(pad))}${sample}  ${t.fg("faint")(s.describe)}`;
        }),
        "",
        `${t.fg("muted")("Change")} ${t.fg("code")("/prompt set <format>")} ${t.fg("muted")("·")} ${t.fg("code")("/statusline set <format>")} ${t.fg("muted")("·")} ${t.fg("code")("/prompt reset")}`,
        `${t.fg("muted")("e.g.")}   ${t.fg("code")("/prompt set [$room](bold accent)( [$git](accent2)) $character ")}`,
        `${t.fg("muted")("Preview")} ${renderFormat("[$room](bold accent)( $git) $character ", c)}`,
        `${t.fg("muted")("Env")}    MARINA_PROMPT · MARINA_STATUSLINE · MARINA_STATUSLINE_RIGHT · MARINA_PROMPT_RULE · MARINA_THEME`,
        `${t.fg("muted")("Default")} ${t.fg("faint")(DEFAULT_FORMATS.status)}`,
      ];
      return card(t, "Prompt & status bar", body, "~/.marina/cli.json");
    },
  },
  {
    name: "theme",
    describe: "list themes (harbor, harbor-light, ansi) — /theme <name> to switch",
    render: (c) => {
      const t = c.theme;
      const body = Object.values(PALETTES).map((p) => {
        const swatches = (
          ["accent", "accent2", "success", "warning", "error", "info", "muted"] as Token[]
        )
          .map((k) =>
            t.level >= 2 && !p.ansiOnly
              ? `\x1b[38;2;${hex(p.tokens[k].hex)}m██\x1b[0m`
              : `\x1b[${p.tokens[k].basic}m██\x1b[0m`,
          )
          .join("");
        const mark = p.name === t.palette.name ? t.fg("accent")(glyphsFor(t).prompt) : " ";
        return `${mark} ${p.name.padEnd(14)}${t.level ? swatches : ""}  ${t.fg("faint")(p.ansiOnly ? "your terminal's 16 colours" : p.background)}`;
      });
      return card(t, "Themes", body, `colour depth ${["off", "16", "256", "truecolor"][t.level]}`);
    },
  },
];

function hex(h: string): string {
  const n = Number.parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

export function findPanel(name: string): Panel | undefined {
  const key = name.toLowerCase();
  return PANELS.find((p) => p.name === key || p.aliases?.includes(key));
}
