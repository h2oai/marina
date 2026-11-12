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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
    name: "streams",
    aliases: ["participants"],
    describe: "participant sessions (Claude, Codex, pi …): who is asking, failing or running",
    needs: ["streams"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      const streams = c.snapshot.streams;
      if (c.snapshot.denied?.streams)
        return card(t, "Streams", [t.fg("faint")("streams need a signed-in world account")]);
      if (!streams) return card(t, "Streams", waiting(c, "participant sessions"));
      if (!streams.items.length)
        return card(t, "Streams", [
          t.fg("faint")("no participant sessions — /spawn claude|codex|pi starts one"),
        ]);
      // Needs-you first: asking, then failing, then running; idle and gone last.
      const rank = (r: (typeof streams.items)[number]) =>
        r.asking
          ? 0
          : r.status === "failed" || r.error || r.deliveryError
            ? 1
            : r.status === "running"
              ? 2
              : r.status === "left" || r.status === "stopped"
                ? 4
                : 3;
      const rows = [...streams.items].sort(
        (a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt,
      );
      const body = columns(
        rows.map((r) => {
          const tone: Token = r.asking
            ? "warning"
            : rank(r) === 1
              ? "error"
              : r.status === "running"
                ? "success"
                : "faint";
          const state = r.asking
            ? "asking you"
            : r.deliveryError && !r.error
              ? "delivery failed"
              : r.status;
          return [
            `${t.fg(tone)(r.asking ? g.approval : g.agent)} ${t.identity(r.label)(clean(t, r.label))}`,
            t.fg("muted")(clean(t, r.adapter || r.kind || "—")),
            t.fg("code")(clean(t, r.model || "—")),
            t.fg(tone)(clean(t, state)),
            r.error
              ? t.fg("error")(clean(t, r.error))
              : t.fg("muted")(r.owned ? "yours" : "shared"),
          ];
        }),
      );
      const asking = rows.filter((r) => r.asking).length;
      return card(t, "Streams", body, `${streams.total}${asking ? ` · ${asking} asking` : ""}`);
    },
  },
  {
    name: "tasks",
    aliases: ["work"],
    describe: "the shared task board: open, claimed and waiting for review",
    needs: ["tasks"],
    render: (c) => {
      const t = c.theme;
      const tasks = c.snapshot.tasks;
      if (!tasks) return card(t, "Tasks", waiting(c, "the task board"));
      const live = tasks.items.filter((r) => r.status === "open" || r.status === "claimed");
      if (!live.length)
        return card(t, "Tasks", [t.fg("faint")("no open tasks — task create <title> posts one")]);
      // Waiting for review first: an open task with submissions is the creator's move.
      const rank = (r: (typeof live)[number]) => (r.submitted ? 0 : r.claimed ? 1 : 2);
      const rows = [...live].sort(
        (a, b) => rank(a) - rank(b) || b.priority - a.priority || b.id - a.id,
      );
      const body = columns(
        rows.map((r) => {
          const state = r.submitted
            ? `${r.submitted} to review`
            : r.claimed
              ? `${r.claimed} working`
              : "open";
          const tone: Token = r.submitted ? "warning" : r.claimed ? "success" : "muted";
          return [
            t.fg("faint")(`#${r.id}`),
            clean(t, r.title),
            t.fg(tone)(state),
            t.fg("muted")(clean(t, r.creator)),
          ];
        }),
      );
      const review = live.filter((r) => r.submitted).length;
      return card(t, "Tasks", body, `${live.length} open${review ? ` · ${review} to review` : ""}`);
    },
  },
  {
    name: "dreams",
    describe: "the dream pass: proposals waiting for you, then what recent dreams did",
    needs: ["dreams"],
    render: (c) => {
      const t = c.theme;
      const d = c.snapshot.dreams;
      if (!d) return card(t, "Dreams", waiting(c, "dream records"));
      const right = `dreaming ${d.mode || "?"}`;
      if (!d.items.length)
        return card(
          t,
          "Dreams",
          [t.fg("faint")("no dreams yet — memory dream why says what each gate is waiting on")],
          right,
        );
      // Waiting for you first: pending proposals take `memory dream adopt|dismiss`.
      const rows = [...d.items].sort(
        (a, b) => Number(b.pending > 0) - Number(a.pending > 0) || b.createdAt - a.createdAt,
      );
      const body = columns(
        rows.map((r) => {
          const tone: Token = r.pending
            ? "warning"
            : r.state === "applied"
              ? "success"
              : r.state === "rolled_back"
                ? "faint"
                : "muted";
          return [
            t.fg("faint")(`#${r.id}`),
            t.identity(r.entity)(clean(t, r.pool ? `pool:${r.entity}` : r.entity)),
            t.fg(tone)(r.pending ? `${r.pending} to adopt` : r.state.replace("_", " ")),
            t.fg("muted")(`${r.applied} applied · ${r.rejected} rejected`),
            t.fg("faint")(fmtDuration(Date.now() - r.createdAt)),
          ];
        }),
      );
      const pending = rows.filter((r) => r.pending).length;
      const lines = [
        ...body,
        ...(pending
          ? [t.fg("muted")("memory dream proposals · memory dream adopt|dismiss <id> [n]")]
          : []),
        ...(d.guarded.length
          ? [t.fg("warning")(`guard tripped: ${d.guarded.map((n) => clean(t, n)).join(", ")}`)]
          : []),
      ];
      return card(t, "Dreams", lines, pending ? `${pending} waiting · ${right}` : right);
    },
  },
  {
    name: "memory",
    aliases: ["mem"],
    describe: "memory health: contradictions, stale and duplicate records, provenance, open jobs",
    needs: ["memory"],
    render: (c) => {
      const t = c.theme;
      const m = c.snapshot.memory;
      if (!m) return card(t, "Memory", waiting(c, "memory health"));
      const of = (x: { n: number; of: number }, bad: boolean) => {
        const tone: Token = !x.of ? "faint" : bad && x.n ? "warning" : "muted";
        return t.fg(tone)(x.of ? `${x.n} of ${x.of}` : "—");
      };
      const body = kv(t, [
        [
          "contradictions",
          `${of(m.unresolved, true)}${m.unresolved.n ? t.fg("muted")("  · note conflicts") : ""}`,
        ],
        ["stale", of(m.stale, true)],
        ["duplicates", of(m.duplicates, true)],
        ["with sources", of(m.provenance, false)],
        [
          "memory jobs",
          m.openJobs ? t.fg("warning")(`${m.openJobs} open`) : t.fg("muted")("none open"),
        ],
        ["resolutions", t.fg("muted")(String(m.resolutions))],
      ]);
      return card(
        t,
        "Memory",
        body,
        m.scope === "own" ? "yours" : m.scope === "all" ? "whole world" : m.scope,
      );
    },
  },
  {
    name: "traces",
    describe: "recent execution traces: failed runs and failed checks first",
    needs: ["traces"],
    render: (c) => {
      const t = c.theme;
      if (c.snapshot.denied?.traces)
        return card(t, "Traces", [
          t.fg("faint")(
            "traces need operator read — trace find status=failed still searches yours",
          ),
        ]);
      const traces = c.snapshot.traces;
      if (!traces) return card(t, "Traces", waiting(c, "execution traces"));
      if (!traces.length)
        return card(t, "Traces", [
          t.fg("faint")("no traces yet — they appear as models are called"),
        ]);
      const bad = (r: (typeof traces)[number]) =>
        r.status === "failed" || r.failedChecks.length > 0;
      const rows = [...traces].sort(
        (a, b) => Number(bad(b)) - Number(bad(a)) || b.startedAt - a.startedAt,
      );
      const body = columns(
        rows.map((r) => {
          const tone: Token = bad(r) ? "error" : r.status === "running" ? "warning" : "success";
          return [
            t.fg("faint")(clean(t, r.id)),
            t.fg(tone)(r.status),
            t.fg("code")(clean(t, r.model || "—")),
            t.fg("muted")(r.durationMs === null ? "…" : `${(r.durationMs / 1000).toFixed(1)}s`),
            t.fg("muted")(`${r.spans} spans`),
            r.failedChecks.length
              ? t.fg("error")(clean(t, r.failedChecks.join(", ")))
              : t.fg("faint")(fmtDuration(Date.now() - r.startedAt)),
          ];
        }),
      );
      const failed = rows.filter(bad).length;
      return card(
        t,
        "Traces",
        [...body, t.fg("muted")("trace show <id> · trace find status=failed")],
        failed ? `${failed} failed of ${rows.length}` : `${rows.length}`,
      );
    },
  },
  {
    name: "feed",
    aliases: ["activity"],
    describe: "the activity feed: what happened in the world, newest first",
    needs: ["feed"],
    render: (c) => {
      const t = c.theme;
      const feed = c.snapshot.feed;
      if (!feed) return card(t, "Feed", waiting(c, "the activity feed"));
      if (!feed.length) return card(t, "Feed", [t.fg("faint")("nothing has happened yet")]);
      const body = columns(
        [...feed]
          .sort((a, b) => b.at - a.at)
          .map((r) => [
            t.fg("faint")(fmtDuration(Date.now() - r.at)),
            t.fg("muted")(clean(t, r.kind)),
            r.entity ? t.identity(r.entity)(clean(t, r.entity)) : t.fg("faint")("—"),
            clean(t, r.summary),
          ]),
      );
      return card(t, "Feed", [...body, t.fg("muted")("feed list kind:<k> entity:<name> since:2h")]);
    },
  },
  {
    name: "logs",
    aliases: ["log"],
    describe: "recent errors and warnings from the server log, errors first",
    needs: ["logs"],
    render: (c) => {
      const t = c.theme;
      if (c.snapshot.denied?.logs)
        return card(t, "Logs", [t.fg("faint")("logs need operator read")]);
      const logs = c.snapshot.logs;
      if (!logs) return card(t, "Logs", waiting(c, "the server log"));
      if (!logs.length)
        return card(t, "Logs", [t.fg("success")(`${glyphsFor(t).ok} no errors or warnings`)]);
      const rows = [...logs].sort(
        (a, b) => Number(b.level === "error") - Number(a.level === "error") || b.at - a.at,
      );
      const body = columns(
        rows.map((r) => [
          t.fg("faint")(fmtDuration(Date.now() - r.at)),
          t.fg(r.level === "error" ? "error" : "warning")(r.level),
          t.fg("muted")(clean(t, r.category)),
          clean(t, r.message.replace(/\s+/g, " ")),
        ]),
      );
      const errors = rows.filter((r) => r.level === "error").length;
      return card(
        t,
        "Logs",
        [...body, t.fg("muted")("/dashboard for search, levels and trace links")],
        `${plural(errors, "error")} · ${plural(rows.length - errors, "warning")}`,
      );
    },
  },
  {
    name: "setup",
    aliases: ["admin", "security"],
    describe: "how this world is set up: sign-in, key storage, default model, provider keys",
    needs: ["setup"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      if (c.snapshot.denied?.setup)
        return card(t, "Setup", [t.fg("faint")("setup needs a signed-in world account")]);
      const s = c.snapshot.setup;
      if (!s) return card(t, "Setup", waiting(c, "the world's setup"));
      const ok = (text: string) => t.fg("success")(`${g.ok} ${text}`);
      const warn = (text: string) => t.fg("warning")(`${g.warn} ${text}`);
      const body = kv(t, [
        ["sign-in", s.authRequired ? ok("required") : warn("not required")],
        [
          "model API",
          s.openApi
            ? t.fg("error")(`${g.error} open without a key (dev only)`)
            : ok("key required"),
        ],
        [
          "stored keys",
          s.keyEncryption
            ? ok("encrypted at rest")
            : warn("plaintext — set MARINA_KEY_SECRET, or use provider env vars"),
        ],
        [
          "default model",
          `${t.fg("code")(clean(t, s.defaultModel))}${t.fg("faint")(s.modelConfigured ? "  set at runtime" : "  from the environment")}`,
        ],
        ["roles", s.roles === null ? undefined : String(s.roles)],
      ]);
      if (s.unreadableKeys)
        body.push(
          t.fg("error")(
            `${g.error} ${s.unreadableKeys} stored key(s) do not decrypt: MARINA_KEY_SECRET is missing or changed`,
          ),
        );
      body.push("");
      if (s.keys === null) body.push(t.fg("faint")("Provider keys are shown to operators only."));
      else if (!s.keys.length)
        body.push(
          t.fg("faint")("no stored provider keys — environment variables are never listed"),
        );
      else
        body.push(
          ...columns(
            [...s.keys]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((k) => [
                t.fg("code")(clean(t, k.name)),
                t.fg("muted")(clean(t, k.provider)),
                t.fg("faint")(k.setBy ? `set by ${clean(t, k.setBy)}` : ""),
                t.fg("faint")(k.updatedAt ? fmtDuration(Date.now() - k.updatedAt) : ""),
              ]),
          ),
        );
      body.push(t.fg("muted")("key list · key test <name> · admin models · readiness"));
      const keys = s.keys === null ? "" : `${s.keys.length} keys`;
      return card(t, "Setup", body, keys);
    },
  },
  {
    name: "forecasts",
    aliases: ["predictions", "inquiries"],
    describe: "your newest predictions and research: running first, then answers and scores",
    needs: ["forecasts"],
    render: (c) => {
      const t = c.theme;
      if (c.snapshot.denied?.forecasts)
        return card(t, "Forecasts", [t.fg("faint")("predictions need a signed-in world account")]);
      const f = c.snapshot.forecasts;
      if (!f) return card(t, "Forecasts", waiting(c, "your predictions"));
      if (!f.items.length)
        return card(t, "Forecasts", [
          t.fg("faint")("no predictions yet — inquiry predict -- <question> asks one"),
        ]);
      const active = (r: (typeof f.items)[number]) => r.state === "running" || r.state === "queued";
      const rows = [...f.items].sort(
        (a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt,
      );
      const lines = rows.flatMap((r) => {
        const tone: Token = active(r)
          ? "warning"
          : r.state === "failed" || r.state === "interrupted"
            ? "error"
            : r.state === "completed"
              ? "success"
              : "faint";
        const outcome = r.resolved
          ? t.fg("accent")(`resolved${r.loss === null ? "" : ` · loss ${r.loss.toFixed(3)}`}`)
          : r.answer
            ? clean(t, r.answer)
            : t.fg(tone)(r.state || "unknown");
        return [
          `${t.fg(tone)(r.kind === "research" ? "◇" : "◆")} ${clean(t, r.question)}`,
          `   ${outcome}  ${t.fg("faint")(`${r.id} · ${fmtDuration(Date.now() - r.updatedAt)}`)}`,
        ];
      });
      const running = rows.filter(active).length;
      return card(
        t,
        "Forecasts",
        [...lines, t.fg("muted")("inquiry show <case-id> · inquiry why <case-id>")],
        `${f.total}${running ? ` · ${running} running` : ""}`,
      );
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
        ...(s.scopes.length ? [""] : []),
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
    aliases: ["inbox", "approvals", "held"],
    describe: "held actions (yours to answer, and your own) and open alerts",
    needs: ["challenges", "alerts"],
    render: (c) => {
      const t = c.theme;
      const g = glyphsFor(t);
      const now = Date.now();
      const left = (at: number) => `${Math.max(0, Math.round((at - now) / 60_000))} min left`;
      const body: string[] = [];
      const holds = c.snapshot.challenges;
      if (holds?.answerable.length) {
        body.push(t.bold(t.fg("warning")(`${g.approval} Waiting on your answer`)));
        for (const h of holds.answerable) {
          body.push(
            `  ${t.fg("highlight")(clean(t, h.token))} ${t.identity(h.requester)(clean(t, h.requester))} ${t.fg("faint")("→")} ${clean(t, h.summary)}`,
          );
          body.push(`    ${t.fg("muted")(`${clean(t, h.reason)} · ${left(h.expiresAt)}`)}`);
          body.push(
            `    ${t.fg("code")(`challenge approve ${clean(t, h.token)}`)} ${t.fg("faint")("or")} ${t.fg("code")("deny")}`,
          );
        }
      }
      if (holds?.raised.length) {
        if (body.length) body.push("");
        body.push(t.bold(t.fg("accent")(`${t.unicode ? "⧗" : "~"} You asked`)));
        for (const h of holds.raised) {
          body.push(`  ${t.fg("highlight")(clean(t, h.token))} ${clean(t, h.summary)}`);
          body.push(`    ${t.fg("muted")(`${clean(t, h.reason)} · ${left(h.expiresAt)}`)}`);
        }
      }
      const rows = c.snapshot.alerts;
      const order = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
      if (rows?.length) {
        if (body.length) body.push("");
        body.push(t.bold(t.fg("accent")("Operational alerts")));
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
      }
      if (!holds && !rows) return card(t, "Attention", waiting(c, "held actions and alerts"));
      if (!body.length) body.push(t.fg("success")(`${g.ok} nothing waiting`));
      if (c.snapshot.denied?.alerts)
        body.push("", t.fg("faint")("Operational alerts are shown to operators only."));
      const counts = [
        holds ? `${holds.answerable.length} to answer · ${holds.raised.length} held` : "",
        rows ? `${rows.length} alerts` : "",
      ].filter(Boolean);
      return card(t, "Attention", body, counts.join(" · "));
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
