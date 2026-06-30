/**
 * Entity profile API — the public per-entity view of a Marina's history.
 *
 * Projects existing per-event data (chronicle, standing ledger, entity_activity,
 * entity_competence) onto a per-actor axis. Read-only, no auth, generous rate
 * limit. This is the chronicle's public face — the "wiki" of each entity.
 *
 *   GET /api/entity/:name/profile
 *
 * See docs/chronicle.md for the design rationale.
 *
 * Privacy: deliberately excludes connection_id, IP addresses, session tokens,
 * private notes (non-pool), raw command input, and core_memory keys other
 * than `bio` (operator-curated). What IS exposed: name, kind, role, rank,
 * standing, agent_configs.goal (operators have agreed prompt structure is
 * acceptable to expose for prompt improvement), chronicle entries (already
 * public via the WS feed), activity counts, competence demos.
 */

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { ChronicleEntry, ChronicleKind } from "../persistence/db-chronicle";
import type { Entity, EntityId } from "../types";

/** Standing thresholds the rank ladder uses (mirrors src/agent/rank-progression.ts). */
const RANK_THRESHOLDS = [5, 15, 40, 100];

/** Days-active milestone bands. */
const DAYS_ACTIVE_MILESTONES = [1, 7, 30, 100];

/** Total chronicle-citation count milestones. */
const CITATION_MILESTONES = [1, 5, 25, 100];

export interface EntityProfile {
  identity: {
    name: string;
    kind: string;
    role: string | null;
    rank: number;
    standing: number;
    first_seen: number | null;
    last_active: number | null;
    online: boolean;
  };
  bio: {
    goal: string | null;
    model: string | null;
    traits: string[];
    operator_bio: string | null;
  };
  narratives: ChronicleEntry[];
  achievements: Achievement[];
  stats: {
    chronicle_citations: Record<ChronicleKind, number>;
    chronicle_citations_total: number;
    rooms_visited: number;
    unique_commands: number;
    entities_interacted: number;
    total_actions: number;
    competence_gates_passed: number;
    days_active: number;
  };
  connections: { name: string; co_chronicles: number }[];
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  achieved_at: number;
  evidence_ref?: string;
}

/**
 * Dispatcher for /api/entity/* routes. Returns null if no route matches so
 * the websocket-server can fall through to other handlers.
 */
export async function handleEntityApi(
  url: URL,
  method: string,
  db: MarinaDB,
  engine: Engine,
): Promise<Response | null> {
  // Only GET is supported for this read-only public surface
  if (method !== "GET") return null;

  // /api/entity/<name>/profile
  const match = url.pathname.match(/^\/api\/entity\/([^/]+)\/profile\/?$/);
  if (match) {
    const name = decodeURIComponent(match[1]!);
    const profile = buildEntityProfile(name, db, engine);
    if (!profile) {
      return Response.json({ error: "Entity not found" }, { status: 404 });
    }
    return Response.json(profile, {
      headers: {
        // Brief cache so a refresh storm doesn't repeatedly hit SQLite, but
        // short enough that operators see updates within a minute.
        "Cache-Control": "public, max-age=30",
      },
    });
  }

  return null;
}

/**
 * Assemble the profile from existing tables. Returns null if no entity, user,
 * or agent_config row matches the name (case-insensitive). Tries entity
 * manager first (live agents), then DB (offline users/agents whose entity is
 * gone). Either is enough to build a profile.
 */
export function buildEntityProfile(
  name: string,
  db: MarinaDB,
  engine: Engine,
): EntityProfile | null {
  // Look up the live entity (if online)
  const liveEntity =
    engine.entities.findAgentByName(name) ??
    engine.entities.all().find((e) => e.name.toLowerCase() === name.toLowerCase());

  // Fall back to persisted records: user row OR agent_config row
  const userRow = db.getUserByName(name);
  const agentConfig = db.getAgentConfig(name);

  // If nothing matches, the name doesn't exist in this Marina
  if (!liveEntity && !userRow && !agentConfig) return null;

  // Canonical name = liveEntity.name > userRow.name > agentConfig.name
  const canonicalName = liveEntity?.name ?? userRow?.name ?? agentConfig?.name ?? name;

  const identity = buildIdentity(canonicalName, liveEntity, userRow, db);
  const bio = buildBio(canonicalName, liveEntity, agentConfig, db);
  const narratives = buildNarratives(canonicalName, db);
  const stats = buildStats(canonicalName, liveEntity, db);
  const achievements = buildAchievements(canonicalName, liveEntity, db, stats);
  const connections = buildConnections(canonicalName, db);

  return { identity, bio, narratives, achievements, stats, connections };
}

function buildIdentity(
  name: string,
  liveEntity: Entity | undefined,
  userRow: { rank: number; created_at: number } | undefined,
  db: MarinaDB,
): EntityProfile["identity"] {
  const kind = liveEntity?.kind ?? (db.getAgentConfig(name) ? "agent" : "user");
  const role = (liveEntity?.properties.role as string | undefined) ?? null;
  const rank = (liveEntity?.properties.rank as number | undefined) ?? userRow?.rank ?? 0;
  const standing = liveEntity ? readStandingFor(liveEntity.id, db) : 0;
  const first_seen = userRow?.created_at ?? liveEntity?.createdAt ?? null;
  const last_active = db.getLastActivityAt(name);
  return {
    name,
    kind,
    role,
    rank,
    standing,
    first_seen,
    last_active,
    online: !!liveEntity,
  };
}

function readStandingFor(entityId: EntityId, db: MarinaDB): number {
  const cache = db.getStandingCache(entityId);
  return cache?.standing ?? 0;
}

function buildBio(
  name: string,
  liveEntity: Entity | undefined,
  agentConfig: { goal: string; model: string; role: string } | undefined,
  db: MarinaDB,
): EntityProfile["bio"] {
  const roleName = (liveEntity?.properties.role as string | undefined) ?? agentConfig?.role ?? "";
  const role = roleName ? db.getRole(roleName) : undefined;
  const traits = role
    ? (() => {
        try {
          const parsed = JSON.parse(role.traits ?? "[]");
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })()
    : [];

  // Operator-curated bio key in core_memory. Optional — agents/operators can
  // set it via `memory set bio <text>`; absent for most entities. Keyed by
  // entity NAME (not id) because core_memory survives entity respawn.
  const bioRow = db.getCoreMemory(name, "bio");
  const operatorBio = bioRow?.value ?? null;

  return {
    goal: agentConfig?.goal && agentConfig.goal.length > 0 ? agentConfig.goal : null,
    model: agentConfig?.model && agentConfig.model.length > 0 ? agentConfig.model : null,
    traits,
    operator_bio: operatorBio,
  };
}

function buildNarratives(name: string, db: MarinaDB): ChronicleEntry[] {
  // Newest first. Narratives + digests only — events are templated and not
  // the "story" of the entity.
  const narratives = db.queryChronicle({ participant: name, kind: "narrative", limit: 10 });
  const digests = db.queryChronicle({ participant: name, kind: "digest", limit: 5 });
  return [...narratives, ...digests].sort((a, b) => b.created_at - a.created_at).slice(0, 10);
}

function buildStats(
  name: string,
  liveEntity: Entity | undefined,
  db: MarinaDB,
): EntityProfile["stats"] {
  // Chronicle citations by kind. Each kind query gets all entries, capped
  // generously so the count is accurate up to 200 per kind (more than
  // adequate for any realistic entity).
  const citations: Record<ChronicleKind, number> = {
    event: 0,
    narrative: 0,
    digest: 0,
    correction: 0,
  };
  for (const kind of ["event", "narrative", "digest", "correction"] as ChronicleKind[]) {
    citations[kind] = db.queryChronicle({ participant: name, kind, limit: 200 }).length;
  }
  const totalCitations =
    citations.event + citations.narrative + citations.digest + citations.correction;

  const activity = db.getActivityStats(name);
  const competence = liveEntity ? db.listCompetenceForEntity(liveEntity.id) : [];
  const gatesPassed = competence.filter((c) => !c.supervised_only).length;

  const firstSeen = db.getUserByName(name)?.created_at ?? liveEntity?.createdAt ?? null;
  const daysActive = firstSeen ? Math.max(1, Math.floor((Date.now() - firstSeen) / 86_400_000)) : 0;

  return {
    chronicle_citations: citations,
    chronicle_citations_total: totalCitations,
    rooms_visited: activity.roomsVisited,
    unique_commands: activity.uniqueCommands,
    entities_interacted: activity.entitiesInteracted,
    total_actions: activity.totalActions,
    competence_gates_passed: gatesPassed,
    days_active: daysActive,
  };
}

/**
 * Compute milestone achievements from the underlying tables. Each badge has a
 * stable id (so the same achievement always renders the same way) and an
 * evidence_ref pointing to the chronicle entry or standing event that triggered
 * it where applicable.
 */
function buildAchievements(
  name: string,
  liveEntity: Entity | undefined,
  db: MarinaDB,
  stats: EntityProfile["stats"],
): Achievement[] {
  const achievements: Achievement[] = [];

  // Rank crossings — one badge per rank reached, evidence is the chronicle
  // rank_change entry that recorded it.
  const rankChanges = db.queryChronicle({
    participant: name,
    source: "rank_change",
    limit: 100,
  });
  const seenRanks = new Set<number>();
  for (const entry of rankChanges) {
    const match = entry.refs.find((r) => r.startsWith("rank:"));
    const rank = match ? Number.parseInt(match.slice(5), 10) : Number.NaN;
    if (Number.isFinite(rank) && !seenRanks.has(rank)) {
      seenRanks.add(rank);
      achievements.push({
        id: `rank:${rank}`,
        title: `Rank ${rank}`,
        description: `Crossed the rank-${rank} standing threshold.`,
        achieved_at: entry.created_at,
        evidence_ref: `chronicle:${entry.id}`,
      });
    }
  }

  // Standing-threshold milestones from the standing ledger. We pick the
  // earliest ledger event whose cumulative amount crossed each threshold —
  // approximating by using the entity's earliest standing event as the
  // crossing point. Imperfect but cheap; in practice rank changes are the
  // real milestone (above) and these thresholds are derivatives.
  if (liveEntity) {
    const ledger = db.ledgerForEntity(liveEntity.id, 500).reverse(); // oldest first
    let running = 0;
    const seenThresholds = new Set<number>();
    for (const row of ledger) {
      running += row.amount;
      for (const threshold of RANK_THRESHOLDS) {
        if (running >= threshold && !seenThresholds.has(threshold)) {
          seenThresholds.add(threshold);
          achievements.push({
            id: `standing:${threshold}`,
            title: `${threshold} standing`,
            description: `Lifetime contribution crossed ${threshold} (raw, undecayed).`,
            achieved_at: row.earned_at,
            evidence_ref: `standing:${row.id}`,
          });
        }
      }
      if (seenThresholds.size === RANK_THRESHOLDS.length) break;
    }
  }

  // First chronicled narrative — the moment the Chronicler first interpreted
  // this entity's actions. Distinct from event entries (which fire on every
  // engine event the entity participates in).
  const firstNarrative = db
    .queryChronicle({ participant: name, kind: "narrative", limit: 200 })
    .at(-1); // oldest in the returned set (DESC by created_at, last item is earliest)
  if (firstNarrative) {
    achievements.push({
      id: "first_narrative",
      title: "First chronicled",
      description: "The Chronicler wrote a narrative entry interpreting your actions.",
      achieved_at: firstNarrative.created_at,
      evidence_ref: `chronicle:${firstNarrative.id}`,
    });
  }

  // Competence gate demos — one badge per gate the entity has graduated past
  // (supervised_only is false).
  if (liveEntity) {
    const competence = db.listCompetenceForEntity(liveEntity.id);
    for (const row of competence) {
      if (!row.supervised_only && row.last_demo_at) {
        achievements.push({
          id: `gate:${row.gate}`,
          title: `Gate: ${row.gate}`,
          description: `Demonstrated unsupervised competence at ${row.gate}.`,
          achieved_at: row.last_demo_at,
        });
      }
    }
  }

  // Days-active milestone — pick the highest band the entity has reached.
  // No evidence_ref (it's a passage-of-time achievement, not an event).
  if (stats.days_active > 0) {
    const reached = DAYS_ACTIVE_MILESTONES.filter((d) => stats.days_active >= d);
    const highest = reached[reached.length - 1];
    if (highest !== undefined) {
      achievements.push({
        id: `days_active:${highest}`,
        title: `${highest} day${highest === 1 ? "" : "s"} active`,
        description: `Has been part of this Marina for at least ${highest} day${highest === 1 ? "" : "s"}.`,
        achieved_at: Date.now() - highest * 86_400_000,
      });
    }
  }

  // Citation milestones — bands of total chronicle citations.
  if (stats.chronicle_citations_total > 0) {
    const reached = CITATION_MILESTONES.filter((n) => stats.chronicle_citations_total >= n);
    const highest = reached[reached.length - 1];
    if (highest !== undefined) {
      achievements.push({
        id: `citations:${highest}`,
        title: `${highest} citation${highest === 1 ? "" : "s"}`,
        description: `Cited in the chronicle ${highest} or more time${highest === 1 ? "" : "s"}.`,
        achieved_at: Date.now(),
      });
    }
  }

  return achievements.sort((a, b) => b.achieved_at - a.achieved_at);
}

/**
 * Top-N other entities most often cited together with `name` in the chronicle.
 * Drives the cross-entity social graph: each connection links to its own
 * /who/<name> page. Self-citations are excluded (an entity in its own
 * participants list shouldn't connect to itself).
 */
function buildConnections(name: string, db: MarinaDB): { name: string; co_chronicles: number }[] {
  const entries = db.queryChronicle({ participant: name, limit: 200 });
  const counts = new Map<string, number>();
  const lowerSelf = name.toLowerCase();
  for (const entry of entries) {
    for (const p of entry.participants) {
      if (p.toLowerCase() === lowerSelf) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([n, c]) => ({ name: n, co_chronicles: c }))
    .sort((a, b) => b.co_chronicles - a.co_chronicles)
    .slice(0, 10);
}
