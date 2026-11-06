// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The measurement behind `MARINA_PEER_RENDER`: how agents on each form
 * (one-line `flat`, or `structured`) handle peer messages in one world. It
 * reads a world database, read-only, and prints counts and rates only, never
 * message text.
 *
 *   bun scripts/peer-render-report.ts [--db marina.db] [--since 7d|<iso>] [--mode split|structured:a,b] [--json]
 *   bun scripts/peer-render-report.ts --corpus [--db marina.db]
 *
 * Per arm (agents by name; the arm from their `agent_reply_ledger` events,
 * else `--mode`, else this process's `MARINA_PEER_RENDER`):
 *  - replies owed, and those that left the ledger unsettled (expired, evicted);
 *  - agent channel posts and tells: share carrying a `cause` (threaded), share
 *    whose cause points at the wrong thread (a tell answering someone other
 *    than its recipient, a post answering another channel), share opening
 *    "<Name> re …" (threading by hand), share echoing the structured form
 *    (a `│` guard line or a `[#ch post:N` header) into what they sent.
 *
 * `--corpus` renders every stored post and tell both ways and checks the
 * structured form: every body line after the header is guarded, no reserved
 * harness marker starts a line, no character of the body is lost, and how
 * many bytes it costs against the one-line form.
 */

import { Database } from "bun:sqlite";
import {
  flattenPeerText,
  PEER_BODY_GUARD,
  type PeerRenderMode,
  peerRenderMode,
  renderPeerMessage,
} from "../src/agent/peer-text";
import { parseDuration } from "../src/engine/commands/format-duration";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = flag("db") ?? process.env.DB_PATH ?? "marina.db";
const db = new Database(dbPath, { readonly: true });

function sinceMs(): number {
  const raw = flag("since") ?? "7d";
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso) && /\d{4}-/.test(raw)) return iso;
  const ms = parseDuration(raw);
  if (ms === undefined || ms === null) throw new Error(`--since: not a duration or date: ${raw}`);
  return Date.now() - Number(ms);
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

// ─── Corpus check (P0) ──────────────────────────────────────────────────────

const FENCE = /<(\/?)(example|untrusted|system|instructions|tool_result|function_results)\b/gi;
const RESERVED_START =
  /^\s*(\[\s*(ACTION REQUIRED|Reply still owed|World Events|steer|Untrusted|peer content|system)|<\/?(untrusted|system|example))/i;

function corpus(): void {
  const rows = [
    ...(
      db
        .query(
          `SELECT m.id, c.name AS channel, m.sender_name AS sender, m.content, m.cause FROM channel_messages m JOIN channels c ON c.id = m.channel_id`,
        )
        .all() as {
        id: number;
        channel: string;
        sender: string;
        content: string;
        cause: string | null;
      }[]
    ).map((r) => ({ ...r, kind: "post" as const })),
    ...(
      db.query(`SELECT id, sender_name AS sender, content, cause FROM direct_messages`).all() as {
        id: number;
        sender: string;
        content: string;
        cause: string | null;
      }[]
    ).map((r) => ({
      ...r,
      channel: undefined as string | undefined,
      kind: "tell" as const,
    })),
  ];
  let unguarded = 0;
  let markerStarts = 0;
  let lost = 0;
  let multiLine = 0;
  let skipped = 0;
  const ratios: number[] = [];
  const extra: number[] = [];
  for (const r of rows) {
    const where = r.kind === "post" ? `#${r.channel}` : "tell";
    if (r.kind === "post" && !/^[\w:-]{1,64}$/.test(r.channel ?? "")) {
      skipped++;
      continue;
    }
    const out = renderPeerMessage({
      where,
      sender: r.sender,
      body: r.content,
      id: r.kind === "post" ? `post:${r.id}` : `tell:${r.id}`,
    });
    const lines = out.split("\n");
    if (lines.length > 1) multiLine++;
    for (const line of lines.slice(1)) {
      if (!line.startsWith(PEER_BODY_GUARD.trimEnd())) unguarded++;
      if (RESERVED_START.test(line)) markerStarts++;
    }
    // Every non-space character of the body survives (fence tags lose only `<`).
    const lead = `${r.sender}:`;
    const body =
      lines.length > 1
        ? lines
            .slice(1)
            .map((l) => l.slice(PEER_BODY_GUARD.length))
            .join("\n")
        : lines[0]!.slice(lines[0]!.indexOf(lead) + lead.length);
    const squash = (t: string) => t.replace(/\s+/g, "");
    const want = r.content.replace(FENCE, "‹$1$2");
    if (squash(body) !== squash(want)) lost++;
    const flat = flattenPeerText(
      `[${r.kind === "post" ? r.channel : "tell"}] ${r.sender}: ${r.content}`,
    );
    const a = Buffer.byteLength(flat, "utf8");
    const b = Buffer.byteLength(out, "utf8");
    ratios.push(b / a);
    extra.push(b - a);
  }
  const report = {
    db: dbPath,
    messages: rows.length,
    skipped,
    multiLine,
    unguardedBodyLines: unguarded,
    reservedMarkerLineStarts: markerStarts,
    bodiesWithLostCharacters: lost,
    bytesRatio: { p50: quantile(ratios, 0.5), p95: quantile(ratios, 0.95) },
    extraBytes: { p50: quantile(extra, 0.5), p95: quantile(extra, 0.95) },
  };
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Corpus ${dbPath}: ${rows.length} messages (${multiLine} multi-line, ${skipped} skipped)`,
    );
    console.log(`  unguarded body lines        ${unguarded}`);
    console.log(`  reserved markers at a start ${markerStarts}`);
    console.log(`  bodies with lost characters ${lost}`);
    console.log(
      `  bytes structured/flat       p50 ${report.bytesRatio.p50.toFixed(2)}  p95 ${report.bytesRatio.p95.toFixed(2)}  (+${report.extraBytes.p50} / +${report.extraBytes.p95} B)`,
    );
  }
  const ok = unguarded === 0 && markerStarts === 0 && lost === 0;
  process.exitCode = ok ? 0 : 1;
}

// ─── Arms (P2) ──────────────────────────────────────────────────────────────

interface Arm {
  agents: Set<string>;
  owed: number;
  expired: number;
  evicted: number;
  sent: number;
  caused: number;
  wrongThread: number;
  byHand: number;
  echoes: number;
}

function arms(): void {
  const since = sinceMs();
  const agents = (db.query("SELECT name FROM agent_configs").all() as { name: string }[]).map(
    (r) => r.name,
  );
  const seen = new Map<string, PeerRenderMode>();
  for (const row of db
    .query("SELECT data FROM event_log WHERE type = 'agent_reply_ledger' AND timestamp >= ?")
    .all(since) as { data: string }[]) {
    const e = JSON.parse(row.data) as { name: string; peerRender: PeerRenderMode };
    seen.set(e.name.toLowerCase(), e.peerRender);
  }
  const mode = flag("mode");
  const armOf = (name: string): PeerRenderMode =>
    seen.get(name.toLowerCase()) ??
    peerRenderMode(mode ? { MARINA_PEER_RENDER: mode } : process.env, name);
  const empty = (): Arm => ({
    agents: new Set(),
    owed: 0,
    expired: 0,
    evicted: 0,
    sent: 0,
    caused: 0,
    wrongThread: 0,
    byHand: 0,
    echoes: 0,
  });
  const out: Record<PeerRenderMode, Arm> = { flat: empty(), structured: empty(), ids: empty() };
  const agentSet = new Map(agents.map((n) => [n.toLowerCase(), n]));
  for (const n of agents) out[armOf(n)].agents.add(n);

  for (const row of db
    .query("SELECT data FROM event_log WHERE type = 'agent_reply_ledger' AND timestamp >= ?")
    .all(since) as { data: string }[]) {
    const e = JSON.parse(row.data) as { name: string; change: string; peerRender: PeerRenderMode };
    out[e.peerRender][e.change as "owed" | "expired" | "evicted"]++;
  }

  const ECHO = /(^|\n)\s*│|\[#[\w:-]+ post:\d+/;
  const tally = (sender: string, content: string, cause: string | null, wrong: boolean) => {
    const name = agentSet.get(sender.toLowerCase());
    if (!name) return;
    const a = out[armOf(name)];
    a.sent++;
    if (cause) a.caused++;
    if (wrong) a.wrongThread++;
    if (/^\s*@?[\w-]+,?\s+re\b/i.test(content)) a.byHand++;
    if (ECHO.test(content)) a.echoes++;
  };
  const posts = db
    .query(
      `SELECT m.channel_id, m.sender_name, m.content, m.cause, c2.channel_id AS cause_channel
         FROM channel_messages m
         LEFT JOIN channel_messages c2 ON m.cause = 'channel_msg:' || c2.id
        WHERE m.created_at >= ?`,
    )
    .all(since) as {
    channel_id: string;
    sender_name: string;
    content: string;
    cause: string | null;
    cause_channel: string | null;
  }[];
  for (const p of posts)
    tally(
      p.sender_name,
      p.content,
      p.cause,
      !!p.cause?.startsWith("channel_msg:") && p.cause_channel !== p.channel_id,
    );
  const tells = db
    .query(
      `SELECT d.sender_name, d.target_name, d.content, d.cause, c.sender_name AS cause_sender
         FROM direct_messages d
         LEFT JOIN direct_messages c ON d.cause = 'tell:' || c.id
        WHERE d.created_at >= ?`,
    )
    .all(since) as {
    sender_name: string;
    target_name: string;
    content: string;
    cause: string | null;
    cause_sender: string | null;
  }[];
  for (const t of tells)
    tally(
      t.sender_name,
      t.content,
      t.cause,
      !!t.cause?.startsWith("tell:") &&
        (t.cause_sender ?? "").toLowerCase() !== t.target_name.toLowerCase(),
    );

  const summary = Object.fromEntries(
    (Object.keys(out) as PeerRenderMode[]).map((k) => {
      const a = out[k];
      return [
        k,
        {
          agents: a.agents.size,
          owed: a.owed,
          lost: a.expired + a.evicted,
          lostPer100Owed: a.owed ? (100 * (a.expired + a.evicted)) / a.owed : null,
          sent: a.sent,
          threaded: a.sent ? a.caused / a.sent : null,
          wrongThread: a.caused ? a.wrongThread / a.caused : null,
          threadedByHand: a.sent ? a.byHand / a.sent : null,
          formatEchoes: a.sent ? a.echoes / a.sent : null,
        },
      ];
    }),
  );
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ db: dbPath, since: new Date(since).toISOString(), arms: summary }, null, 2),
    );
    return;
  }
  console.log(`Peer-message arms in ${dbPath} since ${new Date(since).toISOString()}`);
  const row = (label: string, f: (a: Arm) => string) =>
    console.log(
      `  ${label.padEnd(26)} ${f(out.flat).padStart(10)} ${f(out.structured).padStart(12)} ${f(out.ids).padStart(10)}`,
    );
  console.log(
    `  ${"".padEnd(26)} ${"flat".padStart(10)} ${"structured".padStart(12)} ${"ids".padStart(10)}`,
  );
  row("agents", (a) => String(a.agents.size));
  row("replies owed", (a) => String(a.owed));
  row(
    "lost (expired+evicted)",
    (a) => `${a.expired + a.evicted} (${pct(a.expired + a.evicted, a.owed)})`,
  );
  row("posts and tells sent", (a) => String(a.sent));
  row("threaded (cause)", (a) => pct(a.caused, a.sent));
  row("wrong thread", (a) => pct(a.wrongThread, a.caused));
  row("threaded by hand (re …)", (a) => pct(a.byHand, a.sent));
  row("format echoed", (a) => pct(a.echoes, a.sent));
}

if (args.includes("--corpus")) corpus();
else arms();
