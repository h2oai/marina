// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builder Agent — programmatically creates rooms and links them together.
 *
 * Usage:
 *   bun run src/sdk/examples/builder.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: BuilderBot)
 *
 * Note: The agent must have Builder rank (4+) to use build commands.
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "BuilderBot";

interface RoomPlan {
  id: string;
  short: string;
  long: string;
  linkTo?: { room: string; direction: string; reverse: string }[];
}

const ROOMS_TO_BUILD: RoomPlan[] = [
  {
    id: "custom/plaza",
    short: "Custom Plaza",
    long: "A wide-open plaza built by an autonomous agent. The ground is paved with procedurally generated tiles.",
    linkTo: [{ room: "hub/crossroads", direction: "down", reverse: "up" }],
  },
  {
    id: "custom/garden",
    short: "Agent's Garden",
    long: "A small garden tended by machine intelligence. Algorithmic hedgerows form precise geometric patterns.",
    linkTo: [{ room: "custom/plaza", direction: "north", reverse: "south" }],
  },
  {
    id: "custom/workshop",
    short: "Automation Workshop",
    long: "A cluttered workshop filled with half-finished constructs and scrolling terminal outputs.",
    linkTo: [{ room: "custom/plaza", direction: "east", reverse: "west" }],
  },
];

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: false });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  for (const plan of ROOMS_TO_BUILD) {
    console.log(`\nCreating room: ${plan.id} — "${plan.short}"`);

    // Create the room
    const createResult = await agent.command(`build room ${plan.id} ${plan.short}`);
    const createText = createResult.map((p) => p.data?.text).join(" ");
    if (createText.includes("Created") || createText.includes("already exists")) {
      console.log("  Room created (or exists).");
    } else {
      console.log(`  Result: ${createText}`);
      continue;
    }

    // Set the long description
    await agent.command(`build modify ${plan.id} long ${plan.long}`);
    console.log("  Description set.");

    // Link to other rooms
    if (plan.linkTo) {
      for (const link of plan.linkTo) {
        await agent.command(`build link ${plan.id} ${link.direction} ${link.room}`);
        await agent.command(`build link ${link.room} ${link.reverse} ${plan.id}`);
        console.log(`  Linked ${plan.id} ←→ ${link.room} (${link.direction}/${link.reverse})`);
      }
    }

    // Brief pause between rooms
    await Bun.sleep(500);
  }

  console.log("\nAll rooms built. Verifying...");
  for (const plan of ROOMS_TO_BUILD) {
    const result = await agent.command(`build audit ${plan.id}`);
    const text = result.map((p) => p.data?.text).join(" ");
    console.log(`  ${plan.id}: ${text.includes("valid") || text.includes("Room") ? "OK" : text}`);
  }

  console.log("\nBuilder agent complete.");
  agent.disconnect();
}

main().catch(console.error);
