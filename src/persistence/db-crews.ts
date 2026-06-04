import type { Database } from "bun:sqlite";

// ─── Crew Persistence ────────────────────────────────────────────────────────
//
// Only persisted crews touch the DB. Ephemeral crews live solely in
// CrewManager's in-memory map. Member changes write through immediately so
// restart reattachment is consistent.

export interface CrewRow {
  id: string;
  name: string;
  goal: string;
  formation: string;
  owner_id: string;
  channel_id: string | null;
  pool_id: string | null;
  state: string;
  result_summary: string | null;
  created_at: number;
  last_activity_at: number;
}

export interface CrewMemberRow {
  crew_id: string;
  agent_name: string;
  role: string;
  joined_at: number;
}

export function saveCrew(
  db: Database,
  crew: {
    id: string;
    name: string;
    goal: string;
    formation: string;
    ownerId: string;
    channelId?: string | null;
    poolId?: string | null;
    state: string;
    resultSummary?: string | null;
    createdAt: number;
    lastActivityAt: number;
  },
): void {
  db.run(
    `INSERT INTO crews
       (id, name, goal, formation, owner_id, channel_id, pool_id, state,
        result_summary, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       goal = excluded.goal,
       formation = excluded.formation,
       owner_id = excluded.owner_id,
       channel_id = excluded.channel_id,
       pool_id = excluded.pool_id,
       state = excluded.state,
       result_summary = excluded.result_summary,
       last_activity_at = excluded.last_activity_at`,
    [
      crew.id,
      crew.name,
      crew.goal,
      crew.formation,
      crew.ownerId,
      crew.channelId ?? null,
      crew.poolId ?? null,
      crew.state,
      crew.resultSummary ?? null,
      crew.createdAt,
      crew.lastActivityAt,
    ],
  );
}

export function getCrew(db: Database, id: string): CrewRow | undefined {
  return (db.query("SELECT * FROM crews WHERE id = ?").get(id) as CrewRow | null) ?? undefined;
}

export function getCrewByName(db: Database, name: string): CrewRow | undefined {
  return (db.query("SELECT * FROM crews WHERE name = ?").get(name) as CrewRow | null) ?? undefined;
}

export function getAllCrews(db: Database): CrewRow[] {
  return db
    .query("SELECT * FROM crews WHERE state != 'dissolved' ORDER BY created_at ASC")
    .all() as CrewRow[];
}

export function deleteCrew(db: Database, id: string): void {
  // crew_members CASCADEs via FK
  db.run("DELETE FROM crews WHERE id = ?", [id]);
}

export function addCrewMember(
  db: Database,
  crewId: string,
  agentName: string,
  role: string,
  joinedAt: number,
): void {
  db.run(
    `INSERT INTO crew_members (crew_id, agent_name, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(crew_id, agent_name) DO UPDATE SET role = excluded.role`,
    [crewId, agentName, role, joinedAt],
  );
}

export function removeCrewMember(db: Database, crewId: string, agentName: string): void {
  db.run("DELETE FROM crew_members WHERE crew_id = ? AND agent_name = ?", [crewId, agentName]);
}

export function getCrewMembers(db: Database, crewId: string): CrewMemberRow[] {
  return db
    .query("SELECT * FROM crew_members WHERE crew_id = ? ORDER BY joined_at ASC")
    .all(crewId) as CrewMemberRow[];
}
