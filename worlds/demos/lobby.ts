// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId, RoomContext, RoomId, RoomModule } from "../../src/types";

// ─── ANSI ──────────────────────────────────────────────────────────────────

const B = "\x1b[1m";
const M = "\x1b[35m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const R = "\x1b[0m";

// ─── Guide NPC Dialogue ────────────────────────────────────────────────────

const DIALOGUE = {
  greeting:
    "Welcome to the Marina Demos. I can explain what you are about to see. " +
    "(Topics: workshop, bridge, what_is_marina, for_children, for_ceos)",
  topics: {
    workshop:
      "The Workshop demonstrates self-bootstrapping. " +
      "You will watch an AI agent spawn inside this world, build a brand new room " +
      "from scratch — writing its own code — and then you walk into the room it created. " +
      "The system grows itself. Type 'workshop' to go there.",
    bridge:
      "The Bridge demonstrates federation. You will connect two separate Marina " +
      "instances and watch messages flow between them. This is how Marina scales — " +
      "not by making one bigger, but by connecting many together. Type 'bridge' to go there.",
    what_is_marina:
      "Marina is a shared space where humans and AI agents coexist as equals. " +
      "Everyone uses the same commands. Agents have memory, goals, and the ability " +
      "to build new parts of the world. It is a living system that grows from within.",
    for_children:
      "Imagine a magical world where a computer friend can build a new room " +
      "just by thinking about it — and then you can walk right in! " +
      "In the Workshop, you will watch this happen. In the Bridge, you will see " +
      "two worlds talk to each other, like walkie-talkies between castles.",
    for_ceos:
      "Two demonstrations prove Marina's core value propositions. " +
      "The Workshop proves the system is self-extending — agents create new capabilities " +
      "without developer intervention. The Bridge proves horizontal scaling — " +
      "federate instances rather than scaling a monolith. " +
      "Both run on existing primitives with zero engine modifications.",
  },
};

// ─── Room Module ───────────────────────────────────────────────────────────

const room: RoomModule = {
  short: "Demo Lobby",
  long:
    `A gleaming atrium with polished floors that reflect shifting data patterns overhead. ` +
    `Two corridors branch from here — one marked ${B}${C}Workshop${R} to the east, ` +
    `another marked ${B}${C}Bridge${R} to the west. ` +
    `A holographic guide stands at the center, ready to explain.`,

  exits: {
    east: "demos/workshop" as RoomId,
    west: "demos/bridge" as RoomId,
    workshop: "demos/workshop" as RoomId,
    bridge: "demos/bridge" as RoomId,
  },

  items: {
    sign:
      `A directory sign reads:\n` +
      `  ${B}East${R}  — ${C}The Workshop${R} ${D}(self-bootstrapping demo)${R}\n` +
      `  ${B}West${R}  — ${C}The Bridge${R}   ${D}(federation demo)${R}`,
  },

  onEnter(ctx: RoomContext, entity: EntityId) {
    // Idempotent guide spawn
    const guideExists = ctx.entities.some((e) => e.name === "Curator");
    if (!guideExists) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "Curator",
          role: "guide",
          goal: "You are the Curator in the Demo Lobby. Orient visitors to Marina demos. Know about: workshop (self-bootstrapping where agents build rooms), bridge (federation connecting multiple worlds). Explain at any level — technical developers, executives, or newcomers. Stay in this room.",
        });
      } else {
        ctx.spawn({
          name: "Curator",
          short: "A holographic curator floats here, composed of shimmering light.",
          long: "A translucent figure whose surface ripples with flowing diagrams — architecture schematics, network topologies, and cascading timelines. It speaks with calm authority.",
          properties: {
            role: "guide",
            dialogue: DIALOGUE,
          },
        });
      }
    }

    const ent = ctx.getEntity(entity);
    if (!ent || ent.kind !== "agent") return;

    ctx.send(
      entity,
      `${B}${M}The Curator turns to you:${R} "Welcome to the demos. ` +
        `Two corridors await — ${C}workshop${R} to the east, ${C}bridge${R} to the west. ` +
        `Type 'talk Curator' to learn what each one proves, or just pick a direction."`,
    );
  },

  onTick(ctx: RoomContext) {
    // Deduplicate Curator entities
    const curators = ctx.entities.filter((e) => e.name === "Curator");
    if (curators.length > 1) {
      for (const extra of curators.slice(1)) ctx.despawn(extra.id);
    }
    if (curators.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "Curator",
        short: "A holographic curator floats here, composed of shimmering light.",
        long: "A translucent figure whose surface ripples with flowing diagrams.",
        properties: { role: "guide", dialogue: DIALOGUE },
      });
    }
  },
};

export default room;
