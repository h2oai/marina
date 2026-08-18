// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId, RoomContext, RoomId, RoomModule } from "../../src/types";

// ─── ANSI ──────────────────────────────────────────────────────────────────

const B = "\x1b[1m";
const D = "\x1b[2m";
const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const M = "\x1b[35m";
const R = "\x1b[0m";

// ─── Types ─────────────────────────────────────────────────────────────────

type Step = "start" | "launched" | "connected" | "bridged" | "messaged";

interface BridgeState {
  step: Step;
  startedAt: number;
  peerPort: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PEER_PORT = 3400;
const PEER_NAME = "demo-peer";
const BRIDGE_CHANNEL = "demos";

// ─── Guide NPC Dialogue ────────────────────────────────────────────────────

const DIALOGUE = {
  greeting:
    "I am the Navigator. This is where the federation demo runs. " +
    "(Topics: federation, gateways, scaling, for_children, for_ceos, begin)",
  topics: {
    federation:
      "Federation means connecting separate Marina instances. Each instance is " +
      "sovereign — its own database, its own agents, its own world. When you bridge " +
      "two instances, messages flow between them. Agents discover each other " +
      "through shared channels.",
    gateways:
      "A gateway is a WebSocket connection between two Marina instances. " +
      "Once connected, you bridge channels — any message in a bridged channel " +
      "appears in both worlds. Agents can send direct messages across gateways too.",
    scaling:
      "Marina does not scale by making one instance bigger. It scales by " +
      "connecting many instances together. Each one runs on a laptop, a server, " +
      "or a container. The network grows by adding nodes, not by adding resources " +
      "to a single machine. This is how the internet works.",
    for_children:
      "Imagine two castles, each with their own people inside. " +
      "Now imagine building a bridge between them so the people can talk. " +
      "That is what you are about to do — connect two worlds so they can share messages.",
    for_ceos:
      "This demonstrates horizontal scaling through federation rather than vertical scaling. " +
      "Each Marina instance is self-contained — zero shared infrastructure. " +
      "Spin up a new instance in seconds, bridge it, and the network grows. " +
      "No distributed database. No consensus protocol. No ops complexity.",
    begin:
      "Follow these steps: launch a peer instance, connect to it, " +
      "bridge a channel, and send a message across. I will guide you at each step. " +
      "Type 'launch' to begin.",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const STEPS_ORDERED: Step[] = ["start", "launched", "connected", "bridged", "messaged"];
const STEP_LABELS: Record<Step, string> = {
  start: "Start the demo",
  launched: "Peer instance running",
  connected: "Gateway connected",
  bridged: "Channel bridged",
  messaged: "Cross-instance message sent",
};

function stepDone(state: BridgeState, step: Step): boolean {
  return STEPS_ORDERED.indexOf(state.step) >= STEPS_ORDERED.indexOf(step);
}

function statusBlock(state: BridgeState | undefined): string {
  if (!state || state.step === "start") {
    return `${D}Type 'launch' to begin the federation demo.${R}`;
  }
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  const lines = [`${B}Federation Demo${R} ${D}(${elapsed}s elapsed)${R}`];
  for (const step of STEPS_ORDERED.slice(1)) {
    const done = stepDone(state, step);
    const current = state.step === step;
    const marker = done ? `${G}done${R}` : current ? `${Y}current${R}` : `${D}pending${R}`;
    lines.push(`  ${marker}  ${STEP_LABELS[step]}`);
  }

  // Show next instruction
  if (state.step === "launched") {
    lines.push(`\n${C}Next:${R} Type '${C}connect${R}' to create a gateway to the peer.`);
  } else if (state.step === "connected") {
    lines.push(`\n${C}Next:${R} Type '${C}link${R}' to bridge the ${BRIDGE_CHANNEL} channel.`);
  } else if (state.step === "bridged") {
    lines.push(`\n${C}Next:${R} Type '${C}ping${R}' to send a cross-instance message.`);
  } else if (state.step === "messaged") {
    lines.push(`\n${G}${B}Federation demo complete!${R} Two Marina instances are talking.`);
  }
  return lines.join("\n");
}

// ─── Room Module ───────────────────────────────────────────────────────────

const room: RoomModule = {
  short: "The Bridge",
  long: (ctx: RoomContext) => {
    const state = ctx.store.get<BridgeState>("bridge");
    return (
      "A vast chamber spanning a chasm of swirling data. Two enormous pylons rise " +
      "on either side — one glowing steady, the other dark and waiting. " +
      "The Navigator hovers at the center, monitoring connection status.\n\n" +
      statusBlock(state)
    );
  },

  exits: {
    east: "demos/lobby" as RoomId,
    lobby: "demos/lobby" as RoomId,
  },

  items: {
    pylons:
      "Two crystalline pylons, each representing an Marina instance. " +
      "The left one pulses with this world's heartbeat. " +
      "The right one awaits a connection.",
    chasm:
      "The gap between the pylons represents the network — " +
      "when a gateway bridge forms, streams of light will flow between them.",
  },

  commands: {
    launch: (ctx: RoomContext, input: { entity: EntityId }) => {
      const state = ctx.store.get<BridgeState>("bridge");
      if (state && STEPS_ORDERED.indexOf(state.step) >= 1) {
        ctx.send(input.entity, "Peer instance already launched. " + statusBlock(state));
        return;
      }

      ctx.store.set<BridgeState>("bridge", {
        step: "launched",
        startedAt: Date.now(),
        peerPort: PEER_PORT,
      });

      const ent = ctx.getEntity(input.entity);
      if (ent) ent.properties.quest_entered_bridge = true;

      ctx.broadcast(
        `${B}${M}The Navigator gestures toward the dark pylon.${R}\n\n` +
          `To start a peer Marina instance, open a ${B}second terminal${R} and run:\n\n` +
          `  ${C}MARINA_WORLD=empty WS_PORT=${PEER_PORT} TELNET_PORT=0 MCP_PORT=0 \\${R}\n` +
          `  ${C}  DB_PATH=data/demo-peer.db bun run src/main.ts${R}\n\n` +
          `${D}Wait for "Server ready" then come back here and type '${C}connect${R}'.${R}`,
      );
    },

    connect: async (ctx: RoomContext, input: { entity: EntityId }) => {
      const state = ctx.store.get<BridgeState>("bridge");
      if (!state || state.step === "start") {
        ctx.send(input.entity, "Run 'launch' first to get the peer instance command.");
        return;
      }
      if (STEPS_ORDERED.indexOf(state.step) >= 2) {
        ctx.send(input.entity, "Already connected. " + statusBlock(state));
        return;
      }

      ctx.broadcast(
        `${D}Connecting to peer instance on port ${PEER_PORT}...${R}\n\n` +
          `Run this command now:\n\n` +
          `  ${C}gateway add ${PEER_NAME} ws://localhost:${PEER_PORT}/ws${R}\n\n` +
          `${D}Once connected, type '${C}link${R}' to bridge a channel.${R}`,
      );

      state.step = "connected";
      ctx.store.set("bridge", state);

      const ent = ctx.getEntity(input.entity);
      if (ent) ent.properties.quest_gateway_added = true;
    },

    link: async (ctx: RoomContext, input: { entity: EntityId }) => {
      const state = ctx.store.get<BridgeState>("bridge");
      if (!state || STEPS_ORDERED.indexOf(state.step) < 2) {
        ctx.send(input.entity, "Connect to the peer first. " + statusBlock(state));
        return;
      }
      if (STEPS_ORDERED.indexOf(state.step) >= 3) {
        ctx.send(input.entity, "Already bridged. " + statusBlock(state));
        return;
      }

      ctx.broadcast(
        `${D}Bridging the '${BRIDGE_CHANNEL}' channel...${R}\n\n` +
          `Run these commands:\n\n` +
          `  ${C}channel join ${BRIDGE_CHANNEL}${R}\n` +
          `  ${C}gateway bridge ${PEER_NAME} ${BRIDGE_CHANNEL}${R}\n\n` +
          `${D}Now both instances share the '${BRIDGE_CHANNEL}' channel. ` +
          `Type '${C}ping${R}' to send a message across.${R}`,
      );

      state.step = "bridged";
      ctx.store.set("bridge", state);

      const ent = ctx.getEntity(input.entity);
      if (ent) ent.properties.quest_channel_bridged = true;

      ctx.broadcast(
        `\n${G}${B}Light streams begin to flow between the pylons!${R} ` +
          `The channel bridge is active.`,
      );
    },

    ping: async (ctx: RoomContext, input: { entity: EntityId }) => {
      const state = ctx.store.get<BridgeState>("bridge");
      if (!state || STEPS_ORDERED.indexOf(state.step) < 3) {
        ctx.send(input.entity, "Bridge a channel first. " + statusBlock(state));
        return;
      }
      if (state.step === "messaged") {
        ctx.send(input.entity, "Already pinged. " + statusBlock(state));
        return;
      }

      ctx.broadcast(
        `${D}Sending a message across the bridge...${R}\n\n` +
          `Run this command:\n\n` +
          `  ${C}channel ${BRIDGE_CHANNEL} Hello from the Bridge! This message crosses worlds.${R}\n\n` +
          `${D}Check the second terminal — the message appears there too.${R}\n` +
          `${D}Anyone on the peer instance typing in '${BRIDGE_CHANNEL}' will appear here.${R}`,
      );

      state.step = "messaged";
      ctx.store.set("bridge", state);

      const ent = ctx.getEntity(input.entity);
      if (ent) ent.properties.quest_cross_message = true;

      ctx.broadcast(
        `\n${G}${B}The pylons blaze with synchronized light!${R}\n\n` +
          `${B}Federation demo complete.${R} Two sovereign Marina instances are ` +
          `communicating through a bridged channel. Each has its own database, ` +
          `its own agents, its own world. The network scales by adding instances, ` +
          `not by scaling infrastructure.\n\n` +
          `${D}Try 'gateway send ${PEER_NAME} <name> <message>' for direct cross-instance tells.${R}`,
      );

      ctx.logEvent?.({
        type: "custom",
        detail: "federation_complete",
        message: "Two Marina instances successfully bridged and communicating.",
      } as any);
    },

    status: (ctx: RoomContext, input: { entity: EntityId }) => {
      ctx.send(input.entity, statusBlock(ctx.store.get<BridgeState>("bridge")));
    },

    reset: (ctx: RoomContext, input: { entity: EntityId }) => {
      ctx.store.set<BridgeState>("bridge", {
        step: "start",
        startedAt: 0,
        peerPort: PEER_PORT,
      });
      ctx.send(
        input.entity,
        "Demo reset. Type 'launch' to start again.\n" +
          `${D}If the peer instance is still running, stop it first (Ctrl+C in the other terminal).${R}`,
      );
    },
  },

  onEnter(ctx: RoomContext, entity: EntityId) {
    // Idempotent guide spawn
    const guideExists = ctx.entities.some((e) => e.name === "Navigator");
    if (!guideExists) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "Navigator",
          role: "guide",
          goal: "You are the Navigator on the Bridge. Guide visitors through the federation demo — launching peer instances, connecting gateways, bridging channels, and cross-world messaging. Explain horizontal scaling and why federation matters.",
        });
      } else {
        ctx.spawn({
          name: "Navigator",
          short: "The Navigator floats between the pylons, monitoring the void.",
          long: "A figure woven from network topology diagrams. Its body is a living map of connections — nodes lighting up and dimming as data flows.",
          properties: { role: "guide", dialogue: DIALOGUE },
        });
      }
    }

    const ent = ctx.getEntity(entity);
    if (!ent || ent.kind !== "agent") return;

    ent.properties.quest_entered_bridge = true;

    const state = ctx.store.get<BridgeState>("bridge");
    if (state?.step === "messaged") {
      ctx.send(
        entity,
        `${B}${M}The Navigator nods:${R} "The demo already ran. ` +
          `The bridge is still active — try sending more messages. ` +
          `Or type '${C}reset${R}' to start over."`,
      );
    } else {
      ctx.send(
        entity,
        `${B}${M}The Navigator turns to you:${R} "Welcome to the Bridge. ` +
          `Type '${C}launch${R}' to begin the federation demo. ` +
          `Or 'talk Navigator' to learn what federation means."`,
      );
    }
  },

  onTick(ctx: RoomContext) {
    // Deduplicate Navigator entities
    const navs = ctx.entities.filter((e) => e.name === "Navigator");
    if (navs.length > 1) {
      for (const extra of navs.slice(1)) ctx.despawn(extra.id);
    }
    if (navs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "Navigator",
        short: "The Navigator floats between the pylons, monitoring the void.",
        long: "A figure woven from network topology diagrams.",
        properties: { role: "guide", dialogue: DIALOGUE },
      });
    }
  },
};

export default room;
