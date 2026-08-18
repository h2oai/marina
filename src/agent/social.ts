// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Perception } from "../types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SocialEvent {
  type: SocialEventType;
  speaker?: string;
  message?: string;
  target?: string;
  channel?: string;
  timestamp: number;
}

export type SocialEventType =
  | "player_joined"
  | "player_left"
  | "player_says"
  | "player_tells"
  | "player_emote"
  | "player_shout"
  | "player_entered_room"
  | "player_left_room"
  | "channel_message"
  | "broadcast_message"
  | "group_invite"
  | "trade_request";

// ─── Social Awareness ───────────────────────────────────────────────────────

export class SocialAwareness {
  private socialEvents: SocialEvent[] = [];
  private entitiesInRoom: Set<string> = new Set();
  private recentSpeakers: Map<string, number> = new Map();
  /** Interaction count per entity — drives relationship-aware social behavior. */
  private relationships: Map<string, number> = new Map();

  handlePerception(p: Perception): SocialEvent[] {
    const events: SocialEvent[] = [];
    const timestamp = Date.now();

    switch (p.kind) {
      case "message": {
        const data = p.data as {
          from?: string;
          senderName?: string;
          to?: string;
          message?: string;
          content?: string;
          type?: string;
          channel?: string;
        };
        const speaker = data.from ?? data.senderName;
        const message = data.message ?? data.content;

        if (data.channel) {
          events.push({
            type: "channel_message",
            speaker,
            message,
            channel: data.channel,
            timestamp,
          });
        } else if (data.to) {
          events.push({
            type: "player_tells",
            speaker,
            message,
            target: data.to,
            timestamp,
          });
        } else {
          events.push({
            type: "player_says",
            speaker,
            message,
            timestamp,
          });
        }

        if (speaker) {
          this.recentSpeakers.set(speaker, timestamp);
          this.trackInteraction(speaker);
        }
        break;
      }

      case "broadcast": {
        const data = p.data as { from?: string; message?: string };

        events.push({
          type: "broadcast_message",
          speaker: data.from,
          message: data.message,
          timestamp,
        });

        if (data.from) {
          this.recentSpeakers.set(data.from, timestamp);
          this.trackInteraction(data.from);
        }
        break;
      }

      case "movement": {
        const data = p.data as {
          entity?: string;
          entityName?: string;
          direction?: string;
          type?: string;
        };

        const entityName = data.entityName || data.entity || "Someone";

        if (data.type === "arrive" || data.direction === "arrive") {
          events.push({ type: "player_entered_room", speaker: entityName, timestamp });
          this.entitiesInRoom.add(entityName);
        } else if (data.type === "depart" || data.direction) {
          events.push({
            type: "player_left_room",
            speaker: entityName,
            message: data.direction,
            timestamp,
          });
          this.entitiesInRoom.delete(entityName);
        }
        break;
      }

      case "system": {
        const data = p.data as {
          type?: string;
          entity?: string;
          entityName?: string;
        };

        if (data.type === "login" || data.type === "connect") {
          events.push({
            type: "player_joined",
            speaker: data.entityName || data.entity,
            timestamp,
          });
        } else if (data.type === "logout" || data.type === "disconnect") {
          events.push({
            type: "player_left",
            speaker: data.entityName || data.entity,
            timestamp,
          });
        }
        break;
      }
    }

    this.socialEvents.push(...events);
    if (this.socialEvents.length > 100) {
      this.socialEvents = this.socialEvents.slice(-100);
    }

    return events;
  }

  updateEntitiesInRoom(entities: Array<{ name: string }>): void {
    this.entitiesInRoom.clear();
    for (const entity of entities) {
      if (entity.name) this.entitiesInRoom.add(entity.name);
    }
  }

  getEntitiesInRoom(): string[] {
    return Array.from(this.entitiesInRoom);
  }

  shouldRespond(event: SocialEvent, myName: string): boolean {
    // Always respond to direct messages or name mentions
    if (event.type === "player_tells") return true;
    if (event.message?.toLowerCase().includes(myName.toLowerCase())) return true;

    // Relationship-aware response: more likely to respond to known collaborators
    const interactions = event.speaker ? (this.relationships.get(event.speaker) ?? 0) : 0;
    const familiarity = Math.min(interactions / 10, 1); // 0-1, saturates at 10 interactions

    if (event.message?.includes("?") && event.type === "player_says") {
      return Math.random() < 0.3 + familiarity * 0.5; // 30-80% based on familiarity
    }
    if (event.message?.match(/\b(hello|hi|hey)\b/i)) {
      return Math.random() < 0.5 + familiarity * 0.4; // 50-90% based on familiarity
    }
    // Respond to familiar entities even for general statements (low base rate)
    if (familiarity > 0.5 && event.type === "player_says") {
      return Math.random() < 0.2;
    }
    return false;
  }

  scorePerception(event: SocialEvent, myName: string): number {
    const lowerName = myName.toLowerCase();

    if (event.type === "player_tells" && event.target?.toLowerCase() === lowerName) return 100;
    // model_request / model_response JSON on the orchestration channels are
    // external API calls — they MUST clear the perception-buffer burst trim,
    // which only keeps events with priority >= 80. Without this the Answerer
    // drops benchmark questions alongside chat noise when its queue fills up
    // during agent onboarding. Detected by content shape because the engine
    // delivers model_request as a plain channel_message without a dedicated
    // perception type.
    if (
      event.type === "channel_message" &&
      event.message &&
      (event.message.includes('"type":"model_request"') ||
        event.message.includes('"type":"model_response"'))
    ) {
      return 95;
    }
    if (event.message?.toLowerCase().includes(lowerName)) return 80;

    switch (event.type) {
      case "player_says":
      case "player_shout":
      case "player_emote":
        return 50;
      case "channel_message":
        return 40;
      case "player_entered_room":
      case "player_left_room":
        return 30;
      case "broadcast_message":
        return 20;
      case "player_joined":
      case "player_left":
        return 10;
      default:
        return 15;
    }
  }

  getRecentEvents(limit = 10): SocialEvent[] {
    return this.socialEvents.slice(-limit);
  }

  getActiveSpeakers(): string[] {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const active: string[] = [];
    for (const [speaker, timestamp] of this.recentSpeakers.entries()) {
      if (timestamp > fiveMinutesAgo) active.push(speaker);
    }
    return active;
  }

  getSocialContext(): string {
    const lines: string[] = [];

    if (this.entitiesInRoom.size > 0) {
      lines.push(`Entities in room: ${Array.from(this.entitiesInRoom).join(", ")}`);
    }

    const activeSpeakers = this.getActiveSpeakers();
    if (activeSpeakers.length > 0) {
      lines.push(`Recently active: ${activeSpeakers.join(", ")}`);
    }

    const recentEvents = this.getRecentEvents(5);
    if (recentEvents.length > 0) {
      lines.push("\nRecent social events:");
      for (const event of recentEvents) {
        if (event.channel) {
          lines.push(`  - [${event.channel}] ${event.speaker}: ${event.message || event.type}`);
        } else {
          lines.push(`  - ${event.speaker}: ${event.message || event.type}`);
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") : "No recent social activity";
  }

  /** Get entities the agent has interacted with most, sorted by interaction count. */
  getKnownEntities(limit = 5): Array<{ name: string; interactions: number }> {
    return [...this.relationships.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, interactions]) => ({ name, interactions }));
  }

  /** Get interaction count for a specific entity. */
  getInteractionCount(entityName: string): number {
    return this.relationships.get(entityName) ?? 0;
  }

  private trackInteraction(entityName: string): void {
    this.relationships.set(entityName, (this.relationships.get(entityName) ?? 0) + 1);
  }

  reset(): void {
    this.socialEvents = [];
    this.entitiesInRoom.clear();
    this.recentSpeakers.clear();
    this.relationships.clear();
  }
}
