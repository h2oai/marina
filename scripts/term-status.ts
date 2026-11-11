// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live world state for the CLI's prompt, status bar and slash panels, read
 * from the same REST endpoints the dashboard uses, with the session's own
 * bearer token (so every number is what this participant may see). Polling is
 * paced well under the dashboard limiter (60 requests / 10 s per principal)
 * and every failure leaves the last value in place: a segment goes blank, the
 * REPL never stops.
 */

export interface WorldSnapshot {
  health?: {
    status: string;
    uptimeMs: number;
    connections: number;
    agents: number;
    tickAgoMs: number;
    tickErrors: number;
  };
  system?: {
    rooms: number;
    entities: { total: number; agents: number; npcs: number };
    tasks: { open: number; claimed: number; submitted: number; completed: number };
    projects: number;
    connectors: number;
  };
  world?: {
    name: string;
    rooms: { id: string; short: string; entityCount: number }[];
    entities: { name: string; room: string; kind: string; rank: number }[];
  };
  profile?: {
    rank: number;
    standing: number;
    kind: string;
    achievements: number;
    actions: number;
    gates: number;
  };
  ops?: {
    scope: string;
    agents: {
      name: string;
      state: string;
      health: string | null;
      role: string;
      model: string;
      uptimeMs: number;
      toolCalls: number;
      tokens: { input: number; output: number };
      cost: { totalUsd: number; lastHourUsd: number };
      consecutiveErrors: number;
      paused: { kind: string; reason: string } | null;
    }[];
    spend: {
      todayUsd: number;
      capUsd: number | null;
      lastHourUsd: number;
      scopes: { scope: string; spentUsd: number }[];
    };
  };
  alerts?: {
    severity: string;
    title: string;
    detail: string;
    remedy: string | null;
    attention: string | null;
    occurrences: number;
  }[];
  readiness?: {
    profile: string;
    checks: { label: string; status: string; detail: string; remediation?: string }[];
  };
  /** Held actions: waiting on your answer, and the ones you asked for. */
  challenges?: { answerable: HeldAction[]; raised: HeldAction[] };
  /** Participant sessions you own or share a group with (dashboard Streams). */
  streams?: { total: number; items: StreamRow[] };
  /** The shared task board, newest first. */
  tasks?: { total: number; items: TaskSummary[] };
  /** The dream pass in your scope: ids and counts, never note text. */
  dreams?: { mode: string; guarded: string[]; items: DreamSummary[] };
  /** Memory health in your scope (counts from the memory overview). */
  memory?: MemoryHealth;
  /** Recent execution traces (operator read). */
  traces?: TraceSummary[];
  /** The public activity feed, newest first. */
  feed?: FeedItem[];
  /** When each part was last read successfully. */
  at: Partial<Record<Part, number>>;
  /** Parts this session may not read (the server answered 401/403). */
  denied?: Partial<Record<Part, true>>;
}

export interface StreamRow {
  label: string;
  kind: string;
  owned: boolean;
  /** Runtime status (`running`, `waiting`, `failed` …), or `left`/`active` with no runtime. */
  status: string;
  adapter: string;
  model: string;
  /** The session is asking you something (an open runtime request). */
  asking: boolean;
  error: string;
  deliveryError: boolean;
  lastSeenAt: number;
}

export interface TaskSummary {
  id: number;
  title: string;
  status: string;
  creator: string;
  priority: number;
  claimed: number;
  submitted: number;
}

export interface DreamSummary {
  id: number;
  entity: string;
  pool: boolean;
  state: string;
  createdAt: number;
  applied: number;
  rejected: number;
  pending: number;
}

/** A ratio's numerator over its denominator (`value` null when nothing to measure). */
export interface Count {
  n: number;
  of: number;
}

export interface MemoryHealth {
  scope: string;
  unresolved: Count;
  stale: Count;
  duplicates: Count;
  provenance: Count;
  openJobs: number;
  resolutions: number;
}

export interface TraceSummary {
  /** The id `trace show` takes. */
  id: string;
  status: string;
  startedAt: number;
  durationMs: number | null;
  spans: number;
  model: string;
  /** Names of the evaluation checks that failed. */
  failedChecks: string[];
}

export interface FeedItem {
  kind: string;
  entity: string;
  summary: string;
  at: number;
}

export interface HeldAction {
  token: string;
  kind: string;
  requester: string;
  summary: string;
  reason: string;
  expiresAt: number;
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON read from REST; every field is coerced below.
type Json = Record<string, any>;

export type Part =
  | "health"
  | "system"
  | "world"
  | "profile"
  | "ops"
  | "alerts"
  | "readiness"
  | "challenges"
  | "streams"
  | "tasks"
  | "dreams"
  | "memory"
  | "traces"
  | "feed";

const EVERY: Record<Part, number> = {
  health: 5_000,
  system: 5_000,
  world: 5_000,
  profile: 10_000,
  ops: 15_000,
  alerts: 15_000,
  readiness: 60_000,
  challenges: 10_000,
  streams: 5_000,
  tasks: 10_000,
  dreams: 30_000,
  memory: 30_000,
  traces: 15_000,
  feed: 10_000,
};

/** Read only while something on screen wants them (a mode's board, a `/live` card). */
const ON_DEMAND = new Set<Part>(["streams", "tasks", "dreams", "memory", "traces", "feed"]);

/** A part the server refused is asked again only this often (access can change). */
const DENIED_EVERY = 300_000;

/** ws://host:port → http://host:port (wss → https). */
export function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class WorldStatus {
  snapshot: WorldSnapshot = { at: {} };
  private timer?: ReturnType<typeof setInterval>;
  private inflight = new Set<Part>();
  private listeners: (() => void)[] = [];
  private wanted = new Set<Part>();

  constructor(
    private base: string,
    private token: () => string | undefined,
    private self: string,
    private fetcher: Fetch = fetch,
  ) {}

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(false), 2_500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The on-demand parts to keep polling (replaces the previous set). */
  want(parts: readonly Part[]): void {
    this.wanted = new Set(parts.filter((part) => ON_DEMAND.has(part)));
  }

  /** Read every part that is due (or all of them when `force`). */
  async refresh(force: boolean, only?: Part[]): Promise<void> {
    const now = Date.now();
    const due = (Object.keys(EVERY) as Part[]).filter(
      (part) =>
        (only ? only.includes(part) : !ON_DEMAND.has(part) || this.wanted.has(part)) &&
        !this.inflight.has(part) &&
        (force ||
          now - (this.snapshot.at[part] ?? 0) >=
            (this.snapshot.denied?.[part] ? DENIED_EVERY : EVERY[part])),
    );
    if (!due.length) return;
    const results = await Promise.all(due.map((part) => this.read(part)));
    if (results.some(Boolean)) for (const listener of this.listeners) listener();
  }

  private async get(path: string): Promise<unknown> {
    const token = this.token();
    const response = await this.fetcher(`${this.base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new HttpStatusError(response.status);
    return response.json();
  }

  private async read(part: Part): Promise<boolean> {
    this.inflight.add(part);
    try {
      const s = this.snapshot;
      switch (part) {
        case "health": {
          const h = (await this.get("/health")) as Json;
          s.health = {
            status: String(h.status ?? "unknown"),
            uptimeMs: Number(h.uptime ?? 0),
            connections: Number(h.connections ?? 0),
            agents: Number(h.agents ?? 0),
            tickAgoMs: Number(h.tick?.agoMs ?? 0),
            tickErrors: Number(h.tick?.errors ?? 0),
          };
          break;
        }
        case "system": {
          const y = (await this.get("/api/system")) as Json;
          s.system = {
            rooms: Number(y.rooms ?? 0),
            entities: { total: 0, agents: 0, npcs: 0, ...y.entities },
            tasks: { open: 0, claimed: 0, submitted: 0, completed: 0, ...y.tasks },
            projects: Number(y.projectCount ?? 0),
            connectors: Number(y.connectorCount ?? 0),
          };
          break;
        }
        case "world": {
          const w = (await this.get("/api/world")) as Json;
          s.world = {
            name: String(w.worldName ?? ""),
            rooms: Array.isArray(w.rooms) ? w.rooms : [],
            entities: Array.isArray(w.entities) ? w.entities : [],
          };
          break;
        }
        case "profile": {
          const p = (await this.get(
            `/api/entity/${encodeURIComponent(this.self)}/profile`,
          )) as Json;
          s.profile = {
            rank: Number(p.identity?.rank ?? 0),
            standing: Number(p.identity?.standing ?? 0),
            kind: String(p.identity?.kind ?? ""),
            achievements: Array.isArray(p.achievements) ? p.achievements.length : 0,
            actions: Number(p.stats?.total_actions ?? 0),
            gates: Number(p.stats?.competence_gates_passed ?? 0),
          };
          break;
        }
        case "ops": {
          const o = (await this.get("/api/ops/overview")) as Json;
          s.ops = {
            scope: String(o.scope ?? ""),
            agents: Array.isArray(o.agents) ? o.agents : [],
            spend: {
              todayUsd: Number(o.spend?.daily?.spentUsd ?? 0),
              capUsd: o.spend?.daily?.capUsd ?? null,
              lastHourUsd: Number(o.spend?.lastHourUsd ?? 0),
              scopes: Array.isArray(o.spend?.daily?.scopes) ? o.spend.daily.scopes : [],
            },
          };
          break;
        }
        case "alerts": {
          const a = (await this.get("/api/operations/alerts")) as Json[];
          s.alerts = (Array.isArray(a) ? a : [])
            .filter((row) => row.status === "open")
            .map((row) => ({
              severity: String(row.severity ?? "info"),
              title: String(row.title ?? ""),
              detail: String(row.detail ?? ""),
              remedy: row.remedy ? String(row.remedy) : null,
              attention: row.attention_kind ? String(row.attention_kind) : null,
              occurrences: Number(row.occurrences ?? 1),
            }));
          break;
        }
        case "challenges": {
          const c = (await this.get("/api/challenges/mine")) as Json;
          const held = (rows: unknown): HeldAction[] =>
            (Array.isArray(rows) ? rows : []).map((row: Json) => ({
              token: String(row.token ?? ""),
              kind: String(row.kind ?? ""),
              requester: String(row.requester ?? ""),
              summary: String(row.summary ?? ""),
              reason: String(row.reason ?? ""),
              expiresAt: Number(row.expiresAt ?? 0),
            }));
          s.challenges = { answerable: held(c.answerable), raised: held(c.raised) };
          break;
        }
        case "streams": {
          const o = (await this.get("/api/routing/overview?limit=50")) as Json;
          const items = (Array.isArray(o.items) ? o.items : []).map((row: Json): StreamRow => {
            const runtime = (row.runtime ?? {}) as Json;
            const session = (row.session ?? {}) as Json;
            return {
              label: String(session.label ?? session.id ?? ""),
              kind: String(session.kind ?? ""),
              owned: row.owned === true,
              status: String(runtime.status ?? session.state ?? "active"),
              adapter: String(runtime.adapter ?? ""),
              model: String(runtime.model ?? ""),
              asking: !!runtime.request && typeof runtime.request === "object",
              error: String(runtime.error ?? ""),
              deliveryError: row.lastDelivery?.kind === "delivery.error",
              lastSeenAt: Number(session.lastSeenAt ?? 0),
            };
          });
          s.streams = { total: Number(o.total ?? items.length), items };
          break;
        }
        case "tasks": {
          const t = (await this.get("/api/coordination/tasks?paged=1&limit=20")) as Json;
          const items = (Array.isArray(t.items) ? t.items : []).map(
            (row: Json): TaskSummary => ({
              id: Number(row.id ?? 0),
              title: String(row.title ?? ""),
              status: String(row.status ?? ""),
              creator: String(row.creator_name ?? ""),
              priority: Number(row.priority ?? 0),
              claimed: Number(row.claimed ?? 0),
              submitted: Number(row.submitted ?? 0),
            }),
          );
          s.tasks = { total: Number(t.total ?? items.length), items };
          break;
        }
        case "dreams": {
          const d = (await this.get("/api/memory/dreams?limit=10")) as Json;
          s.dreams = {
            mode: String(d.mode ?? ""),
            guarded: Array.isArray(d.guarded) ? d.guarded.map(String) : [],
            items: (Array.isArray(d.dreams) ? d.dreams : []).map(
              (row: Json): DreamSummary => ({
                id: Number(row.id ?? 0),
                entity: String(row.entity ?? ""),
                pool: row.pool === true,
                state: String(row.state ?? ""),
                createdAt: Number(row.createdAt ?? 0),
                applied: Number(row.ops?.applied ?? 0),
                rejected: Number(row.ops?.rejected ?? 0),
                pending: Number(row.ops?.pendingProposals ?? 0),
              }),
            ),
          };
          break;
        }
        case "memory": {
          const m = (await this.get("/api/memory/overview")) as Json;
          const count = (ratio: Json | undefined): Count => ({
            n: Number(ratio?.numerator ?? 0),
            of: Number(ratio?.denominator ?? 0),
          });
          s.memory = {
            scope: String(m.ratios?.scope ?? ""),
            unresolved: count(m.ratios?.unresolvedContradictionRate),
            stale: count(m.ratios?.stalenessRatio),
            duplicates: count(m.ratios?.redundancy),
            provenance: count(m.ratios?.provenanceCoverage),
            openJobs: Number(m.jobs?.open ?? 0),
            resolutions: Array.isArray(m.resolutions) ? m.resolutions.length : 0,
          };
          break;
        }
        case "traces": {
          const t = (await this.get("/api/traces?limit=12")) as Json;
          s.traces = (Array.isArray(t.traces) ? t.traces : []).map((row: Json): TraceSummary => {
            const spans: Json[] = Array.isArray(row.spans) ? row.spans : [];
            const model = spans
              .map((span) => span.attributes?.model)
              .find((value) => typeof value === "string");
            const checks: Json[] = Array.isArray(row.evaluation?.checks)
              ? row.evaluation.checks
              : [];
            return {
              id: String(row.traceId ?? ""),
              status: String(row.status ?? ""),
              startedAt: Number(row.startedAt ?? 0),
              durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
              spans: spans.length,
              model: typeof model === "string" ? model : "",
              failedChecks: checks
                .filter((check) => check.result === "failed")
                .map((check) => String(check.id ?? "")),
            };
          });
          break;
        }
        case "feed": {
          const f = (await this.get("/api/feed?limit=15")) as Json[];
          s.feed = (Array.isArray(f) ? f : []).map(
            (row: Json): FeedItem => ({
              kind: String(row.kind ?? ""),
              entity: String(row.entity ?? ""),
              summary: String(row.summary ?? ""),
              at: Number(row.timestamp ?? 0),
            }),
          );
          break;
        }
        case "readiness": {
          const r = (await this.get("/api/readiness")) as Json;
          s.readiness = {
            profile: String(r.trustProfile?.profile ?? ""),
            checks: Array.isArray(r.checks) ? r.checks : [],
          };
          break;
        }
      }
      s.at[part] = Date.now();
      if (s.denied?.[part]) delete s.denied[part];
      return true;
    } catch (err) {
      if (err instanceof HttpStatusError && (err.status === 401 || err.status === 403)) {
        const first = !this.snapshot.denied?.[part];
        this.snapshot.denied = { ...this.snapshot.denied, [part]: true };
        // Back off, and drop what an earlier session could see.
        this.snapshot.at[part] = Date.now();
        if (part === "alerts") this.snapshot.alerts = undefined;
        if (part === "streams") this.snapshot.streams = undefined;
        if (part === "tasks") this.snapshot.tasks = undefined;
        if (part === "dreams") this.snapshot.dreams = undefined;
        if (part === "memory") this.snapshot.memory = undefined;
        if (part === "traces") this.snapshot.traces = undefined;
        if (part === "feed") this.snapshot.feed = undefined;
        return first;
      }
      return false;
    } finally {
      this.inflight.delete(part);
    }
  }

  /** The room this participant is in, by its short name. */
  room(): string | undefined {
    const w = this.snapshot.world;
    const me = w?.entities.find((e) => e.name === this.self);
    return me ? (w!.rooms.find((r) => r.id === me.room)?.short ?? me.room) : undefined;
  }

  roomPopulation(): number | undefined {
    const w = this.snapshot.world;
    const me = w?.entities.find((e) => e.name === this.self);
    return me ? w!.rooms.find((r) => r.id === me.room)?.entityCount : undefined;
  }
}
