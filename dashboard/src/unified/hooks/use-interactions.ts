/**
 * Zustand store for temporary interaction arcs between entities.
 *
 * Interaction arcs visualize real-time activity — communication, movement,
 * commands, coordination — as animated edges on the unified canvas.
 * Each arc lives for a type-dependent duration before being automatically expired.
 *
 * Every event type gets its own color so the canvas reads as a living world:
 * - Cyan: say (local speech)
 * - Violet: tell (directed private message)
 * - Yellow: shout (broadcast to all rooms)
 * - Fuchsia: emote (roleplay/expression)
 * - Amber: move (entity changing rooms)
 * - Green: task (task claim/complete/coordinate)
 * - Blue: broadcast (system announcement)
 * - Lime: command (action execution)
 * - Rose: connect/disconnect (presence)
 */

import { create } from "zustand";

/** Maximum number of concurrent interaction arcs. */
const MAX_INTERACTIONS = 40;

/** Type of interaction determines arc color, width, and lifetime. */
export type InteractionType =
  | "say"
  | "tell"
  | "shout"
  | "emote"
  | "broadcast"
  | "move"
  | "task"
  | "command"
  | "connect"
  | "disconnect";

/** A single interaction arc between two entities or rooms. */
export interface Interaction {
  /** Unique ID for this interaction. */
  id: string;
  /** Source entity name. */
  from: string;
  /** Target entity name (same as from for move/command arcs). */
  to: string;
  /** For room-based arcs: the source room ID. */
  fromRoom?: string;
  /** For room-based arcs: the destination room ID. */
  toRoom?: string;
  /** Interaction type (determines color and style). */
  type: InteractionType;
  /** Timestamp when the interaction was created. */
  createdAt: number;
  /**
   * The actual spoken content for say/tell/shout/emote/broadcast arcs.
   * Rendered as a message bubble at the arc's midpoint — content over
   * motion. Undefined for presence, movement, or command arcs.
   */
  body?: string;
  /** For `tell`: recipient name shown on the bubble. */
  recipient?: string;
}

/** Optional payload when creating an interaction — message body, recipient, etc. */
export interface InteractionOptions {
  body?: string;
  recipient?: string;
}

/** Color mapping for interaction types — each visually distinct. */
export const INTERACTION_COLORS: Record<InteractionType, string> = {
  say: "#06b6d4", // cyan — local speech
  tell: "#8b5cf6", // violet — directed message
  shout: "#eab308", // yellow — broadcast speech
  emote: "#ec4899", // fuchsia/pink — expression
  broadcast: "#3b82f6", // blue — system announcement
  move: "#f59e0b", // amber — room transition
  task: "#22c55e", // green — task activity
  command: "#84cc16", // lime — action execution
  connect: "#f43f5e", // rose — presence enter
  disconnect: "#6b7280", // gray — presence leave
};

/** Lifetime in ms per interaction type — high-impact arcs last longer. */
export const INTERACTION_LIFETIMES: Record<InteractionType, number> = {
  say: 5000,
  tell: 7000, // private messages are important, show longer
  shout: 8000, // shouts are rare and loud
  emote: 4000, // emotes are ephemeral
  broadcast: 8000, // broadcasts are important
  move: 4000, // movement is transient
  task: 6000, // task coordination matters
  command: 3000, // commands are fast
  connect: 5000, // presence changes are notable
  disconnect: 5000,
};

/** Stroke width per interaction type — louder = thicker. */
export const INTERACTION_WIDTHS: Record<InteractionType, number> = {
  say: 3,
  tell: 4,
  shout: 6,
  emote: 3,
  broadcast: 5,
  move: 4,
  task: 3,
  command: 2,
  connect: 3,
  disconnect: 2,
};

interface InteractionState {
  /** Active interaction arcs. */
  interactions: Interaction[];

  /**
   * Add a new interaction arc.
   *
   * @param from - Source entity name.
   * @param to - Target entity name.
   * @param type - Interaction type.
   * @param fromRoom - Source room ID (for move/room-based arcs).
   * @param toRoom - Destination room ID (for move/room-based arcs).
   * @param options - Optional message body / recipient for content-bearing arcs.
   */
  addInteraction: (
    from: string,
    to: string,
    type: InteractionType,
    fromRoom?: string,
    toRoom?: string,
    options?: InteractionOptions,
  ) => void;

  /**
   * Get all non-expired interactions.
   */
  getActiveInteractions: () => Interaction[];

  /**
   * Remove expired interactions from the store.
   */
  trimExpired: () => void;
}

let nextId = 0;

/** Zustand store for managing temporary interaction arcs. */
export const useInteractions = create<InteractionState>((set, get) => ({
  interactions: [],

  addInteraction: (
    from: string,
    to: string,
    type: InteractionType,
    fromRoom?: string,
    toRoom?: string,
    options?: InteractionOptions,
  ) => {
    const interaction: Interaction = {
      id: `arc-${++nextId}`,
      from,
      to,
      type,
      fromRoom,
      toRoom,
      createdAt: Date.now(),
      body: options?.body,
      recipient: options?.recipient,
    };

    set((state) => {
      const next = [...state.interactions, interaction];
      while (next.length > MAX_INTERACTIONS) {
        next.shift();
      }
      return { interactions: next };
    });
  },

  getActiveInteractions: (): Interaction[] => {
    const now = Date.now();
    return get().interactions.filter((i) => {
      const lifetime = INTERACTION_LIFETIMES[i.type] ?? 5000;
      return now - i.createdAt < lifetime;
    });
  },

  trimExpired: () => {
    const now = Date.now();
    set((state) => ({
      interactions: state.interactions.filter((i) => {
        const lifetime = INTERACTION_LIFETIMES[i.type] ?? 5000;
        return now - i.createdAt < lifetime;
      }),
    }));
  },
}));
