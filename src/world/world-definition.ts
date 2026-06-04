import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { Entity, RoomId, RoomModule } from "../types";

export interface QuestStep {
  id: string;
  description: string;
  hint: string;
  check: (entity: Entity) => boolean;
}

export interface QuestDef {
  id: string;
  name: string;
  description: string;
  reward: string;
  steps: QuestStep[];
  onComplete?: (entity: Entity, db?: MarinaDB) => void;
}

export interface GuideNote {
  content: string;
  importance: number;
  type: string;
}

export interface WorldDefinition {
  name: string;
  startRoom: RoomId;
  rooms: Record<string, RoomModule>;
  roomsDir?: string;
  /** Grid positions for dashboard layout. Maps room ID → {row, col}. */
  gridPositions?: Record<string, { row: number; col: number }>;
  quests: QuestDef[];
  autoQuest?: string;
  guideNotes: GuideNote[];
  canvas?: { name: string; description: string; scope?: string };
  // Runs once on first boot (or world change), seeds DB with
  // room templates, projects, pools, tasks, etc. Must be idempotent.
  seed?: (db: MarinaDB) => void;
  // Runs after Engine.initAgents() has materialized seeded agents. Use this
  // to wire runtime-only constructs (crews, scheduled tasks) that depend on
  // live agents. Must be idempotent — engine boots can call it any number
  // of times.
  afterAgentsReady?: (engine: Engine) => void | Promise<void>;
  // Commands to auto-execute on first login for new entities.
  autoBootstrap?: string[];
}
