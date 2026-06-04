// Watch specs — declarative descriptions of "what to observe and how often",
// stored as notes by convention in the shared `watches` pool. The watcher
// agent recalls these on its tick, runs `probe` for ones that are due, and
// closes the loop on the spec's notify target. No new tables — the spec is
// just a structured note with FTS5-indexable header.
//
// Storage shape (note content):
//
//   [watch:<kind> <id>]
//
//   cadence: every 1h
//   retirement: until-resolved
//   notify: bettor
//   args: {"venue":"kalshi","ticker":"KXFED-26MAR"}
//   created_by: alice
//   created_at: 2026-05-07T18:00:00.000Z
//
// Retirement is handled by writing a separate `watch-retired` note whose
// supersedes_id points back at this spec. `listActiveWatches` filters those
// out.

import type { MarinaDB } from "../persistence/database";
import { type Cadence, parseCadence, renderCadence } from "./cadence";

export const WATCHES_POOL = "watches";
export const WATCH_NOTE_TYPE = "watch";
export const WATCH_RETIRED_NOTE_TYPE = "watch-retired";

// ─── Retirement rule ────────────────────────────────────────────────────────

export type RetirementRule =
  | { kind: "resolved" } // retire when sample status matches resolver.closesOn
  | { kind: "forever" } // never retire
  | { kind: "samples"; n: number } // retire after N samples
  | { kind: "duration"; ms: number }; // retire after total elapsed

export type RetirementParseResult =
  | { ok: true; rule: RetirementRule }
  | { ok: false; error: string };

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseRetirement(raw: string | undefined): RetirementParseResult {
  if (!raw?.trim()) return { ok: true, rule: { kind: "resolved" } }; // sensible default
  const trimmed = raw.trim().toLowerCase();
  if (/[-_]/.test(trimmed)) {
    return {
      ok: false,
      error:
        "retirement must not contain hyphens or underscores (try retirement:resolved, retirement:forever, retirement:5, retirement:7d)",
    };
  }
  if (trimmed === "resolved") return { ok: true, rule: { kind: "resolved" } };
  if (trimmed === "forever") return { ok: true, rule: { kind: "forever" } };
  // Pure-number → samples count
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n <= 0) return { ok: false, error: "retirement count must be positive" };
    return { ok: true, rule: { kind: "samples", n } };
  }
  // Duration form (matches cadence syntax)
  const m = trimmed.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    const unitMs = DURATION_UNITS[m[2]!];
    if (!unitMs || n <= 0) return { ok: false, error: `unknown retirement duration: ${raw}` };
    return { ok: true, rule: { kind: "duration", ms: n * unitMs } };
  }
  return {
    ok: false,
    error: `unrecognized retirement "${raw}" — try resolved, forever, 5, or 7d`,
  };
}

export function renderRetirement(rule: RetirementRule): string {
  switch (rule.kind) {
    case "resolved":
      return "until-resolved";
    case "forever":
      return "forever";
    case "samples":
      return `after ${rule.n} samples`;
    case "duration":
      return renderDuration(rule.ms);
  }
}

function renderDuration(ms: number): string {
  for (const [unit, unitMs] of [
    ["w", DURATION_UNITS.w!],
    ["d", DURATION_UNITS.d!],
    ["h", DURATION_UNITS.h!],
    ["m", DURATION_UNITS.m!],
  ] as const) {
    if (ms % unitMs === 0 && ms >= unitMs) {
      return `after ${ms / unitMs}${unit}`;
    }
  }
  return `after ${Math.round(ms / 1000)}s`;
}

// ─── Spec data shape ────────────────────────────────────────────────────────

export interface WatchSpec {
  /** Resolver kind to invoke (e.g. "resolving"). */
  kind: string;
  /** Resolver-defined canonical id (idFromArgs output). */
  id: string;
  /** Args passed to the resolver's parseArgs / resolve. */
  args: Record<string, string>;
  cadence: Cadence;
  retirement: RetirementRule;
  /** Closure target — resolved at retirement time. Entity name; if no entity
   *  matches, channel name; if neither, no notification. */
  notify?: string;
  createdBy: string;
  createdAt: number;
}

export interface ActiveWatch {
  /** Spec note id — used as the user-facing `watch retire <id>` argument. */
  noteId: number;
  spec: WatchSpec;
}

// ─── Serialization ──────────────────────────────────────────────────────────

export function renderSpec(spec: WatchSpec): string {
  const tag = `[watch:${spec.kind} ${spec.id}]`;
  const lines = [
    tag,
    "",
    `cadence: ${renderCadence(spec.cadence)}`,
    `retirement: ${renderRetirement(spec.retirement)}`,
  ];
  if (spec.notify) lines.push(`notify: ${spec.notify}`);
  lines.push(`args: ${JSON.stringify(spec.args)}`);
  lines.push(`created_by: ${spec.createdBy}`);
  lines.push(`created_at: ${new Date(spec.createdAt).toISOString()}`);
  return lines.join("\n");
}

export function parseSpec(content: string): WatchSpec | undefined {
  const lines = content.split("\n");
  const tagMatch = lines[0]?.match(/^\[watch:(\S+)\s+(\S+)\]$/);
  if (!tagMatch) return undefined;
  const [, kind, id] = tagMatch;
  if (!kind || !id) return undefined;

  const fields = readFields(lines);

  const cadence = parseCadenceField(fields.cadence);
  if (!cadence) return undefined;

  const retirement = parseRetirementField(fields.retirement);
  if (!retirement) return undefined;

  let args: Record<string, string> = {};
  if (fields.args) {
    try {
      const parsed = JSON.parse(fields.args) as unknown;
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, string>;
      }
    } catch {
      return undefined;
    }
  }

  const createdAt = fields.created_at ? Date.parse(fields.created_at) : Date.now();
  if (Number.isNaN(createdAt)) return undefined;

  return {
    kind,
    id,
    args,
    cadence,
    retirement,
    notify: fields.notify,
    createdBy: fields.created_by ?? "system",
    createdAt,
  };
}

function readFields(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Parse the spec's cadence storage form ("every 1h" / "once") back into Cadence. */
function parseCadenceField(raw: string | undefined): Cadence | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "once") return { kind: "once" };
  // "every <N><unit>" — extract the duration token
  const m = trimmed.match(/^every\s+(\d+[smhdw])$/);
  const token = m?.[1] ?? trimmed;
  const result = parseCadence(token);
  return result.ok ? result.cadence : undefined;
}

function parseRetirementField(raw: string | undefined): RetirementRule | undefined {
  if (!raw) return { kind: "resolved" };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "until-resolved" || trimmed === "resolved") return { kind: "resolved" };
  if (trimmed === "forever") return { kind: "forever" };
  const samplesMatch = trimmed.match(/^after\s+(\d+)\s+samples?$/);
  if (samplesMatch) {
    const n = Number.parseInt(samplesMatch[1]!, 10);
    return n > 0 ? { kind: "samples", n } : undefined;
  }
  const durationMatch = trimmed.match(/^after\s+(\d+)([smhdw])$/);
  if (durationMatch) {
    const n = Number.parseInt(durationMatch[1]!, 10);
    const unitMs = DURATION_UNITS[durationMatch[2]!];
    return unitMs && n > 0 ? { kind: "duration", ms: n * unitMs } : undefined;
  }
  return undefined;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

/** Ensure the shared `watches` pool exists. Idempotent. Returns the pool id. */
export function ensureWatchesPool(db: MarinaDB): string {
  const existing = db.getMemoryPool(WATCHES_POOL);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.createMemoryPool(id, WATCHES_POOL, "system");
  return id;
}

/** Write a new active watch spec note to the watches pool. Returns the
 *  note id, which is the user-facing watch identifier. */
export function createWatchNote(db: MarinaDB, spec: WatchSpec, authorName: string): number {
  const poolId = ensureWatchesPool(db);
  return db.createNote(authorName, renderSpec(spec), undefined, {
    importance: 7,
    noteType: WATCH_NOTE_TYPE,
    poolId,
    skipDedup: true, // each watch is a distinct intent, even if specs match
  });
}

/** Write a retirement record that supersedes the active spec note. The
 *  retirement note carries the reason in its content for audit; queries
 *  filter active specs by checking for any successor with the retired
 *  note_type that supersedes them. */
export function retireWatchNote(
  db: MarinaDB,
  specNoteId: number,
  authorName: string,
  reason?: string,
): number {
  const poolId = ensureWatchesPool(db);
  const spec = db.getNote(specNoteId);
  const tag = spec ? extractTag(spec.content) : `watch:#${specNoteId}`;
  const body = reason ? `[${tag}] retired — ${reason}` : `[${tag}] retired`;
  return db.createNote(authorName, body, undefined, {
    importance: 5,
    noteType: WATCH_RETIRED_NOTE_TYPE,
    poolId,
    supersedesId: specNoteId,
    skipDedup: true,
  });
}

function extractTag(content: string): string {
  const m = content.match(/^\[(watch:[^\]]+)\]/);
  return m?.[1] ?? "watch:?";
}

/** List all active (non-retired) watch specs in the pool. Reads everything
 *  in the pool, filters in JS — the pool is bounded by retirement so this
 *  scales fine for the expected workload (tens to hundreds of active
 *  watches). */
export function listActiveWatches(db: MarinaDB): ActiveWatch[] {
  const poolId = ensureWatchesPool(db);
  const all = db.getPoolNotes(poolId, 1000);
  // Build set of superseded ids (those that have been retired).
  const retiredIds = new Set<number>();
  for (const note of all) {
    if (note.note_type === WATCH_RETIRED_NOTE_TYPE && note.supersedes_id) {
      retiredIds.add(note.supersedes_id);
    }
  }
  const active: ActiveWatch[] = [];
  for (const note of all) {
    if (note.note_type !== WATCH_NOTE_TYPE) continue;
    if (retiredIds.has(note.id)) continue;
    const spec = parseSpec(note.content);
    if (!spec) continue;
    active.push({ noteId: note.id, spec });
  }
  return active;
}

/** Find an active watch by note id. Returns undefined if it doesn't exist
 *  or has been retired. */
export function getActiveWatch(db: MarinaDB, noteId: number): ActiveWatch | undefined {
  return listActiveWatches(db).find((w) => w.noteId === noteId);
}
