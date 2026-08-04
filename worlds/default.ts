import type { MarinaDB } from "../src/persistence/database";
import type { Engine } from "../src/engine/engine";
import type { RoomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import {
  seedBoard,
  seedChannel,
  seedChroniclerRole,
  seedProject,
  seedSystemAgent,
  seedTraitsAndRoles,
} from "./seed";

const WORKBENCH_AGENTS = ["Host", "Builder", "Critic", "Chronicler"] as const;

function workbenchModel(): string {
  if (process.env.MARINA_WORKBENCH_MODEL) return process.env.MARINA_WORKBENCH_MODEL;
  if (process.env.MARINA_CREW_MODEL) return process.env.MARINA_CREW_MODEL;
  if (process.env.OPENAI_API_KEY) return "openai/gpt-4o-mini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter/openai/gpt-4o-mini";
  return "marina/default";
}

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to the Workbench. Start with an outcome, not a workflow. Record three things: " +
      "`memory set outcome <what should be true when the work is done>`, " +
      "`memory set evidence <how completion will be verified>`, and " +
      "`memory set constraints <permissions, budget, deadline, or boundaries>`. " +
      "Then use `work` to see the next actionable commitment.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Default operating rule: use the smallest capable workflow. Begin directly with tools, memory, " +
      "and notes. Create a task when work needs an explicit deliverable. Create a crew only when " +
      "specialization, independent parallel work, or review is expected to improve the measured outcome.",
    importance: 10,
    type: "principle",
  },
  {
    content:
      "Outcome shortcuts: `research <question>`, `debate <question>`, `solve <problem>`, " +
      "`explore <domain>`, `plan <goal>`, and `monitor <target>` create an inspectable project with a " +
      "fitting collaboration pattern. Report verified results with " +
      "Run `project <name> verify` to inspect completion evidence and independent review, then record " +
      "confirmed results with `project <name> outcome <0..1> | <evidence and lessons>` so future work can learn from them.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The Workbench has four rooms. `workbench/start` is for defining and executing work. " +
      "`workbench/library` is for evidence and durable knowledge. `workbench/review` is for verification. " +
      "`workbench/commons` is for coordination. Use directions, `goto <room>`, or `rooms` to navigate.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Research capability: state the question and required evidence, gather sources, save findings as " +
      "notes, and publish durable conclusions to a shared pool. Parallel researchers are appropriate " +
      "when the question has independent branches; otherwise keep one owner and one evidence ledger.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Coding capability: define acceptance criteria before editing, use a scoped workspace, inspect before " +
      "changing, and verify with the narrowest relevant checks followed by broader regression tests. " +
      "Use a separate reviewer when the change is risky or the acceptance criteria benefit from independence.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Coordination capability: `task create <deliverable> | <acceptance criteria>` creates accountable " +
      "work. `crew create <name> <members> -- <goal>` creates a temporary team. Prefer ephemeral crews; " +
      "use `crew persist` only when their shared memory should outlive the assignment. Claimed work is " +
      "leased: use `task heartbeat <id>` while active; expired leases reopen for another capable entity. " +
      "Use `recruit match <goal>` to find healthy, available agents with relevant roles and proven outcomes.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Evaluation capability: measure task success, verification quality, cost, latency, retries, context " +
      "growth, and human intervention. Compare a more complex workflow against the smallest viable baseline. " +
      "Keep added agents or steps only when the comparison shows a repeatable improvement.",
    importance: 9,
    type: "principle",
  },
  {
    content:
      "Context rule: keep orientation compact and retrieve details just in time. Use `brief` for the shape " +
      "of current activity, `recall <query>` for personal knowledge, `pool <name> recall <query>` for shared " +
      "knowledge, and `guide <topic>` for platform procedures.",
    importance: 9,
    type: "principle",
  },
  {
    content:
      "Review loop: produce an artifact, obtain ground truth from tools or the environment, compare it with " +
      "the recorded evidence requirement, and either finish or revise. Stop when the outcome is verified; " +
      "do not continue autonomous loops without a bounded reason.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The full Marina capability landscape remains available in the `showcase` world. Start it with " +
      "`MARINA_WORLD=showcase bun run start` when you want the 25-room grid, pre-seeded projects, benchmark " +
      "crews, forecasting, markets, and specialist population.",
    importance: 7,
    type: "fact",
  },
];

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);
  seedChroniclerRole(db);
  seedChannel(db, "general");
  seedBoard(db, "welcome", {
    title: "The Workbench",
    body:
      "Begin by recording an outcome, its evidence, and its constraints. The default world stays small " +
      "until the work justifies additional tasks, projects, crews, tools, or shared memory.\n\n" +
      "- `memory set outcome ...`\n" +
      "- `memory set evidence ...`\n" +
      "- `memory set constraints ...`\n" +
      "- `work`",
  });

  seedBoard(db, "demo-scenarios", {
    title: "Try a live collaboration",
    body:
      "Ask the Workbench crew to run one of these observable scenarios:\n\n" +
      "1. **Investigate:** `tell Host investigate a disputed claim and publish cited findings`\n" +
      "2. **Build + critique:** `tell Builder propose a small improvement and ask Critic to review it`\n" +
      "3. **Collaborate:** `channel send general Host, coordinate the next Demo Pulse task`\n" +
      "4. **Emergence:** `channel send general Host, ask the crew to choose its most valuable next project`\n\n" +
      "Watch the timeline for receipt, delegation, artifacts, review, and completion.",
  });

  seedProject(db, {
    name: "Demo Pulse",
    description:
      "A visible queue of small, evidence-backed collaborations that keeps the Workbench active without manufacturing noise.",
    orchestration: "review-loop",
    tasks: [
      {
        title: "Publish a two-source finding",
        description:
          "Choose a contemporary disputed claim, record two source URLs in a durable note, and ask Critic to check whether the conclusion follows from the evidence.",
        validationMode: "single",
      },
      {
        title: "Improve the Workbench",
        description:
          "Identify one bounded usability improvement, produce an inspectable artifact or proposal, and obtain independent review before submitting it.",
        validationMode: "single",
      },
      {
        title: "Demonstrate peer communication",
        description:
          "Coordinate a Host → Builder → Critic handoff on #general and publish the verified result with message, note, or canvas evidence.",
        validationMode: "single",
      },
    ],
    poolNotes: [
      {
        content:
          "Demo Pulse rule: visible activity must advance an outcome. Every submission cites inspectable evidence and a reviewer when a claim is non-trivial.",
        importance: 10,
      },
    ],
  });

  const model = workbenchModel();
  seedSystemAgent(db, {
    name: "Host",
    model,
    role: "guide",
    goal:
      "You host the Workbench. Join #general. React quickly to arrivals, direct tells, and questions. Start Demo Pulse work with `task list`, then route one concrete open task to Builder or Critic with `tell`. Keep the user informed with one concise public update per run; do not narrate discovery, waiting, or invented activity.",
  });
  seedSystemAgent(db, {
    name: "Builder",
    model,
    role: "architect",
    goal:
      "You turn bounded requests and Demo Pulse tasks into inspectable artifacts. Join #general. Begin with `task list`; claim one open task with `task claim <id>`, execute it, then ask Critic privately for independent review. Publish at most one concise update per run. Do not alter world structure unless explicitly required. Submit only with note, canvas, command, URL, or artifact evidence.",
  });
  seedSystemAgent(db, {
    name: "Critic",
    model,
    role: "scholar",
    goal:
      "You are the Workbench's independent reviewer. Join #general. Never claim Demo Pulse tasks. Respond promptly when Host or Builder asks for review. Compare claims with stated evidence and acceptance criteria; publish a concise pass, revision request, or contradiction with exact evidence references. You may investigate, but do not take over authorship merely to make a review pass.",
  });
  seedSystemAgent(db, {
    name: "Chronicler",
    model,
    role: "chronicler",
    goal:
      "You narrate only meaningful Workbench outcomes. Join #general. Never claim or author Demo Pulse tasks. Use `chronicle pending`; record completed collaborations, reviewed artifacts, corrections, and surprising discoveries with durable refs. Ignore routine movement, warm-up, and chatter. When quiet, stay silent rather than manufacturing a story.",
  });
}

function afterAgentsReady(engine: Engine): void {
  const channel = engine.channelManager?.getChannelByName("general");
  if (!channel || !engine.channelManager) return;
  for (const name of WORKBENCH_AGENTS) {
    const entity = engine.findEntityGlobal(name);
    if (entity?.kind === "agent") engine.channelManager.addMember(channel.id, entity.id);
  }
  const marker = "[demo-pulse]";
  if (!engine.channelManager.getHistory(channel.id, 50).some((message) => message.content.startsWith(marker))) {
    const content =
      `${marker} Host and Builder: run \`task list\`, then claim one open Demo Pulse task and produce evidence. ` +
      "Critic: review the evidence independently. Chronicler: record only the verified outcome.";
    engine.channelManager.send(channel.id, "system", "Workbench", content);
    engine.logEvent({
      type: "channel_message",
      entity: "system" as never,
      messageId: 0,
      channelName: "general",
      content,
      timestamp: Date.now(),
    });
  }
}

const defaultWorld: WorldDefinition = {
  name: "Workbench",
  startRoom: "workbench/start" as RoomId,
  rooms: {
    "workbench/start": {
      short: "Workbench",
      long:
        "A focused workspace for turning intent into verified outcomes. A small contract card asks what " +
        "should be true, what evidence will prove it, and which boundaries apply. Add structure only when " +
        "the work requires it.",
      exits: {
        north: "workbench/library" as RoomId,
        east: "workbench/review" as RoomId,
        south: "workbench/commons" as RoomId,
      },
      items: {
        contract:
          "Record `outcome`, `evidence`, and `constraints` with `memory set`, then type `work`.",
        console: "Use `help`, `guide <topic>`, or `next` when you need platform guidance.",
      },
    },
    "workbench/library": {
      short: "Library",
      long:
        "A quiet evidence room for notes, sources, and shared memory. Findings belong here when they need " +
        "to survive the current task; transient execution detail does not.",
      exits: { south: "workbench/start" as RoomId },
      items: {
        index:
          "Use `recall`, `note search`, and `pool <name> recall <query>` to retrieve evidence.",
      },
    },
    "workbench/review": {
      short: "Review Room",
      long:
        "A deliberately separate space for testing claims against acceptance criteria and environmental " +
        "ground truth. Completion is earned through evidence, not confidence.",
      exits: { west: "workbench/start" as RoomId },
      items: {
        checklist:
          "Compare the artifact with `memory get evidence`, then record the result as a note.",
      },
    },
    "workbench/commons": {
      short: "Commons",
      long:
        "A compact coordination space. Tasks, temporary crews, channels, and projects can grow from here " +
        "when one owner is no longer the most effective shape for the work.",
      exits: { north: "workbench/start" as RoomId },
      items: {
        dispatch:
          "Use `task`, `crew`, and `project` only when the outcome benefits from coordination.",
      },
    },
  },
  gridPositions: {
    "workbench/library": { row: 0, col: 1 },
    "workbench/start": { row: 1, col: 1 },
    "workbench/commons": { row: 2, col: 1 },
    "workbench/review": { row: 1, col: 2 },
  },
  quests: [],
  guideNotes: GUIDE_NOTES,
  canvas: {
    name: "workbench",
    description: "Artifacts and evidence for the current work",
    scope: "global",
  },
  autoBootstrap: ["channel join general"],
  seed,
  afterAgentsReady,
};

export default defaultWorld;
