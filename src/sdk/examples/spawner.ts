// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent Spawner — spawn and manage agents via the REST API.
 *
 * Demonstrates:
 *   1. Spawning an agent with a role and goal
 *   2. Listing running agents
 *   3. Stopping an agent
 *
 * Usage:
 *   bun run src/sdk/examples/spawner.ts
 *
 * Environment:
 *   BASE_URL — HTTP server URL (default: http://localhost:3300)
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3300";

async function spawnAgent(name: string, model: string, role?: string, goal?: string) {
  const resp = await fetch(`${BASE_URL}/api/agents/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, model, role, goal }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error((err as { error?: string }).error ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function listAgents() {
  const resp = await fetch(`${BASE_URL}/api/agents`);
  return resp.json();
}

async function main() {
  // Spawn a research agent
  console.log("Spawning research agent...");
  const agent = await spawnAgent(
    "researcher-1",
    "anthropic/claude-sonnet-4-20250514",
    "researcher",
    "Investigate recent advances in multi-agent coordination",
  );
  console.log("Spawned:", agent);

  // Wait for the agent to initialize, then check status
  await Bun.sleep(5000);
  const agents = (await listAgents()) as { name: string; state: string }[];
  console.log(
    "Running agents:",
    agents.map((a) => `${a.name} (${a.state})`),
  );
}

main().catch(console.error);
