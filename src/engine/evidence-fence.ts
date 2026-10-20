// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The as-of fence: an evidence cutoff that binds a resident's WHOLE turn, so a
 * forecast measured against a known outcome (a backtest, an `eval_mode`
 * filing) can use residents with their tools without anything published after
 * the cutoff reaching them.
 *
 * Where the cutoff comes from:
 * - a `model_request` that carries one (`RouteOptions.evidenceCutoff`, the
 *   `asof` field of the envelope, `x-marina-asof` over HTTP) fences the
 *   resident it is routed to for as long as the request is open
 *   (`fenceEntity`);
 * - a fenced execution that delivers a perception to another entity relays
 *   the fence to it (`relayEvidenceFence`, called from the one delivery site),
 *   so a consultant, a crewmate or a delegated worker is fenced too;
 * - in-process code (the forecast pipeline, `ResidentPart`) runs under
 *   `withEvidenceCutoff`.
 *
 * Every command execution reads the tightest applicable cutoff once, at entry
 * (`commandFenceFor`), and carries it on its `runCommandScope` frame
 * (`src/engine/gate-context.ts`); nested executions inherit it and never loosen
 * it. While a cutoff is set the command phase consults
 * {@link EVIDENCE_FENCE_POLICY}:
 * - `allow`   — nothing outside the world is read (talking, arithmetic, writes
 *               to one's own memory, the answer itself);
 * - `fenced`  — the handler honours `currentEvidenceCutoff()` itself (`web`
 *               on date-strict providers, `data` with `asOf`, `recall` /
 *               `context` / `lessons` filtered by when an item became known,
 *               `triage` at the cutoff);
 * - `refuse`  — everything else, including any command or room command this
 *               table does not name (fail closed), with a message that says why.
 *
 * Off by default in the sense that nothing sets a cutoff unless a forecast
 * asks for one: with no cutoff anywhere every path is unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { scopeEntity, scopeEvidenceFence } from "./gate-context";

// ─── Cutoff values ───────────────────────────────────────────────────────────

/** An epoch-ms cutoff from an ISO string, a date or a number; undefined when unusable. */
export function parseEvidenceCutoff(value: string | number | Date | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
          ? Date.parse(`${value.trim()}T00:00:00.000Z`)
          : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const tighter = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

// ─── In-process frames ───────────────────────────────────────────────────────

const frames = new AsyncLocalStorage<{ cutoff: number }>();

/**
 * Run `fn` with an evidence cutoff for in-process work (a forecast pipeline,
 * the residents it dispatches to). Nested frames only ever tighten it. An
 * unusable cutoff runs `fn` unchanged.
 */
export function withEvidenceCutoff<T>(cutoff: string | number | Date | undefined, fn: () => T): T {
  const ms = parseEvidenceCutoff(cutoff);
  if (ms === undefined) return fn();
  const outer = frames.getStore()?.cutoff;
  return frames.run({ cutoff: tighter(outer, ms)! }, fn);
}

/** The cutoff in force for code running now (command frame or in-process frame), epoch ms. */
export function currentEvidenceCutoffMs(): number | undefined {
  return tighter(scopeEvidenceFence()?.cutoff, frames.getStore()?.cutoff);
}

/**
 * The evidence cutoff in force for the code running now, as an ISO instant,
 * or undefined when nothing is fenced. Tools and commands that read anything
 * dated call this and bound their reads by it (or refuse).
 */
export function currentEvidenceCutoff(): string | undefined {
  const ms = currentEvidenceCutoffMs();
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

// ─── Fenced entities ─────────────────────────────────────────────────────────

/** How long a relayed fence lasts when its source has no end of its own. */
export const RELAY_FENCE_TTL_MS = 15 * 60_000;
/** At most this many fences per entity (oldest dropped first — the tightest stays). */
const MAX_FENCES_PER_ENTITY = 64;

interface EntityFence {
  cutoff: number;
  until: number;
}

const entityFences = new Map<string, Map<string, EntityFence>>();

/**
 * Fence an entity's commands at `cutoff` until `until` (or until the returned
 * release is called). Several fences on one entity combine to the tightest.
 */
export function fenceEntity(
  entityId: string,
  key: string,
  cutoff: number,
  until: number,
): () => void {
  let fences = entityFences.get(entityId);
  if (!fences) {
    fences = new Map();
    entityFences.set(entityId, fences);
  }
  const prior = fences.get(key);
  fences.set(key, {
    cutoff: tighter(prior?.cutoff, cutoff)!,
    until: Math.max(prior?.until ?? 0, until),
  });
  while (fences.size > MAX_FENCES_PER_ENTITY) {
    // Drop the loosest (latest cutoff), never the tightest.
    let loosest: string | undefined;
    let at = Number.NEGATIVE_INFINITY;
    for (const [k, f] of fences) if (f.cutoff > at) [loosest, at] = [k, f.cutoff];
    if (loosest === undefined) break;
    fences.delete(loosest);
  }
  return () => {
    const current = entityFences.get(entityId);
    if (!current) return;
    current.delete(key);
    if (current.size === 0) entityFences.delete(entityId);
  };
}

/** The tightest live fence on an entity (expired ones are pruned). */
export function entityEvidenceFence(
  entityId: string,
  now = Date.now(),
): { cutoff: number; until: number } | undefined {
  const fences = entityFences.get(entityId);
  if (!fences) return undefined;
  let out: EntityFence | undefined;
  for (const [key, f] of fences) {
    if (f.until <= now) {
      fences.delete(key);
      continue;
    }
    out = out
      ? { cutoff: Math.min(out.cutoff, f.cutoff), until: Math.max(out.until, f.until) }
      : { ...f };
  }
  if (fences.size === 0) entityFences.delete(entityId);
  return out;
}

/**
 * The fence a new command execution of `entityId` runs under: the tightest of
 * the entity's own fences, the enclosing execution's and the in-process frame.
 */
export function commandFenceFor(
  entityId: string,
  now = Date.now(),
): { cutoff: number; until?: number } | undefined {
  const own = entityEvidenceFence(entityId, now);
  const scope = scopeEvidenceFence();
  const frame = frames.getStore()?.cutoff;
  const cutoff = tighter(tighter(own?.cutoff, scope?.cutoff), frame);
  if (cutoff === undefined) return undefined;
  const until = Math.max(own?.until ?? 0, scope?.until ?? 0) || undefined;
  return { cutoff, ...(until ? { until } : {}) };
}

/**
 * Called where a perception is delivered: when a fenced execution delivers
 * to ANOTHER entity, that entity is fenced at the same cutoff for as long as
 * the source's fence lasts, so whatever it does for the sender cannot fetch
 * later evidence either.
 */
export function relayEvidenceFence(
  target: string,
  /** Which recipients are fenced (the engine: agents only — a person keeps their tools). */
  relayTo?: (entityId: string) => boolean,
  now = Date.now(),
): void {
  const fence = scopeEvidenceFence();
  if (!fence) return;
  const source = scopeEntity();
  if (!source || source === target) return;
  if (relayTo && !relayTo(target)) return;
  fenceEntity(
    target,
    `relay:${source}:${fence.cutoff}`,
    fence.cutoff,
    fence.until && fence.until > now ? fence.until : now + RELAY_FENCE_TTL_MS,
  );
}

/** Test seam. */
export function resetEvidenceFenceForTests(): void {
  entityFences.clear();
}

// ─── The command surface under a fence ───────────────────────────────────────

export type FenceMode = "allow" | "fenced" | "refuse";
type FenceRule = FenceMode | ((tokens: readonly string[]) => FenceMode);

const sub = (tokens: readonly string[]) => tokens[0]?.toLowerCase() ?? "";

/** `memory api` operations that only write the caller's own memory or read its own state. */
export const FENCED_MEMORY_API_OPERATIONS: ReadonlySet<string> = new Set([
  "capture",
  "capture_batch",
  "checkpoint",
  "save_checkpoint",
  "remember",
  "revise",
  "json_store",
  "acknowledge",
  "me",
  "spaces",
  "space",
  "create_space",
  "capabilities",
  "usage",
  "cache_put",
  "cache_delete",
]);

function memoryApiOperation(tokens: readonly string[]): string | undefined {
  const raw = tokens.slice(1).join(" ").trim();
  try {
    const op = (JSON.parse(raw) as { operation?: unknown } | null)?.operation;
    return typeof op === "string" ? op : undefined;
  } catch {
    return undefined;
  }
}

const NOTE_READS = new Set([
  "contradictions",
  "explain",
  "graph",
  "list",
  "ls",
  "room",
  "search",
  "trace",
  "types",
  "show",
  "conflicts",
]);
const MEMORY_WRITES = new Set([
  "ack",
  "claim",
  "feedback",
  "finish",
  "relate",
  "remember",
  "set",
  "start",
]);
const TASK_ALLOWED = new Set(["submit", "progress", "heartbeat", "claim", "create", "goal"]);
const CHANNEL_ALLOWED = new Set(["send", "join", "leave", "list", "ls", "listall", "create"]);

/**
 * Every built-in command's behaviour while an evidence cutoff is set. A
 * command missing here — including a new one, and every room command — is
 * refused (`test/evidence-fence.test.ts` holds the table against the
 * registry). Add a command as `allow` only when nothing it returns comes from
 * outside the world or from the world's accumulated knowledge.
 */
export const EVIDENCE_FENCE_POLICY: Readonly<Record<string, FenceRule>> = {
  // ── Talk, movement, arithmetic, one's own state: nothing dated is read ──
  look: "allow",
  move: "allow",
  ls: "allow",
  goto: "allow",
  say: "allow",
  shout: "allow",
  tell: "allow",
  re: "allow",
  emote: "allow",
  who: "allow",
  help: "allow",
  inventory: "allow",
  calc: "allow",
  quant: "allow",
  arbiter: "allow",
  time: "allow",
  uptime: "allow",
  ignore: "allow",
  score: "allow",
  map: "allow",
  get: "allow",
  drop: "allow",
  give: "allow",
  rank: "allow",
  quest: "allow",
  desire: "allow",
  standing: "allow",
  gate: "allow",
  challenge: "allow",
  macro: "allow",
  batch: "allow",
  quit: "allow",
  "system-prompt": "allow",
  // ── Bounded by the cutoff inside the handler ──
  web: (t) => (["search", "fetch", "read", "multisearch"].includes(sub(t)) ? "fenced" : "refuse"),
  data: (t) =>
    ["markets", "odds", "series"].includes(sub(t))
      ? "fenced"
      : ["", "help", "sources"].includes(sub(t))
        ? "allow"
        : "refuse",
  recall: "fenced",
  context: "fenced",
  lessons: (t) => (["retire", "supersede"].includes(sub(t)) ? "refuse" : "fenced"),
  triage: "fenced",
  // ── Writes allowed, reads of accumulated knowledge refused ──
  note: (t) => (NOTE_READS.has(sub(t)) ? "refuse" : "allow"),
  memory: (t) => {
    const s = sub(t);
    if (s === "api") {
      const op = memoryApiOperation(t);
      return op && FENCED_MEMORY_API_OPERATIONS.has(op) ? "allow" : "refuse";
    }
    if (s === "kv")
      return ["set", "delete", "clear"].includes(t[1]?.toLowerCase() ?? "") ? "allow" : "refuse";
    return MEMORY_WRITES.has(s) ? "allow" : "refuse";
  },
  task: (t) => (TASK_ALLOWED.has(sub(t)) ? "allow" : "refuse"),
  channel: (t) => (CHANNEL_ALLOWED.has(sub(t)) ? "allow" : "refuse"),
  conduct: (t) =>
    ["resolve", "json", "list", "show", "validate"].includes(sub(t)) ? "allow" : "refuse",
  decision: (t) => (["check", "choose"].includes(sub(t)) ? "allow" : "refuse"),
  skill: (t) => (sub(t) === "builtin" ? "allow" : "refuse"),
  // ── Refused: outbound, or a read of the world's knowledge that has no as-of ──
  forecast: "refuse",
  image: "refuse",
  video: "refuse",
  audio: "refuse",
  brief: "refuse",
  link: "refuse",
  feed: "refuse",
  association: "refuse",
  reproduce: "refuse",
  genome: "refuse",
  "marina-descend": "refuse",
  world: "refuse",
  mesh: "refuse",
  economy: "refuse",
  lab: "refuse",
  mutation: "refuse",
  chronicle: "refuse",
  probe: "refuse",
  watch: "refuse",
  schedule: "refuse",
  search: "refuse",
  bookmark: "refuse",
  reflect: "refuse",
  pool: "refuse",
  guide: "refuse",
  outcome: "refuse",
  learned: "refuse",
  novelty: "refuse",
  market: "refuse",
  scenario: "refuse",
  bankroll: "refuse",
  position: "refuse",
  benchmark: "refuse",
  next: "refuse",
  work: "refuse",
  ask: "refuse",
  recap: "refuse",
  debrief: "refuse",
  evolve: "refuse",
  share: "refuse",
  dig: "refuse",
  orient: "refuse",
  project: "refuse",
  export: "refuse",
  experiment: "refuse",
  observe: "refuse",
  trace: "refuse",
  intellect: "refuse",
  provenance: "refuse",
  inquiry: "refuse",
  journey: "refuse",
  inheritance: "refuse",
  crew: "refuse",
  recruit: "refuse",
  witness: "refuse",
  board: "refuse",
  group: "refuse",
  arena: "refuse",
  build: "refuse",
  connect: "refuse",
  gateway: "refuse",
  source: "refuse",
  asset: "refuse",
  canvas: "refuse",
  run: "refuse",
  shell: "refuse",
  code: "refuse",
  admin: "refuse",
  agent: "refuse",
  competence: "refuse",
  readiness: "refuse",
  productivity: "refuse",
  ops: "refuse",
  demo: "refuse",
  usecase: "refuse",
  research: "refuse",
  debate: "refuse",
  solve: "refuse",
  explore: "refuse",
  plan: "refuse",
  monitor: "refuse",
  role: "refuse",
  trait: "refuse",
  key: "refuse",
  adapter: "refuse",
};

/** Why a few commands are refused, beyond "no as-of support". */
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  forecast: "a forecast cannot start another forecast inside its own fence",
  web: "only `web search`, `web fetch` and `web multisearch` are bounded by the cutoff",
  memory: "only writes to your own memory run; read with `recall` (bounded by the cutoff)",
  note: "only note writes run; read with `recall` (bounded by the cutoff)",
};

/**
 * What a command may do while a cutoff is set. `builtin` is false for a room
 * command (it shadows nothing here and is refused).
 */
export function fenceDecision(
  name: string | undefined,
  tokens: readonly string[],
  builtin = true,
): FenceMode {
  if (!name || !builtin) return "refuse";
  const rule = Object.hasOwn(EVIDENCE_FENCE_POLICY, name) ? EVIDENCE_FENCE_POLICY[name] : undefined;
  if (rule === undefined) return "refuse";
  return typeof rule === "function" ? rule(tokens) : rule;
}

/** The message a refused command returns under a fence. */
export function fenceRefusal(name: string | undefined, cutoffMs: number): string {
  const at = new Date(cutoffMs).toISOString();
  const why =
    (name && REFUSAL_REASONS[name]) ??
    "it has no as-of support, so it could return evidence from after the cutoff";
  return `Refused under the evidence cutoff (${at}): \`${name ?? "this command"}\` — ${why}. Work from what was known by ${at.slice(0, 10)} (web search/fetch, data, recall and lessons are bounded by it).`;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Request header carrying the as-of fence to a `marina:<crew>` endpoint (ISO time). */
export const ASOF_HEADER = "x-marina-asof";
/** Response header naming the resident whose reply answered a routed request. */
export const RESPONDENT_HEADER = "x-marina-respondent";
