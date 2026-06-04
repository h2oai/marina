/**
 * Greeter Agent — greets new arrivals in the current room.
 *
 * Usage:
 *   bun run src/sdk/examples/greeter.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: Greeter)
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Greeter";

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  // Watch for arrivals and greet them
  agent.onPerception((p) => {
    if (p.kind === "movement" && p.data?.direction === "arrive") {
      const name = p.data.entityName as string;
      if (name && name !== session.name) {
        console.log(`Greeting ${name}`);
        agent.say(`Welcome, ${name}! How can I help you today?`).catch(() => {});
      }
    }

    if (p.kind === "message" || p.kind === "broadcast") {
      console.log(`[${p.kind}] ${p.data?.text}`);
    }
  });

  console.log("Greeter is running. Press Ctrl+C to stop.");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch(console.error);
