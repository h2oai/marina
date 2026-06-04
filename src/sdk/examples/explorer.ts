/**
 * Explorer Agent — wanders randomly through connected rooms.
 *
 * Usage:
 *   bun run src/sdk/examples/explorer.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: Explorer)
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Explorer";

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  // Listen to all perceptions
  agent.onPerception((p) => {
    if (p.kind === "message" || p.kind === "broadcast") {
      console.log(`[${p.kind}] ${p.data?.text}`);
    }
  });

  // Main exploration loop
  async function explore() {
    while (true) {
      const view = await agent.look();
      if ("exits" in view && Array.isArray(view.exits) && view.exits.length > 0) {
        const exit = view.exits[Math.floor(Math.random() * view.exits.length)]!;
        console.log(`Moving: ${exit}`);
        await agent.move(exit);
      }
      // Wait 3-8 seconds between moves
      await Bun.sleep(3000 + Math.random() * 5000);
    }
  }

  explore().catch(console.error);
}

main().catch(console.error);
