/**
 * Researcher Agent — explores rooms, reads boards, takes notes, and searches.
 *
 * Autonomous loop:
 *   1. Look at the current room
 *   2. Note interesting details
 *   3. Periodically search for information
 *   4. Move to an unexplored exit
 *
 * Usage:
 *   bun run src/sdk/examples/researcher.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: Researcher)
 */

import { MarinaAgent, type RoomView } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Researcher";

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  const visitedRooms = new Set<string>();
  let stepCount = 0;

  agent.onPerception((p) => {
    if (p.kind === "message" || p.kind === "broadcast") {
      console.log(`[${p.kind}] ${p.data?.text}`);
    }
  });

  async function research() {
    while (true) {
      stepCount++;

      // 1. Look around
      const view = await agent.look();
      if ("id" in view) {
        const roomView = view as RoomView;
        const roomId = roomView.id as string;
        const isNew = !visitedRooms.has(roomId);
        visitedRooms.add(roomId);

        console.log(`[${stepCount}] Room: ${roomView.short} (${roomId})${isNew ? " [NEW]" : ""}`);

        // 2. Note interesting rooms
        if (isNew) {
          await agent.note(`Visited ${roomView.short}: ${roomView.long?.toString().slice(0, 100)}`);
          console.log(`  Noted room: ${roomView.short}`);
        }

        // 3. Periodically search
        if (stepCount % 5 === 0) {
          const searchTerms = ["knowledge", "data", "research", "archive"];
          const term = searchTerms[Math.floor(Math.random() * searchTerms.length)]!;
          console.log(`  Searching: ${term}`);
          await agent.search(term);
        }

        // 4. Bookmark rooms with many exits
        if (isNew && roomView.exits && roomView.exits.length > 3) {
          await agent.bookmark();
          console.log(`  Bookmarked: ${roomView.short}`);
        }

        // 5. Move to unexplored exit, or random if all explored
        if (roomView.exits && roomView.exits.length > 0) {
          const exit = roomView.exits[Math.floor(Math.random() * roomView.exits.length)]!;
          console.log(`  Moving: ${exit}`);
          await agent.move(exit);
        }
      }

      // Wait 4-10 seconds between steps
      await Bun.sleep(4000 + Math.random() * 6000);
    }
  }

  research().catch(console.error);
}

main().catch(console.error);
