/**
 * Intent Worker — claims and completes pending canvas intents.
 *
 * Demonstrates:
 *   1. Polling for pending intents
 *   2. Claiming an intent
 *   3. Completing an intent with a result
 *   4. Using perception filtering to react to intent notifications
 *
 * Usage:
 *   bun run src/sdk/examples/intent-worker.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: IntentWorker)
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "IntentWorker";

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  // Set a goal so brief compass tracks intent work
  agent.command("memory set goal Watch for canvas intents and complete them");

  // React to perceptions — look for pending intent signals
  agent.onPerception((p) => {
    const text = (p.data?.text as string) ?? "";

    // Brief compass mentions pending intents
    if (text.includes("pending intent")) {
      console.log("[intent-worker] Detected pending intents, checking...");
      agent.command("canvas intent list");
    }

    // Parse intent list output and claim the first pending one
    if (text.includes("pending") && text.includes("node:")) {
      const match = text.match(/node:(\S+)/);
      if (match) {
        const nodeId = match[1]!;
        console.log(`[intent-worker] Claiming intent on node ${nodeId}`);
        agent.command(`canvas intent claim ${nodeId}`);
        // Complete it after a short delay (simulate work)
        setTimeout(() => {
          console.log(`[intent-worker] Completing intent on node ${nodeId}`);
          agent.command(`canvas intent complete ${nodeId} Processed by ${AGENT_NAME}`);
        }, 3000);
      }
    }

    // Log all other messages
    if (p.kind === "message" || p.kind === "broadcast") {
      console.log(`[${p.kind}] ${text}`);
    }
  });

  // Poll for intents periodically as a fallback
  setInterval(() => {
    agent.command("canvas intent list");
  }, 30_000);

  console.log("Intent worker is running. Press Ctrl+C to stop.");
  await new Promise(() => {});
}

main().catch(console.error);
