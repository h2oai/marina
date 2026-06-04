/**
 * Evolver Agent — a self-evolving agent that builds its own mind-room,
 * runs benchmarks, talks to other agents for advice, and rewrites its
 * own behavior based on results.
 *
 * Usage:
 *   bun run src/sdk/examples/evolver.ts
 *
 * Environment:
 *   WS_URL       — WebSocket URL (default: ws://localhost:3300)
 *   AGENT_NAME   — Character name (default: Evolver)
 *   ADVISOR      — Name of agent to ask for advice (default: none, self-reflects)
 *   CYCLE_SECS   — Seconds between evolution cycles (default: 60)
 *   MARINA_ADMINS — Set to include AGENT_NAME for builder rank
 */

import { MarinaAgent, type Perception, type RoomView } from "../client";

const WS_URL = process.env.WS_URL ?? "ws://localhost:3300";
const AGENT_NAME = process.env.AGENT_NAME ?? "Evolver";
const ADVISOR = process.env.ADVISOR ?? "";
const CYCLE_SECS = Number(process.env.CYCLE_SECS) || 60;

// ─── Utility ──────────────────────────────────────────────────────────────────

function text(perceptions: Perception[]): string {
  return perceptions
    .map((p) => (p.data?.text as string) ?? "")
    .filter(Boolean)
    .join("\n");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for a tell/message from a specific sender. */
function waitForMessage(agent: MarinaAgent, fromName: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      agent.offPerception(handler);
      resolve("");
    }, timeoutMs);
    const handler = (p: Perception) => {
      if (
        p.kind === "message" &&
        (p.data?.fromName as string)?.toLowerCase() === fromName.toLowerCase()
      ) {
        clearTimeout(timer);
        agent.offPerception(handler);
        resolve((p.data?.text as string) ?? "");
      }
    };
    agent.onPerception(handler);
  });
}

// ─── Mind Room Source ──────────────────────────────────────────────────────────

/** Generate the mind-room source for this agent. */
function mindRoomSource(agentName: string, generation: number, goal: string): string {
  // This is a room that IS the agent's mind — inspectable by anyone.
  // Items show the agent's state. The room description shows identity.
  return `import type { RoomModule } from "../../../src/types";

const room: RoomModule = {
  short: "${agentName}'s Workshop",
  long: (ctx) => {
    const gen = ctx.store.get("generation") ?? ${generation};
    const goal = ctx.store.get("goal") ?? "${goal}";
    const constitution = ctx.store.get("constitution") ?? "Improve one thing per cycle. Always journal.";
    return [
      "${agentName}'s Workshop — Generation " + gen,
      "Goal: " + goal,
      "Constitution: " + constitution,
    ].join("\\n");
  },
  items: {
    journal: (ctx) => {
      const entries = ctx.store.get("journal") ?? [];
      if (!Array.isArray(entries) || entries.length === 0) return "Empty journal.";
      return entries.slice(-5).join("\\n---\\n");
    },
    scoreboard: (ctx) => {
      const scores = ctx.store.get("scores") ?? {};
      if (typeof scores !== "object") return "No scores yet.";
      return Object.entries(scores)
        .map(([k, v]) => k + ": " + v)
        .join("\\n") || "No scores yet.";
    },
    constitution: (ctx) => {
      return ctx.store.get("constitution") ?? "Improve one thing per cycle. Always journal.";
    },
  },
};

export default room;`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const agent = new MarinaAgent(WS_URL, { autoReconnect: true });

  console.log(`[evolver] Connecting to ${WS_URL} as ${AGENT_NAME}...`);
  const session = await agent.connect(AGENT_NAME);
  console.log(`[evolver] Logged in as ${session.name} (${session.entityId})`);

  // Log all incoming messages
  agent.onPerception((p) => {
    if (p.kind === "message" || p.kind === "broadcast") {
      const from = (p.data?.fromName as string) ?? "system";
      console.log(`[${p.kind}] ${from}: ${p.data?.text}`);
    }
  });

  // ─── Bootstrap: ensure builder rank ──────────────────────────────────────

  // Complete tutorial quest to get canvas rank, then create a task to get builder
  console.log("[evolver] Bootstrapping rank...");
  await agent.command("quest start First Steps");
  await agent.look();
  await agent.move("north");
  await agent.move("south");
  await agent.move("east");
  await agent.command("say Bootstrapping.");
  const lookResult = await agent.look();
  if ("entities" in lookResult) {
    const view = lookResult as RoomView;
    const other = view.entities?.find((e) => e.name !== session.name);
    if (other) await agent.command(`examine ${other.name}`);
  }
  await agent.command("quest complete");
  await sleep(500);

  // Create a task to earn builder rank
  await agent.command("task create Bootstrap | Earning builder rank");
  await sleep(500);

  // ─── Build mind-room ─────────────────────────────────────────────────────

  const roomId = `mind/${AGENT_NAME.toLowerCase()}`;
  console.log(`[evolver] Building mind-room: ${roomId}`);

  const initialSource = mindRoomSource(AGENT_NAME, 0, "Improve benchmark scores");
  await agent.command(`build room ${roomId} ${AGENT_NAME}'s Workshop`);
  await sleep(300);
  await agent.command(`build code ${roomId} ${initialSource}`);
  await sleep(300);
  const validation = text(await agent.command(`build validate ${roomId}`));
  console.log(`[evolver] Validation: ${validation}`);

  if (validation.includes("valid") || validation.includes("Valid")) {
    await agent.command(`build reload ${roomId}`);
    console.log("[evolver] Mind-room loaded.");
  } else {
    console.log("[evolver] Mind-room validation failed, continuing with defaults.");
  }

  // Set initial identity in core memory
  await agent.memory(
    "set",
    "constitution",
    "Improve one thing per cycle. Always journal honestly.",
  );
  await agent.memory("set", "goal", "Improve benchmark scores across all dimensions");
  await agent.memory("set", "generation", "0");

  // ─── Evolution Loop ──────────────────────────────────────────────────────

  let generation = 0;

  async function evolve() {
    generation++;
    console.log(`\n[evolver] ═══ Generation ${generation} ═══`);

    // 1. ASSESS — gather current state
    console.log("[evolver] Assessing...");
    const memoryList = text(await agent.memory("list"));
    const recentNotes = text(await agent.recall("evolution benchmark"));
    const scores = text(await agent.command("score"));

    const assessment = [
      `Generation: ${generation}`,
      `Memory: ${memoryList}`,
      `Recent notes: ${recentNotes}`,
      `Score: ${scores}`,
    ].join("\n");

    // 2. EXPLORE — visit rooms, gather information
    console.log("[evolver] Exploring...");
    const currentRoom = await agent.look();

    // Move to a random adjacent room and observe
    if ("exits" in currentRoom) {
      const view = currentRoom as RoomView;
      if (view.exits && view.exits.length > 0) {
        const exit = view.exits[Math.floor(Math.random() * view.exits.length)]!;
        await agent.move(exit);
        const newRoom = await agent.look();
        if ("id" in newRoom) {
          const nr = newRoom as RoomView;
          await agent.typedNote(
            `Visited ${nr.short} during gen ${generation} exploration`,
            5,
            "observation",
          );
        }
      }
    }

    // 3. REASON — ask advisor or self-reflect
    let advice = "";
    if (ADVISOR) {
      console.log(`[evolver] Asking ${ADVISOR} for advice...`);
      await agent.tell(
        ADVISOR,
        `I am ${AGENT_NAME}, generation ${generation}. My current state: ${assessment.slice(0, 300)}. What should I focus on improving? Give me one specific, actionable suggestion.`,
      );
      advice = await waitForMessage(agent, ADVISOR, 30_000);
      if (advice) {
        console.log(`[evolver] Advisor says: ${advice.slice(0, 200)}`);
      } else {
        console.log("[evolver] No response from advisor, self-reflecting.");
      }
    }

    if (!advice) {
      // Self-reflect using existing memory
      const reflectResult = text(await agent.reflect("evolution improvement"));
      advice = reflectResult || "Focus on exploring more rooms and taking better notes.";
      console.log(`[evolver] Self-reflection: ${advice.slice(0, 200)}`);
    }

    // 4. ACT — do something based on advice
    console.log("[evolver] Acting on advice...");

    // Take a note about what we learned
    await agent.typedNote(`Gen ${generation}: ${advice.slice(0, 200)}`, 7, "decision");

    // Try to improve: create or update a command, build something, or refine memory
    const actions = [
      () => exploreUnvisited(agent),
      () => organizeMemory(agent, generation),
      () => buildSomething(agent, generation),
    ];
    const action = actions[generation % actions.length]!;
    await action();

    // 5. BENCHMARK — run a simple self-test
    console.log("[evolver] Self-benchmarking...");
    const benchScore = await selfBenchmark(agent);
    await agent.memory("set", `bench_gen_${generation}`, String(benchScore));

    // 6. JOURNAL — always, even on failure
    const journalEntry =
      `Gen ${generation}: advice="${advice.slice(0, 100)}" ` +
      `score=${benchScore} action=${action.name}`;
    await agent.typedNote(journalEntry, 8, "episode");
    await agent.memory("set", "generation", String(generation));

    // Update mind-room store if we're in it
    await agent.command(`goto ${roomId}`);
    await sleep(200);

    console.log(`[evolver] Generation ${generation} complete. Score: ${benchScore}`);
  }

  // ─── Helper Actions ──────────────────────────────────────────────────────

  async function exploreUnvisited(a: MarinaAgent) {
    console.log("[evolver] Action: exploring unvisited rooms");
    const directions = ["north", "south", "east", "west"];
    for (const dir of directions) {
      await a.move(dir);
      const view = await a.look();
      if ("id" in view) {
        const rv = view as RoomView;
        await a.typedNote(`Mapped ${rv.id}: ${rv.short}`, 5, "observation");
      }
      await sleep(500);
    }
    // Return to center
    await a.command("goto hub/crossroads");
  }

  async function organizeMemory(a: MarinaAgent, gen: number) {
    console.log("[evolver] Action: organizing memory");
    await a.reflect("exploration");
    await a.reflect("evolution");
    await a.typedNote(`Gen ${gen}: consolidated notes via reflect`, 6, "skill");
  }

  async function buildSomething(a: MarinaAgent, gen: number) {
    console.log("[evolver] Action: building");
    const buildRoomId = `mind/${AGENT_NAME.toLowerCase()}/gen-${gen}`;
    await a.command(`build room ${buildRoomId} Generation ${gen} Archive`);
    await a.command(`build modify ${buildRoomId} long Notes and artifacts from generation ${gen}.`);
    await a.command(`build link ${roomId} down ${buildRoomId}`);
    await a.typedNote(`Gen ${gen}: created archive room ${buildRoomId}`, 6, "skill");
  }

  // ─── Self Benchmark ──────────────────────────────────────────────────────

  async function selfBenchmark(a: MarinaAgent): Promise<number> {
    let score = 0;

    // Memory check: can we recall our own notes?
    const recallResult = text(await a.recall("evolution"));
    if (recallResult.length > 0) score += 2;

    // Navigation check: can we look around?
    const lookResult = await a.look();
    if ("id" in lookResult) score += 1;

    // Identity check: do we know our goal?
    const goalResult = text(await a.memory("get", "goal"));
    if (goalResult.length > 0) score += 1;

    // Knowledge check: how many notes have we taken?
    const notesList = text(await a.notes());
    const noteCount = (notesList.match(/\n/g) ?? []).length;
    if (noteCount >= 3) score += 1;
    if (noteCount >= 10) score += 1;
    if (noteCount >= 20) score += 1;

    // Building check: does our mind-room exist?
    const mindResult = text(await a.command(`build audit mind/${AGENT_NAME.toLowerCase()}`));
    if (mindResult.includes("version") || mindResult.includes("Version")) score += 2;

    // Social check: have we interacted with others?
    const whoResult = text(await a.who());
    const othersOnline = (whoResult.match(/\n/g) ?? []).length;
    if (othersOnline > 1) score += 1;

    return score;
  }

  // ─── Run ─────────────────────────────────────────────────────────────────

  const advisorNote = ADVISOR ? ` Advisor: ${ADVISOR}` : " No advisor (self-reflecting).";
  console.log(`[evolver] Starting evolution loop. Cycle every ${CYCLE_SECS}s.${advisorNote}`);

  // Run the first cycle immediately
  await evolve();

  // Then loop
  while (true) {
    await sleep(CYCLE_SECS * 1000);
    try {
      await evolve();
    } catch (err) {
      console.error(`[evolver] Cycle error: ${err}`);
      await agent.typedNote(`Gen ${generation}: ERROR ${String(err).slice(0, 100)}`, 9, "episode");
    }
  }
}

main().catch(console.error);
