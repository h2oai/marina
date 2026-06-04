/**
 * Publisher Agent — uploads assets and publishes them to a canvas.
 *
 * Demonstrates:
 *   1. Creating a canvas
 *   2. Uploading assets from URLs
 *   3. Publishing assets as typed nodes
 *   4. Listing canvas contents
 *
 * Usage:
 *   bun run src/sdk/examples/publisher.ts
 *
 * Environment:
 *   WS_URL — WebSocket server URL (default: ws://localhost:3300)
 *   AGENT_NAME — Character name (default: Publisher)
 */

import { MarinaAgent } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Publisher";

const SAMPLE_IMAGES = [
  "https://picsum.photos/id/10/800/600",
  "https://picsum.photos/id/20/800/600",
  "https://picsum.photos/id/30/800/600",
];

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`Logged in as ${session.name} (${session.entityId})`);

  // Listen for all responses
  agent.onPerception((p) => {
    if (p.data?.text) {
      console.log(`  [${p.kind}] ${p.data.text}`);
    }
  });

  // 1. Create a canvas
  const canvasName = `gallery-${Date.now()}`;
  console.log(`\nCreating canvas: ${canvasName}`);
  await agent.createCanvas(canvasName, "Auto-generated image gallery");

  // 2. Upload and publish images
  for (const url of SAMPLE_IMAGES) {
    console.log(`\nUploading: ${url}`);
    const uploadResult = await agent.uploadAsset(url);

    // Extract asset ID from the response text
    const text = uploadResult.find((p) => p.data?.text)?.data?.text as string;
    const match = text?.match(/ID:\s*(\S+)/);
    if (match) {
      const assetId = match[1]!;
      console.log(`  Asset ID: ${assetId}`);

      console.log(`  Publishing to ${canvasName}...`);
      await agent.publishToCanvas("image", assetId, canvasName);
    }

    // Small delay between uploads
    await Bun.sleep(1000);
  }

  // 3. Show canvas contents
  console.log("\nCanvas contents:");
  await agent.canvasNodes(canvasName);

  // 4. List all canvases
  console.log("\nAll canvases:");
  await agent.listCanvases();

  console.log("\nDone! Visit /canvas in your browser to view the gallery.");
  agent.disconnect();
}

main().catch(console.error);
