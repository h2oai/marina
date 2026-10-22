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
  /** When each part was last read successfully. */
  at: Partial<Record<Part, number>>;
  /** Parts this session may not read (the server answered 401/403). */
  denied?: Partial<Record<Part, true>>;
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
  | "challenges";

const EVERY: Record<Part, number> = {
  health: 5_000,
  system: 5_000,
  world: 5_000,
  profile: 10_000,
  ops: 15_000,
  alerts: 15_000,
  readiness: 60_000,
  challenges: 10_000,
};

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

  /** Read every part that is due (or all of them when `force`). */
  async refresh(force: boolean, only?: Part[]): Promise<void> {
    const now = Date.now();
    const due = (Object.keys(EVERY) as Part[]).filter(
      (part) =>
        (!only || only.includes(part)) &&
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
