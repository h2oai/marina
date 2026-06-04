import { create } from "zustand";
import type { DashboardEvent, WorldSnapshot } from "../lib/types";

interface WorldState {
  // Real-time data (from WebSocket)
  instanceName: string;
  worldName: string;
  startRoom: string;
  entities: WorldSnapshot["entities"];
  rooms: WorldSnapshot["rooms"];
  roomPopulations: Record<string, number>;
  connections: number;
  memory: { heapUsed: number; rss: number };
  /**
   * Raw engine events as they arrive over the WebSocket — every
   * `DashboardEvent` pushes in here (including `feed_event` summaries).
   * Ephemeral, capped at 200, WS-only (no historical bootstrap).
   *
   * This is the reactor view: "what just happened." Pair with
   * `useFeedState.events` (curated 30-minute persistent timeline with
   * DB-stable IDs) — they serve different purposes and should not be
   * merged. See `dashboard-redesign-plan.md` for the reasoning.
   */
  eventFeed: DashboardEvent[];
  connectedSince: number;
  gridPositions: Record<string, { row: number; col: number }> | null;

  /**
   * Per-agent presence: maps agent name → epoch ms when the current
   * turn started. Cleared on turn_end. Used by EntityRoster and any
   * other surface that wants to render "mid-thought" state. This is
   * exactly what the streaming events were emitted for — the data
   * already flows through the WS; we just keep a live projection.
   */
  thinkingAgents: Record<string, number>;
  /**
   * Rank tracking: agent name → latest observed rank. Updated on
   * rank_change events so components can show growth arrows.
   */
  agentRanks: Record<string, { rank: number; lastChange: number }>;

  // UI selection state (used by old dashboard components)
  selectedRoom: string | null;
  selectedEntity: string | null;

  // Actions
  setSnapshot: (data: WorldSnapshot) => void;
  pushEvent: (event: DashboardEvent) => void;
  pushEvents: (events: DashboardEvent[]) => void;
  selectRoom: (roomId: string | null) => void;
  selectEntity: (name: string | null) => void;
}

/**
 * Project the new event types into presence state. Keeps the reducer
 * small — any future per-agent presence signal (streaming text buffer,
 * idle indicator, etc.) extends this one function.
 */
function applyPresence(
  state: Pick<WorldState, "thinkingAgents" | "agentRanks">,
  event: DashboardEvent,
): Pick<WorldState, "thinkingAgents" | "agentRanks"> | null {
  if (event.type === "agent_turn_start" && event.name) {
    if (state.thinkingAgents[event.name] === event.timestamp) return null;
    return {
      ...state,
      thinkingAgents: { ...state.thinkingAgents, [event.name]: event.timestamp },
    };
  }
  if (event.type === "agent_turn_end" && event.name) {
    if (!(event.name in state.thinkingAgents)) return null;
    const next = { ...state.thinkingAgents };
    delete next[event.name];
    return { ...state, thinkingAgents: next };
  }
  if (event.type === "rank_change" && event.name && event.newRank != null) {
    return {
      ...state,
      agentRanks: {
        ...state.agentRanks,
        [event.name]: { rank: event.newRank, lastChange: event.timestamp },
      },
    };
  }
  return null;
}

export const useWorldState = create<WorldState>((set) => ({
  instanceName: "",
  worldName: "",
  startRoom: "",
  entities: [],
  rooms: [],
  roomPopulations: {},
  connections: 0,
  memory: { heapUsed: 0, rss: 0 },
  eventFeed: [],
  connectedSince: 0,
  gridPositions: null,

  thinkingAgents: {},
  agentRanks: {},

  selectedRoom: null,
  selectedEntity: null,

  setSnapshot: (data) =>
    set((state) => ({
      instanceName: data.instanceName ?? state.instanceName,
      worldName: data.worldName ?? state.worldName,
      startRoom: data.startRoom ?? state.startRoom,
      entities: data.entities,
      rooms: data.rooms ?? [],
      roomPopulations: data.roomPopulations,
      connections: data.connections,
      memory: data.memory,
      gridPositions: data.gridPositions ?? state.gridPositions,
      connectedSince: state.connectedSince || Date.now(),
    })),

  pushEvent: (event) =>
    set((state) => {
      const nextFeed = [event, ...state.eventFeed].slice(0, 200);
      const presence = applyPresence(state, event);
      return presence ? { ...presence, eventFeed: nextFeed } : { eventFeed: nextFeed };
    }),

  pushEvents: (events) =>
    set((state) => {
      let thinking = state.thinkingAgents;
      let ranks = state.agentRanks;
      for (const e of events) {
        const presence = applyPresence({ thinkingAgents: thinking, agentRanks: ranks }, e);
        if (presence) {
          thinking = presence.thinkingAgents;
          ranks = presence.agentRanks;
        }
      }
      return {
        eventFeed: [...events, ...state.eventFeed].slice(0, 200),
        thinkingAgents: thinking,
        agentRanks: ranks,
      };
    }),

  selectRoom: (roomId) => set({ selectedRoom: roomId }),
  selectEntity: (name) => set({ selectedEntity: name }),
}));
