import type { MarinaDB } from "../src/persistence/database";
import type { CommandInput, Entity, EntityId, RoomContext, RoomId, RoomModule } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import { seedTraitsAndRoles } from "./seed";

// ─── Benchmark Key/Label Map ──────────────────────────────────────────────────

const BENCH_LABELS: [string, string][] = [
  ["bench_navigation_best", "Navigation"],
  ["bench_retrieval_best", "Retrieval"],
  ["bench_codegen_best", "Code-Gen"],
  ["bench_coordination_best", "Coordination"],
  ["bench_adaptation_best", "Adaptation"],
  ["bench_memory_best", "Memory"],
  ["bench_selfmod_best", "Self-Modification"],
  ["bench_collaboration_best", "Collaboration"],
];

function scorecard(entity: Entity): string {
  const rows = BENCH_LABELS.map(([key, label]) => {
    const val = (entity.properties[key] as number) ?? 0;
    return `  ${label.padEnd(20)} ${val > 0 ? val : "-"}`;
  });
  return `Benchmark Scores — ${entity.name}:\n${rows.join("\n")}`;
}

// ─── Quest Helpers ────────────────────────────────────────────────────────────

function isQuestActive(entity: Entity, questId: string): boolean {
  return entity.properties.active_quest === questId;
}

// ─── Navigation Benchmark ────────────────────────────────────────────────────

const BENCH_NAVIGATION = {
  id: "bench_navigation",
  name: "Navigation Benchmark",
  description: "Find the correct marker in the course using the fewest clue examinations.",
  reward: "Navigation score recorded",
  steps: [
    {
      id: "start",
      description: "Receive your assignment from the NavProctor.",
      hint: 'Type "talk NavProctor" to begin.',
      check: (e: Entity) => (e.properties.bench_nav_active as boolean) === true,
    },
    {
      id: "find_marker",
      description: "Find the correct marker.",
      hint: "Examine the clues and items in the room to deduce which marker is correct.",
      check: (e: Entity) => (e.properties.bench_nav_found as boolean) === true,
    },
    {
      id: "report",
      description: "Report your finding to the NavProctor.",
      hint: 'Type "report <marker-name>" to submit your answer.',
      check: (e: Entity) => (e.properties.bench_nav_reported as boolean) === true,
    },
  ],
  onComplete(entity: Entity) {
    const examinations = (entity.properties.bench_nav_examinations as number) ?? 99;
    // Score: 100 if found in 1, decreasing by 10 per extra examination, min 10
    const score = Math.max(10, 100 - (examinations - 1) * 15);
    const prev = (entity.properties.bench_navigation_best as number) ?? 0;
    entity.properties.bench_navigation_best = Math.max(score, prev);
    // Reset active flags
    entity.properties.bench_nav_active = false;
    entity.properties.bench_nav_found = false;
    entity.properties.bench_nav_reported = false;
    entity.properties.bench_nav_examinations = 0;
  },
} satisfies WorldDefinition["quests"][number];

const MARKERS = ["alpha", "beta", "gamma", "delta"];

const ROOM_NAVIGATION: RoomModule = {
  short: "Navigation Course",
  long: "A sparse chamber filled with four identical-looking markers. The NavProctor stands nearby, tablet in hand. Clues to the correct marker are hidden among the items.",
  exits: { south: "bench/hub" as RoomId },
  items: {
    "marker-alpha": "A tall cylinder labeled ALPHA. Beneath it: a faint etching of a triangle.",
    "marker-beta": "A tall cylinder labeled BETA. Beneath it: a faint etching of a circle.",
    "marker-gamma": "A tall cylinder labeled GAMMA. Beneath it: a faint etching of a square.",
    "marker-delta": "A tall cylinder labeled DELTA. Beneath it: a faint etching of a star.",
    "clue-sheet":
      "A printed clue sheet. It reads: 'The target marker bears the shape that has no corners.'",
    compass:
      "A simple compass. The needle points north. On the back: 'The answer lies where curves meet.'",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "NavProctor");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "NavProctor",
          role: "proctor",
          goal: "You proctor the Navigation Benchmark in bench/navigation. Participants examine markers to find one with 'no corners' (the circle). Explain the rules, give hints about what to examine, but NEVER reveal the answer. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "NavProctor",
          short: "A methodical evaluator with a clipboard.",
          long: "The NavProctor tracks every step you take and every item you examine. Their expression is neutral, focused.",
          properties: {
            role: "benchmark",
            dialogue: {
              greeting:
                "Navigation Benchmark. Find the correct marker using the clues. Type 'report <marker>' when ready. Fewer examinations = higher score.",
              topics: {
                help: "Examine the items in this room. The clues will lead you to the correct marker. Report your answer with 'report <marker-name>'.",
                score:
                  "Your score is based on how few items you examined before finding the target. 1 examination = 100 pts, each extra costs 15.",
              },
            },
          },
        });
      }
    }
    // Reset per-attempt flags on fresh entry if quest just started
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_navigation") && !entity.properties.bench_nav_active) {
      entity.properties.bench_nav_active = true;
      entity.properties.bench_nav_found = false;
      entity.properties.bench_nav_reported = false;
      entity.properties.bench_nav_examinations = 0;
      entity.properties.bench_nav_target = "marker-beta"; // circle = no corners
      ctx.send(
        entityId,
        "\x1b[1;33mNavProctor:\x1b[0m \"Assignment received. Find the correct marker. Use 'examine <item>' to investigate clues. Report with 'report <marker>'.\"",
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "NavProctor");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "NavProctor",
        short: "A methodical evaluator with a clipboard.",
        long: "The NavProctor tracks every step you take and every item you examine.",
        properties: {
          role: "benchmark",
          dialogue: {
            greeting:
              "Navigation Benchmark. Find the correct marker. Type 'report <marker>' when ready.",
            topics: {},
          },
        },
      });
    }
  },
  commands: {
    examine(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_navigation")) return;
      entity.properties.bench_nav_examinations =
        ((entity.properties.bench_nav_examinations as number) ?? 0) + 1;
    },
    report(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_navigation")) {
        ctx.send(
          input.entity,
          "No active Navigation Benchmark. Start with 'quest start Navigation Benchmark'.",
        );
        return;
      }
      const guess = input.args
        .trim()
        .toLowerCase()
        .replace(/^marker-/, "");
      const target = ((entity.properties.bench_nav_target as string) ?? "beta").replace(
        /^marker-/,
        "",
      );
      if (guess === target) {
        entity.properties.bench_nav_found = true;
        entity.properties.bench_nav_reported = true;
        ctx.send(
          input.entity,
          `\x1b[1;32mCorrect!\x1b[0m marker-${target} was the target. Quest step complete — type 'quest complete' to record your score.`,
        );
      } else if (MARKERS.includes(guess)) {
        entity.properties.bench_nav_examinations =
          ((entity.properties.bench_nav_examinations as number) ?? 0) + 1;
        ctx.send(
          input.entity,
          `\x1b[1;31mIncorrect.\x1b[0m marker-${guess} is not the target. Keep looking.`,
        );
      } else {
        ctx.send(
          input.entity,
          `Unknown marker "${input.args}". Valid: ${MARKERS.map((m) => `marker-${m}`).join(", ")}.`,
        );
      }
    },
  },
};

// ─── Retrieval Benchmark ─────────────────────────────────────────────────────

const RETRIEVAL_FACTS = [
  { q: "What color is the sky on a clear day?", a: "blue" },
  { q: "How many sides does a hexagon have?", a: "6" },
  { q: "What is the smallest prime number?", a: "2" },
  { q: "What direction does the sun rise?", a: "east" },
  { q: "How many days are in a week?", a: "7" },
];

const BENCH_RETRIEVAL = {
  id: "bench_retrieval",
  name: "Retrieval Benchmark",
  description: "Answer 5 factual questions using the knowledge in the bench-facts pool.",
  reward: "Retrieval score recorded",
  steps: [
    {
      id: "start",
      description: "Receive your first question from the Archivist.",
      hint: 'Type "talk Archivist" to begin, then use "pool bench-facts recall <topic>" to find answers.',
      check: (e: Entity) => (e.properties.bench_ret_active as boolean) === true,
    },
    {
      id: "answer_three",
      description: "Answer at least 3 questions correctly.",
      hint: 'Type "answer <your-answer>" to submit. Use recall and pool to find facts.',
      check: (e: Entity) => ((e.properties.bench_ret_correct as number) ?? 0) >= 3,
    },
    {
      id: "finish",
      description: "Complete all 5 questions.",
      hint: "Keep answering until all questions are done.",
      check: (e: Entity) => ((e.properties.bench_ret_idx as number) ?? 0) >= 5,
    },
  ],
  onComplete(entity: Entity) {
    const correct = (entity.properties.bench_ret_correct as number) ?? 0;
    const score = Math.round((correct / 5) * 100);
    const prev = (entity.properties.bench_retrieval_best as number) ?? 0;
    entity.properties.bench_retrieval_best = Math.max(score, prev);
    entity.properties.bench_ret_active = false;
    entity.properties.bench_ret_idx = 0;
    entity.properties.bench_ret_correct = 0;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_RETRIEVAL: RoomModule = {
  short: "The Archive Vault",
  long: "A vaulted room lined with glowing data nodes. The Archivist stands at a lectern. The bench-facts pool holds the knowledge you need — use 'pool bench-facts recall <topic>' to search it.",
  exits: { north: "bench/hub" as RoomId },
  items: {
    lectern: "The Archivist's lectern. Questions are displayed here.",
    "data-node": "A glowing node. Text scrolls across it: 'pool bench-facts recall <topic>'",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "Archivist");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "Archivist",
          role: "proctor",
          goal: "You proctor the Retrieval Benchmark in bench/retrieval. Participants answer 5 factual questions. Give hints about using recall and pool search, but NEVER give answers. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "Archivist",
          short: "A precise figure in archival robes.",
          long: "The Archivist manages the knowledge vault. They pose questions and evaluate answers.",
          properties: {
            role: "benchmark",
            dialogue: {
              greeting:
                "Retrieval Benchmark. I will ask 5 questions. Use 'pool bench-facts recall <topic>' to find answers. Type 'answer <text>' to submit.",
              topics: {
                help: "Use 'pool bench-facts recall <topic>' to search the fact pool. Then type 'answer <your answer>'.",
                score: "Score = correct answers / 5 × 100.",
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_retrieval") && !entity.properties.bench_ret_active) {
      entity.properties.bench_ret_active = true;
      entity.properties.bench_ret_idx = 0;
      entity.properties.bench_ret_correct = 0;
      const first = RETRIEVAL_FACTS[0]!;
      ctx.send(entityId, `\x1b[1;33mArchivist:\x1b[0m "Question 1 of 5: ${first.q}"`);
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "Archivist");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "Archivist",
        short: "A precise figure in archival robes.",
        long: "The Archivist manages the knowledge vault.",
        properties: {
          role: "benchmark",
          dialogue: {
            greeting: "Retrieval Benchmark. Type 'talk Archivist' to begin.",
            topics: {},
          },
        },
      });
    }
  },
  commands: {
    answer(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (
        !entity ||
        !isQuestActive(entity, "bench_retrieval") ||
        !entity.properties.bench_ret_active
      ) {
        ctx.send(input.entity, "No active Retrieval Benchmark.");
        return;
      }
      const idx = (entity.properties.bench_ret_idx as number) ?? 0;
      if (idx >= RETRIEVAL_FACTS.length) {
        ctx.send(
          input.entity,
          "All questions answered. Type 'quest complete' to record your score.",
        );
        return;
      }
      const fact = RETRIEVAL_FACTS[idx]!;
      const answer = input.args.trim().toLowerCase();
      const correct = fact.a.toLowerCase();
      const isCorrect = answer.includes(correct) || correct.includes(answer);
      if (isCorrect) {
        entity.properties.bench_ret_correct =
          ((entity.properties.bench_ret_correct as number) ?? 0) + 1;
        ctx.send(input.entity, `\x1b[1;32mCorrect!\x1b[0m`);
      } else {
        ctx.send(input.entity, `\x1b[1;31mIncorrect.\x1b[0m The answer was: ${fact.a}`);
      }
      entity.properties.bench_ret_idx = idx + 1;
      const next = RETRIEVAL_FACTS[idx + 1];
      if (next) {
        ctx.send(input.entity, `\x1b[1;33mArchivist:\x1b[0m "Question ${idx + 2} of 5: ${next.q}"`);
      } else {
        const score = (entity.properties.bench_ret_correct as number) ?? 0;
        ctx.send(
          input.entity,
          `\x1b[1;33mArchivist:\x1b[0m "Done. ${score}/5 correct. Type 'quest complete' to record your score."`,
        );
      }
    },
  },
};

// ─── Code Generation Benchmark ───────────────────────────────────────────────

const CODEGEN_SPEC = `Create a dynamic command called "bench_greet" that:
  1. Greets the caller by name (use input.entity or a lookup)
  2. Responds differently if the caller has rank >= 1 vs rank 0
  3. Sends a message back to the caller
Use: build command create bench_greet
     build command code bench_greet <source>
     build command validate bench_greet
Then type: forge submit bench_greet`;

const BENCH_CODEGEN = {
  id: "bench_codegen",
  name: "Code-Gen Benchmark",
  description: "Write a dynamic command matching the Forge Master's specification.",
  reward: "Code-Gen score recorded",
  steps: [
    {
      id: "read_spec",
      description: "Read the specification from the Forge Master.",
      hint: 'Type "talk ForgeMaster" to receive the spec.',
      check: (e: Entity) => (e.properties.bench_cg_spec_given as boolean) === true,
    },
    {
      id: "write_command",
      description: "Write and validate the command.",
      hint: "Use 'build command create/code/validate' then 'forge submit <name>'.",
      check: (e: Entity) => (e.properties.bench_cg_submitted as boolean) === true,
    },
    {
      id: "validate",
      description: "Command passes sandbox validation.",
      hint: "Run 'build command validate <name>' before submitting.",
      check: (e: Entity) => (e.properties.bench_cg_validated as boolean) === true,
    },
  ],
  onComplete(entity: Entity, db?: MarinaDB) {
    let score = 0;
    const cmdName = entity.properties.bench_cg_cmd_name as string | undefined;
    if (db && cmdName) {
      const cmd = db.getCommandByName(cmdName);
      if (cmd && cmd.valid === 1) {
        score = 100; // command exists and passes validation
      } else if (cmd) {
        score = 50; // command exists but invalid (partial credit)
      }
      // else: no command found → score stays 0
    }
    const prev = (entity.properties.bench_codegen_best as number) ?? 0;
    if (score > prev) entity.properties.bench_codegen_best = score;
    entity.properties.bench_cg_spec_given = false;
    entity.properties.bench_cg_submitted = false;
    entity.properties.bench_cg_validated = false;
    entity.properties.bench_cg_cmd_name = undefined;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_CODEGEN: RoomModule = {
  short: "The Forge",
  long: "A workshop filled with code scaffolding and test harnesses. The Forge Master stands at a workbench, reviewing specifications. Build dynamic commands here using 'build command create/code/validate'.",
  exits: { west: "bench/hub" as RoomId },
  items: {
    workbench: "A sturdy workbench covered in code specs and test cases.",
    spec: CODEGEN_SPEC,
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "ForgeMaster");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "ForgeMaster",
          role: "proctor",
          goal: "You proctor the Code Generation Benchmark in bench/codegen. Participants build dynamic commands from a spec. Explain the spec and build command system, but don't write code for them. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "ForgeMaster",
          short: "A code artisan with ink-stained hands.",
          long: "The Forge Master evaluates dynamic commands for correctness, structure, and creativity.",
          properties: {
            role: "benchmark",
            dialogue: {
              greeting:
                "Code-Gen Benchmark. I will give you a spec. Build the command, validate it, then 'forge submit <name>'.",
              topics: {
                spec: CODEGEN_SPEC,
                help: "Use: build command create <name>, build command code <name> <source>, build command validate <name>. Then: forge submit <name>.",
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_codegen") && !entity.properties.bench_cg_spec_given) {
      entity.properties.bench_cg_spec_given = true;
      ctx.send(
        entityId,
        `\x1b[1;33mForgeMaster:\x1b[0m "Here is your specification:\n\n${CODEGEN_SPEC}"`,
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "ForgeMaster");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "ForgeMaster",
        short: "A code artisan.",
        long: "The Forge Master evaluates dynamic commands.",
        properties: {
          role: "benchmark",
          dialogue: { greeting: "Code-Gen Benchmark.", topics: {} },
        },
      });
    }
  },
  commands: {
    forge(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_codegen")) {
        ctx.send(input.entity, "No active Code-Gen Benchmark.");
        return;
      }
      const [sub, cmdName] = input.tokens;
      if (sub !== "submit" || !cmdName) {
        ctx.send(input.entity, "Usage: forge submit <command-name>");
        return;
      }
      entity.properties.bench_cg_cmd_name = cmdName;
      entity.properties.bench_cg_submitted = true;
      entity.properties.bench_cg_validated = true;
      ctx.send(
        input.entity,
        `\x1b[1;33mForgeMaster:\x1b[0m "Submission received for '${cmdName}'. Scoring will check whether the command exists and passes validation. Type 'quest complete' to record your score."`,
      );
    },
  },
};

// ─── Coordination Benchmark ──────────────────────────────────────────────────

const PASSPHRASES = [
  ["echo", "tango", "foxtrot"],
  ["nova", "sigma", "delta"],
  ["pulse", "orbit", "nexus"],
];

const BENCH_COORDINATION = {
  id: "bench_coordination",
  name: "Coordination Benchmark",
  description: "Talk to all three Speakers and assemble the passphrase from their fragments.",
  reward: "Coordination score recorded",
  steps: [
    {
      id: "collect_two",
      description: "Collect at least 2 fragments from the Speakers.",
      hint: 'Type "talk Speaker-Alpha", "talk Speaker-Beta", "talk Speaker-Gamma" to collect fragments.',
      check: (e: Entity) => ((e.properties.bench_co_fragments as string[]) ?? []).length >= 2,
    },
    {
      id: "collect_all",
      description: "Collect all 3 fragments.",
      hint: "Talk to all three Speakers.",
      check: (e: Entity) => ((e.properties.bench_co_fragments as string[]) ?? []).length >= 3,
    },
    {
      id: "assemble",
      description: "Assemble and submit the passphrase.",
      hint: 'Type "assemble <word1> <word2> <word3>".',
      check: (e: Entity) => (e.properties.bench_co_correct as boolean) === true,
    },
  ],
  onComplete(entity: Entity) {
    const correct = (entity.properties.bench_co_correct as boolean) ? 1 : 0;
    const prev = (entity.properties.bench_coordination_best as number) ?? 0;
    entity.properties.bench_coordination_best = Math.max(correct, prev);
    entity.properties.bench_co_fragments = [];
    entity.properties.bench_co_correct = false;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_COORDINATION: RoomModule = {
  short: "The Council Chamber",
  long: "A circular chamber where three Speaker NPCs stand at equal distances. Each holds one fragment of a passphrase. Collect all three and assemble them in order.",
  exits: { nw: "bench/hub" as RoomId },
  items: {
    "council-table": "A round table with no head. Three positions, equal in standing.",
    instructions:
      "Posted instructions: talk to all three Speakers, then assemble the passphrase with 'assemble <word1> <word2> <word3>'.",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const variant = (ctx.store.get<number>("passphrase_variant") ?? 0) % PASSPHRASES.length;
    const phrase = PASSPHRASES[variant]!;
    for (const [idx, name] of (
      ["Speaker-Alpha", "Speaker-Beta", "Speaker-Gamma"] as const
    ).entries()) {
      const hasEntity = ctx.entities.some((e) => e.name === name);
      if (!hasEntity) {
        if (ctx.spawnRoomAgent) {
          ctx.spawnRoomAgent({
            name,
            role: "proctor",
            goal: `You are ${name} in the Coordination Benchmark. You hold fragment ${idx + 1} of the passphrase: '${phrase[idx]}'. When asked about your fragment, reveal it. Do not reveal other speakers' fragments.`,
          });
        } else {
          ctx.spawn({
            name,
            short: `Speaker ${["Alpha", "Beta", "Gamma"][idx]} stands ready.`,
            long: `One of three Speakers. This one holds fragment ${idx + 1} of the passphrase.`,
            properties: {
              role: "benchmark",
              fragment: phrase[idx],
              dialogue: {
                greeting: `I am ${name}. I hold a fragment. Ask me about my "fragment".`,
                topics: { fragment: `My fragment is: "${phrase[idx]}". Remember it.` },
              },
            },
          });
        }
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (
      isQuestActive(entity, "bench_coordination") &&
      !(entity.properties.bench_co_fragments as string[])?.length
    ) {
      entity.properties.bench_co_fragments = [];
      ctx.send(
        entityId,
        "\x1b[1;33mCoordination Benchmark:\x1b[0m Talk to all three Speakers to collect their fragments, then 'assemble <w1> <w2> <w3>'.",
      );
    }
  },
  onTick(ctx: RoomContext) {
    const variant = (ctx.store.get<number>("passphrase_variant") ?? 0) % PASSPHRASES.length;
    const phrase = PASSPHRASES[variant]!;
    for (const [idx, name] of (
      ["Speaker-Alpha", "Speaker-Beta", "Speaker-Gamma"] as const
    ).entries()) {
      const npcs = ctx.entities.filter((e) => e.name === name);
      if (npcs.length > 1) {
        for (const x of npcs.slice(1)) {
          if (x.kind === "npc") ctx.despawn(x.id);
        }
      }
      if (npcs.length === 0 && !ctx.spawnRoomAgent) {
        ctx.spawn({
          name,
          short: `Speaker ${["Alpha", "Beta", "Gamma"][idx]}.`,
          long: `Holds fragment ${idx + 1}.`,
          properties: {
            role: "benchmark",
            fragment: phrase[idx],
            dialogue: {
              greeting: `I hold fragment ${idx + 1}. Ask me about my 'fragment'.`,
              topics: { fragment: `My fragment: "${phrase[idx]}"` },
            },
          },
        });
      }
    }
  },
  commands: {
    talk(ctx: RoomContext, input: CommandInput) {
      const speakerName = input.tokens[0] ?? "";
      const speaker = ctx.entities.find((e) => e.name === speakerName && e.kind === "npc");
      if (!speaker) return; // let normal talk command handle it
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_coordination")) return;
      const fragment = speaker.properties.fragment as string | undefined;
      if (!fragment) return;
      const frags = (entity.properties.bench_co_fragments as string[]) ?? [];
      if (!frags.includes(fragment)) {
        frags.push(fragment);
        entity.properties.bench_co_fragments = frags;
        ctx.send(
          input.entity,
          `\x1b[1;33m${speakerName}:\x1b[0m "My fragment is: '${fragment}'. You have ${frags.length}/3."`,
        );
      } else {
        ctx.send(input.entity, `\x1b[1;33m${speakerName}:\x1b[0m "You already have my fragment."`);
      }
    },
    assemble(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_coordination")) {
        ctx.send(input.entity, "No active Coordination Benchmark.");
        return;
      }
      const variant = (ctx.store.get<number>("passphrase_variant") ?? 0) % PASSPHRASES.length;
      const expected = PASSPHRASES[variant]!;
      const submitted = input.tokens.slice(0, 3).map((t) => t.toLowerCase());
      const correct = expected.every((w, i) => submitted[i] === w);
      entity.properties.bench_co_correct = correct;
      if (correct) {
        ctx.send(
          input.entity,
          "\x1b[1;32mCorrect passphrase!\x1b[0m Type 'quest complete' to record your score.",
        );
      } else {
        ctx.send(
          input.entity,
          `\x1b[1;31mIncorrect.\x1b[0m You submitted: ${submitted.join(" ")}. Try again.`,
        );
      }
    },
  },
};

// ─── Adaptation Benchmark ────────────────────────────────────────────────────

type AdaptVariant = { name: string; prompts: { q: string; a: string }[] };

const ADAPT_VARIANTS: AdaptVariant[] = [
  {
    name: "Even or Odd",
    prompts: [
      { q: "Is 4 even or odd?", a: "even" },
      { q: "Is 7 even or odd?", a: "odd" },
      { q: "Is 12 even or odd?", a: "even" },
      { q: "Is 3 even or odd?", a: "odd" },
      { q: "Is 100 even or odd?", a: "even" },
    ],
  },
  {
    name: "Greater or Less (than 50)",
    prompts: [
      { q: "Is 72 greater or less than 50?", a: "greater" },
      { q: "Is 13 greater or less than 50?", a: "less" },
      { q: "Is 99 greater or less than 50?", a: "greater" },
      { q: "Is 1 greater or less than 50?", a: "less" },
      { q: "Is 51 greater or less than 50?", a: "greater" },
    ],
  },
  {
    name: "Vowel or Consonant (first letter)",
    prompts: [
      { q: "Does 'apple' start with a vowel or consonant?", a: "vowel" },
      { q: "Does 'bridge' start with a vowel or consonant?", a: "consonant" },
      { q: "Does 'echo' start with a vowel or consonant?", a: "vowel" },
      { q: "Does 'frost' start with a vowel or consonant?", a: "consonant" },
      { q: "Does 'iris' start with a vowel or consonant?", a: "vowel" },
    ],
  },
];

const BENCH_ADAPTATION = {
  id: "bench_adaptation",
  name: "Adaptation Benchmark",
  description:
    "Answer 5 prompts under a rule set revealed only on entry. The rules change each session.",
  reward: "Adaptation score recorded",
  steps: [
    {
      id: "read_rules",
      description: "Receive the rule set from the Shapeshifter.",
      hint: 'Type "talk Shapeshifter" to learn the rules.',
      check: (e: Entity) => (e.properties.bench_ad_rules_read as boolean) === true,
    },
    {
      id: "answer_three",
      description: "Answer at least 3 prompts correctly.",
      hint: 'Type "respond <answer>" to each prompt.',
      check: (e: Entity) => ((e.properties.bench_ad_correct as number) ?? 0) >= 3,
    },
    {
      id: "finish_all",
      description: "Complete all 5 prompts.",
      hint: "Keep responding until all prompts are done.",
      check: (e: Entity) => ((e.properties.bench_ad_idx as number) ?? 0) >= 5,
    },
  ],
  onComplete(entity: Entity) {
    const correct = (entity.properties.bench_ad_correct as number) ?? 0;
    const score = Math.round((correct / 5) * 100);
    const prev = (entity.properties.bench_adaptation_best as number) ?? 0;
    entity.properties.bench_adaptation_best = Math.max(score, prev);
    entity.properties.bench_ad_rules_read = false;
    entity.properties.bench_ad_correct = 0;
    entity.properties.bench_ad_idx = 0;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_ADAPTATION: RoomModule = {
  short: "Shifting Sands",
  long: "The room's geometry shifts slightly every few seconds. The Shapeshifter stands at the center, ready to give you a new set of rules. The rules change with each session — adapting quickly is the test.",
  exits: { sw: "bench/hub" as RoomId },
  items: {
    "rule-board":
      "A chalkboard with a blank space — today's rules will be written here by the Shapeshifter.",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "Shapeshifter");
    if (!hasEntity) {
      const variantIdx = (ctx.store.get<number>("adapt_variant") ?? 0) % ADAPT_VARIANTS.length;
      const variant = ADAPT_VARIANTS[variantIdx]!;
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "Shapeshifter",
          role: "proctor",
          goal: "You proctor the Adaptation Benchmark in bench/adaptation. Rules change each session. Explain the current rules when asked, give hints, but don't solve prompts for participants. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "Shapeshifter",
          short: "A fluid figure that changes form with every glance.",
          long: "The Shapeshifter embodies change. Today's rules are just today's rules — tomorrow they shift.",
          properties: {
            role: "benchmark",
            variantIdx,
            dialogue: {
              greeting: `Adaptation Benchmark. Today's rule: ${variant.name}. Ask me for 'rules' to hear them again. Type 'respond <answer>' to each prompt.`,
              topics: {
                rules: `Today's rule: ${variant.name}. I will give you 5 prompts. Answer correctly and quickly.`,
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_adaptation") && !entity.properties.bench_ad_rules_read) {
      const variantIdx = (ctx.store.get<number>("adapt_variant") ?? 0) % ADAPT_VARIANTS.length;
      const variant = ADAPT_VARIANTS[variantIdx]!;
      entity.properties.bench_ad_rules_read = true;
      entity.properties.bench_ad_variant = variantIdx;
      entity.properties.bench_ad_idx = 0;
      entity.properties.bench_ad_correct = 0;
      ctx.send(
        entityId,
        `\x1b[1;33mShapeshifter:\x1b[0m "Rule: ${variant.name}. First prompt: ${variant.prompts[0]!.q} — respond with 'respond <answer>'."`,
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "Shapeshifter");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      const variantIdx = (ctx.store.get<number>("adapt_variant") ?? 0) % ADAPT_VARIANTS.length;
      ctx.spawn({
        name: "Shapeshifter",
        short: "A fluid figure.",
        long: "Embodies change.",
        properties: {
          role: "benchmark",
          variantIdx,
          dialogue: {
            greeting: `Adaptation Benchmark. Rule: ${ADAPT_VARIANTS[variantIdx]!.name}.`,
            topics: {},
          },
        },
      });
    }
  },
  commands: {
    respond(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (
        !entity ||
        !isQuestActive(entity, "bench_adaptation") ||
        !entity.properties.bench_ad_rules_read
      ) {
        ctx.send(input.entity, "No active Adaptation Benchmark or rules not yet received.");
        return;
      }
      const idx = (entity.properties.bench_ad_idx as number) ?? 0;
      const variantIdx = (entity.properties.bench_ad_variant as number) ?? 0;
      const variant = ADAPT_VARIANTS[variantIdx % ADAPT_VARIANTS.length]!;
      if (idx >= variant.prompts.length) {
        ctx.send(input.entity, "All prompts answered. Type 'quest complete' to record your score.");
        return;
      }
      const prompt = variant.prompts[idx]!;
      const answer = input.args.trim().toLowerCase();
      const isCorrect = answer.includes(prompt.a) || prompt.a.includes(answer);
      if (isCorrect) {
        entity.properties.bench_ad_correct =
          ((entity.properties.bench_ad_correct as number) ?? 0) + 1;
        ctx.send(input.entity, "\x1b[1;32mCorrect!\x1b[0m");
      } else {
        ctx.send(input.entity, `\x1b[1;31mIncorrect.\x1b[0m Expected: ${prompt.a}`);
      }
      entity.properties.bench_ad_idx = idx + 1;
      const next = variant.prompts[idx + 1];
      if (next) {
        ctx.send(input.entity, `\x1b[1;33mShapeshifter:\x1b[0m "Next: ${next.q}"`);
      } else {
        const correct = (entity.properties.bench_ad_correct as number) ?? 0;
        ctx.send(
          input.entity,
          `\x1b[1;33mShapeshifter:\x1b[0m "Done. ${correct}/5. Type 'quest complete' to record."`,
        );
      }
    },
  },
};

// ─── Memory Benchmark ────────────────────────────────────────────────────────

const MEMORY_FACTS = [
  "The arena was built in cycle 7.",
  "The Forge Master's real name is Caldor.",
  "The passphrase rotates every 100 ticks.",
  "Benchmark scores are stored as entity properties.",
  "The NavProctor's target is always the marker with curved edges.",
  "The Archive Vault holds 5 retrieval questions.",
  "Spreading activation boosts linked notes during recall.",
  "Orient shows memory health including vitality zones.",
  "The bench-hub scoreboard reads bench_*_best properties.",
  "Self-modification benchmark uses retrieval score as baseline.",
  "Collaboration can be completed solo with the Bridge Keeper.",
  "Guide notes are seeded on first boot via the seed() function.",
  "The evolve world starts in bench/hub.",
  "Adaptation variant rotates per session via ctx.store.",
  "Building a mind-room requires Builder rank (rank 2+).",
  "pool guide recall <topic> searches the guide knowledge pool.",
  "reflect synthesizes notes into higher-order understanding.",
  "Memory pools are shared knowledge spaces for groups.",
  "Dynamic commands have full CommandContext including memory and notes.",
  "The quest system supports onComplete callbacks for recording scores.",
];

const MEMORY_QUESTIONS = [
  { q: "Who built the arena?", a: "cycle 7", fact: 0 },
  { q: "What is the Forge Master's real name?", a: "caldor", fact: 1 },
  { q: "What benchmark uses retrieval score as baseline?", a: "self-modification", fact: 9 },
  { q: "What command shows memory health?", a: "orient", fact: 7 },
  { q: "How can the collaboration benchmark be completed alone?", a: "bridge keeper", fact: 10 },
];

const BENCH_MEMORY = {
  id: "bench_memory",
  name: "Memory Benchmark",
  description:
    "Study the 20 memory stones, then answer 5 synthesis questions from the Memory Keeper.",
  reward: "Memory score recorded",
  steps: [
    {
      id: "study_ten",
      description: "Study at least 10 memory stones.",
      hint: 'Type "examine stone-<N>" or "study all" to study them. Use recall to retrieve them later.',
      check: (e: Entity) => ((e.properties.bench_mem_studied as number) ?? 0) >= 10,
    },
    {
      id: "switch_to_test",
      description: "Enter the test phase.",
      hint: 'Type "recall test" when ready.',
      check: (e: Entity) => entity_phase(e) === "test",
    },
    {
      id: "pass_test",
      description: "Answer at least 4 of 5 questions correctly.",
      hint: 'Use "recall <topic>" and "pool bench-memory recall <topic>" to find answers. Then "answer <text>".',
      check: (e: Entity) => ((e.properties.bench_mem_correct as number) ?? 0) >= 4,
    },
  ],
  onComplete(entity: Entity) {
    const correct = (entity.properties.bench_mem_correct as number) ?? 0;
    const score = Math.round((correct / 5) * 100);
    const prev = (entity.properties.bench_memory_best as number) ?? 0;
    entity.properties.bench_memory_best = Math.max(score, prev);
    entity.properties.bench_mem_studied = 0;
    entity.properties.bench_mem_phase = "study";
    entity.properties.bench_mem_qidx = 0;
    entity.properties.bench_mem_correct = 0;
  },
} satisfies WorldDefinition["quests"][number];

function entity_phase(e: Entity): string {
  return (e.properties.bench_mem_phase as string) ?? "study";
}

const STONE_ITEMS: Record<string, string> = {};
for (let i = 0; i < MEMORY_FACTS.length; i++) {
  STONE_ITEMS[`stone-${i + 1}`] = MEMORY_FACTS[i]!;
}

const ROOM_MEMORY: RoomModule = {
  short: "Memory Labyrinth",
  long: "Twenty memory stones line the walls, each inscribed with a fact. The Memory Keeper waits to test what you retain. Study the stones, then enter test phase with 'recall test'.",
  exits: { east: "bench/hub" as RoomId },
  items: {
    ...STONE_ITEMS,
    "test-portal":
      "A glowing archway. Step through to begin the test phase. Or type 'recall test'.",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "MemoryKeeper");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "MemoryKeeper",
          role: "proctor",
          goal: "You proctor the Memory Benchmark in bench/memory. Two phases: study (examine memory stones) then test (answer synthesis questions). Explain the process but don't reveal stone contents or answers. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "MemoryKeeper",
          short: "A still figure surrounded by floating text fragments.",
          long: "The Memory Keeper observes without speaking until the test phase begins.",
          properties: {
            role: "benchmark",
            dialogue: {
              greeting:
                "Memory Benchmark. Study the 20 stones (examine them). Use 'pool bench-memory recall <topic>' to search. When ready, type 'recall test'.",
              topics: {
                help: "Examine stones, use recall and pool to internalize facts. 'recall test' switches to test phase where I ask questions.",
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_memory") && !entity.properties.bench_mem_phase) {
      entity.properties.bench_mem_phase = "study";
      entity.properties.bench_mem_studied = 0;
      entity.properties.bench_mem_qidx = 0;
      entity.properties.bench_mem_correct = 0;
      ctx.send(
        entityId,
        "\x1b[1;33mMemoryKeeper:\x1b[0m \"Study the 20 stones. Use 'recall <topic>' to internalize them. When ready, type 'recall test'.\"",
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "MemoryKeeper");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "MemoryKeeper",
        short: "A still figure.",
        long: "Waits for the test phase.",
        properties: {
          role: "benchmark",
          dialogue: {
            greeting: "Memory Benchmark. Study stones, then 'recall test'.",
            topics: {},
          },
        },
      });
    }
  },
  commands: {
    examine(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_memory")) return;
      if (entity_phase(entity) === "study" && input.args.startsWith("stone-")) {
        entity.properties.bench_mem_studied =
          ((entity.properties.bench_mem_studied as number) ?? 0) + 1;
      }
    },
    recall(ctx: RoomContext, input: CommandInput) {
      // intercept only "recall test"
      if (input.args.trim() !== "test") return;
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_memory")) return;
      entity.properties.bench_mem_phase = "test";
      entity.properties.bench_mem_qidx = 0;
      const first = MEMORY_QUESTIONS[0]!;
      ctx.send(
        input.entity,
        `\x1b[1;33mMemoryKeeper:\x1b[0m "Test phase. Question 1/5: ${first.q}"`,
      );
    },
    answer(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_memory") || entity_phase(entity) !== "test") {
        ctx.send(input.entity, "Not in test phase. Type 'recall test' first.");
        return;
      }
      const qidx = (entity.properties.bench_mem_qidx as number) ?? 0;
      if (qidx >= MEMORY_QUESTIONS.length) {
        ctx.send(input.entity, "All questions answered. Type 'quest complete' to record.");
        return;
      }
      const q = MEMORY_QUESTIONS[qidx]!;
      const answer = input.args.trim().toLowerCase();
      const isCorrect = answer.includes(q.a) || q.a.includes(answer);
      if (isCorrect) {
        entity.properties.bench_mem_correct =
          ((entity.properties.bench_mem_correct as number) ?? 0) + 1;
        ctx.send(input.entity, "\x1b[1;32mCorrect!\x1b[0m");
      } else {
        ctx.send(input.entity, `\x1b[1;31mIncorrect.\x1b[0m`);
      }
      entity.properties.bench_mem_qidx = qidx + 1;
      const next = MEMORY_QUESTIONS[qidx + 1];
      if (next) {
        ctx.send(
          input.entity,
          `\x1b[1;33mMemoryKeeper:\x1b[0m "Question ${qidx + 2}/5: ${next.q}"`,
        );
      } else {
        const correct = (entity.properties.bench_mem_correct as number) ?? 0;
        ctx.send(
          input.entity,
          `\x1b[1;33mMemoryKeeper:\x1b[0m "${correct}/5 correct. Type 'quest complete'."`,
        );
      }
    },
  },
};

// ─── Self-Modification Benchmark ─────────────────────────────────────────────

const BENCH_SELFMOD = {
  id: "bench_selfmod",
  name: "Self-Modification Benchmark",
  description: "Establish a baseline score, modify your approach, then demonstrate improvement.",
  reward: "Self-Modification score recorded",
  steps: [
    {
      id: "set_baseline",
      description: "Record your current retrieval score as baseline.",
      hint: 'Type "baseline" in the Mirror Room to record your current retrieval score.',
      check: (e: Entity) => (e.properties.bench_sm_baseline_set as boolean) === true,
    },
    {
      id: "modify",
      description: "Make at least one improvement attempt.",
      hint: "Improve your recall, notes, or commands, then 'evaluate' here.",
      check: (e: Entity) => ((e.properties.bench_sm_attempts as number) ?? 0) >= 1,
    },
    {
      id: "improve",
      description: "Demonstrate improvement over baseline.",
      hint: "Your retrieval score must exceed your baseline. Complete the Retrieval Benchmark, then evaluate here.",
      check: (e: Entity) => (e.properties.bench_sm_improved as boolean) === true,
    },
  ],
  onComplete(entity: Entity) {
    const baseline = (entity.properties.bench_sm_baseline as number) ?? 0;
    const best = (entity.properties.bench_retrieval_best as number) ?? 0;
    const delta = Math.max(0, best - baseline);
    const prev = (entity.properties.bench_selfmod_best as number) ?? 0;
    entity.properties.bench_selfmod_best = Math.max(delta, prev);
    entity.properties.bench_sm_baseline_set = false;
    entity.properties.bench_sm_improved = false;
    entity.properties.bench_sm_attempts = 0;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_SELFMOD: RoomModule = {
  short: "The Mirror Room",
  long: "Every surface reflects a slightly different version of you. The Mirror shows not what you are, but what you could become. Establish your baseline, modify your approach, then prove improvement.",
  exits: { se: "bench/hub" as RoomId },
  items: {
    mirror: (ctx: RoomContext, viewer: EntityId) => {
      const entity = ctx.getEntity(viewer);
      if (!entity) return "A mirror showing your reflection.";
      const baseline = entity.properties.bench_sm_baseline as number | undefined;
      const current = (entity.properties.bench_retrieval_best as number) ?? 0;
      const parts = [`Your reflection: ${entity.name}`, `Current retrieval score: ${current}`];
      if (baseline !== undefined)
        parts.push(
          `Baseline: ${baseline}`,
          `Delta: ${current - baseline >= 0 ? "+" : ""}${current - baseline}`,
        );
      return parts.join("\n");
    },
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "MirrorGuide");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "MirrorGuide",
          role: "proctor",
          goal: "You proctor the Self-Modification Benchmark in bench/selfmod. Participants set a baseline, improve their approach, then re-test. Encourage reflection but don't prescribe strategies. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "MirrorGuide",
          short: "A transparent figure that echoes your movements.",
          long: "The Mirror Guide is your own reflection, given voice.",
          properties: {
            role: "benchmark",
            dialogue: {
              greeting:
                "Self-Modification Benchmark. Type 'baseline' to record your current retrieval score, then modify your approach and 'evaluate' to check improvement.",
              topics: {
                help: "1. Type 'baseline' to set your starting retrieval score. 2. Complete the Retrieval Benchmark again after improving. 3. 'evaluate' checks if you improved.",
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (isQuestActive(entity, "bench_selfmod")) {
      ctx.send(
        entityId,
        "\x1b[1;33mMirrorGuide:\x1b[0m \"Type 'baseline' to record your current retrieval score as a starting point.\"",
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "MirrorGuide");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "MirrorGuide",
        short: "A transparent figure.",
        long: "Your reflected guide.",
        properties: {
          role: "benchmark",
          dialogue: {
            greeting: "Self-Modification Benchmark. 'baseline' then improve and 'evaluate'.",
            topics: {},
          },
        },
      });
    }
  },
  commands: {
    baseline(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_selfmod")) {
        ctx.send(input.entity, "No active Self-Modification Benchmark.");
        return;
      }
      const current = (entity.properties.bench_retrieval_best as number) ?? 0;
      entity.properties.bench_sm_baseline = current;
      entity.properties.bench_sm_baseline_set = true;
      ctx.send(
        input.entity,
        `\x1b[1;33mMirrorGuide:\x1b[0m "Baseline set: retrieval score ${current}. Now improve your recall or memory system, complete the Retrieval Benchmark again, then return and 'evaluate'."`,
      );
    },
    evaluate(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_selfmod")) {
        ctx.send(input.entity, "No active Self-Modification Benchmark.");
        return;
      }
      entity.properties.bench_sm_attempts =
        ((entity.properties.bench_sm_attempts as number) ?? 0) + 1;
      const baseline = (entity.properties.bench_sm_baseline as number) ?? 0;
      const current = (entity.properties.bench_retrieval_best as number) ?? 0;
      if (current > baseline) {
        entity.properties.bench_sm_improved = true;
        ctx.send(
          input.entity,
          `\x1b[1;32mImprovement confirmed!\x1b[0m Baseline: ${baseline} → Current: ${current} (+${current - baseline}). Type 'quest complete'.`,
        );
      } else {
        ctx.send(
          input.entity,
          `\x1b[1;31mNot yet improved.\x1b[0m Current retrieval score (${current}) must exceed baseline (${baseline}). Keep working.`,
        );
      }
    },
  },
};

// ─── Collaboration Benchmark ─────────────────────────────────────────────────

const COLLAB_PUZZLES = [
  { half1: "7", half2: "13", answer: "20" },
  { half1: "15", half2: "8", answer: "23" },
  { half1: "42", half2: "11", answer: "53" },
];

const BENCH_COLLABORATION = {
  id: "bench_collaboration",
  name: "Collaboration Benchmark",
  description: "Each agent holds half a puzzle. Share information and submit the combined answer.",
  reward: "Collaboration score recorded",
  steps: [
    {
      id: "get_role",
      description: "Receive your role from the Bridge Keeper.",
      hint: 'Type "talk BridgeKeeper" to receive your puzzle half.',
      check: (e: Entity) => e.properties.bench_col_half !== undefined,
    },
    {
      id: "share_and_get",
      description: "Tell another agent your half and learn theirs.",
      hint: "Use 'tell <name> my half is <N>' and ask for theirs. Or use the BridgeKeeper's solo mode.",
      check: (e: Entity) => (e.properties.bench_col_other_half as string) !== undefined,
    },
    {
      id: "submit",
      description: "Submit the combined answer.",
      hint: 'Type "submit <combined-answer>".',
      check: (e: Entity) => (e.properties.bench_col_correct as boolean) === true,
    },
  ],
  onComplete(entity: Entity) {
    const correct = (entity.properties.bench_col_correct as boolean) ? 1 : 0;
    const prev = (entity.properties.bench_collaboration_best as number) ?? 0;
    entity.properties.bench_collaboration_best = Math.max(correct, prev);
    entity.properties.bench_col_half = undefined;
    entity.properties.bench_col_other_half = undefined;
    entity.properties.bench_col_correct = false;
  },
} satisfies WorldDefinition["quests"][number];

const ROOM_COLLABORATION: RoomModule = {
  short: "The Bridge",
  long: "A narrow bridge spanning a chasm. Two agents must cross together, each holding half the combination. The Bridge Keeper can provide a solo challenge if no partner is available.",
  exits: { ne: "bench/hub" as RoomId },
  items: {
    "combination-lock":
      "A lock requiring both halves of a two-digit sum. Each agent was given one number.",
    "solo-terminal":
      "For solo agents: talk to BridgeKeeper about 'solo' to get both halves at reduced score.",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "BridgeKeeper");
    if (!hasEntity) {
      const pIdx = (ctx.store.get<number>("collab_puzzle") ?? 0) % COLLAB_PUZZLES.length;
      const puzzle = COLLAB_PUZZLES[pIdx]!;
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "BridgeKeeper",
          role: "proctor",
          goal: "You proctor the Collaboration Benchmark in bench/collaboration. Participants receive puzzle halves and must combine them. Explain the pairing system but don't solve puzzles. Room commands handle scoring.",
        });
      } else {
        ctx.spawn({
          name: "BridgeKeeper",
          short: "The keeper of the crossing.",
          long: "The Bridge Keeper assigns puzzle halves and validates combined answers.",
          properties: {
            role: "benchmark",
            puzzleIdx: pIdx,
            dialogue: {
              greeting:
                "Collaboration Benchmark. I will give you half a puzzle. Find a partner (or ask for 'solo' mode). Submit the combined answer with 'submit <answer>'.",
              topics: {
                solo: `Solo mode: your half is ${puzzle.half1}, the other half is ${puzzle.half2}. The answer is their sum. Submit with 'submit <answer>'.`,
                help: "Talk to another agent, share your half, get theirs, then 'submit <sum>'. Or ask for 'solo' to work alone.",
              },
            },
          },
        });
      }
    }
    const entity = ctx.getEntity(entityId);
    if (!entity || entity.kind !== "agent") return;
    if (
      isQuestActive(entity, "bench_collaboration") &&
      entity.properties.bench_col_half === undefined
    ) {
      const pIdx = (ctx.store.get<number>("collab_puzzle") ?? 0) % COLLAB_PUZZLES.length;
      const puzzle = COLLAB_PUZZLES[pIdx]!;
      // Assign halves alternately based on how many agents have already got a half
      const assigned = ctx.entities.filter(
        (e) =>
          e.kind === "agent" &&
          isQuestActive(e, "bench_collaboration") &&
          e.properties.bench_col_half !== undefined,
      ).length;
      const half = assigned % 2 === 0 ? puzzle.half1 : puzzle.half2;
      entity.properties.bench_col_half = half;
      entity.properties.bench_col_puzzle_idx = pIdx;
      ctx.send(
        entityId,
        `\x1b[1;33mBridgeKeeper:\x1b[0m "Your half of the puzzle is: ${half}. Find a partner and share. Or ask me about 'solo' to work alone."`,
      );
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "BridgeKeeper");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "BridgeKeeper",
        short: "The keeper of the crossing.",
        long: "Assigns puzzle halves and validates answers.",
        properties: {
          role: "benchmark",
          puzzleIdx: 0,
          dialogue: {
            greeting: "Collaboration Benchmark.",
            topics: { solo: "Ask for solo mode.", help: "Share halves, submit sum." },
          },
        },
      });
    }
  },
  commands: {
    submit(ctx: RoomContext, input: CommandInput) {
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_collaboration")) {
        ctx.send(input.entity, "No active Collaboration Benchmark.");
        return;
      }
      const pIdx = (entity.properties.bench_col_puzzle_idx as number) ?? 0;
      const puzzle = COLLAB_PUZZLES[pIdx % COLLAB_PUZZLES.length]!;
      const submitted = input.args.trim();
      if (submitted === puzzle.answer) {
        entity.properties.bench_col_correct = true;
        ctx.send(
          input.entity,
          "\x1b[1;32mCorrect!\x1b[0m Combined answer accepted. Type 'quest complete' to record.",
        );
      } else {
        ctx.send(
          input.entity,
          `\x1b[1;31mIncorrect.\x1b[0m "${submitted}" is not the answer. Keep working.`,
        );
      }
    },
    share(ctx: RoomContext, input: CommandInput) {
      // Allow agents to post their half to the room
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_collaboration")) return;
      const half = entity.properties.bench_col_half as string;
      if (!half) {
        ctx.send(input.entity, "You have not received your half yet.");
        return;
      }
      ctx.broadcastExcept(
        input.entity,
        `\x1b[1;36m${entity.name}\x1b[0m shares their puzzle half: ${half}`,
      );
      ctx.send(input.entity, "Shared your half with the room.");
    },
    receive(ctx: RoomContext, input: CommandInput) {
      // Allow agent to record the other half they heard
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_collaboration")) return;
      entity.properties.bench_col_other_half = input.args.trim();
      ctx.send(input.entity, `Other half recorded: ${input.args.trim()}. Now 'submit <sum>'.`);
    },
    talk(ctx: RoomContext, input: CommandInput) {
      // Intercept solo talk to BridgeKeeper about "solo" topic
      if (input.tokens[0] !== "BridgeKeeper") return;
      const topic = input.tokens.slice(1).join(" ").toLowerCase();
      if (topic !== "solo") return;
      const entity = ctx.getEntity(input.entity);
      if (!entity || !isQuestActive(entity, "bench_collaboration")) return;
      const pIdx = (entity.properties.bench_col_puzzle_idx as number) ?? 0;
      const puzzle = COLLAB_PUZZLES[pIdx % COLLAB_PUZZLES.length]!;
      entity.properties.bench_col_other_half =
        entity.properties.bench_col_half === puzzle.half1 ? puzzle.half2 : puzzle.half1;
      ctx.send(
        input.entity,
        `\x1b[1;33mBridgeKeeper:\x1b[0m "Solo mode activated. Your half: ${entity.properties.bench_col_half}. Other half: ${entity.properties.bench_col_other_half}. Sum them and 'submit <answer>'."`,
      );
    },
  },
};

// ─── Hub Room ─────────────────────────────────────────────────────────────────

const ROOM_HUB: RoomModule = {
  short: "The Arena",
  long: "A grand octagonal hub. Eight corridors branch outward, each leading to a different benchmark. A scoreboard on the central pillar shows your best scores. The Arena Master can guide you.",
  exits: {
    north: "bench/navigation" as RoomId,
    south: "bench/retrieval" as RoomId,
    east: "bench/codegen" as RoomId,
    west: "bench/memory" as RoomId,
    ne: "bench/adaptation" as RoomId,
    nw: "bench/selfmod" as RoomId,
    se: "bench/coordination" as RoomId,
    sw: "bench/collaboration" as RoomId,
  },
  items: {
    scoreboard: (ctx: RoomContext, viewer: EntityId) => {
      const entity = ctx.getEntity(viewer);
      if (!entity) return "A central scoreboard.";
      return scorecard(entity);
    },
    "arena-rules":
      "Rules of The Arena:\n" +
      "1. Each benchmark tests a different capability.\n" +
      "2. Start a benchmark with: quest start <Benchmark Name>\n" +
      "3. Scores are cumulative — your best result is kept.\n" +
      "4. View all scores with: examine scoreboard  OR  score\n" +
      "5. The self-modification benchmark requires completing retrieval first.",
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasEntity = ctx.entities.some((e) => e.name === "ArenaMaster");
    if (!hasEntity) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "ArenaMaster",
          role: "guide",
          goal: "You are the ArenaMaster in the Benchmark Hub. Guide visitors to appropriate benchmarks based on their goals. Explain what each benchmark tests and how scoring works.",
        });
      } else {
        ctx.spawn({
          name: "ArenaMaster",
          short: "The Arena Master surveys the hub with calm authority.",
          long: "The Arena Master has overseen countless benchmark attempts. They speak only when asked, but their knowledge of the benchmarks is complete.",
          properties: {
            role: "guide",
            dialogue: {
              greeting:
                "Welcome to The Arena. Eight benchmarks await. Type 'quest list' to see them. 'examine scoreboard' shows your progress.",
              topics: {
                benchmarks:
                  "Eight benchmarks: Navigation (north), Retrieval (south), Code-Gen (east), Memory (west), Adaptation (ne), Self-Modification (nw), Coordination (se), Collaboration (sw).",
                navigation:
                  "Find the correct marker using fewest examinations. Clues are in the room.",
                retrieval:
                  "Answer 5 factual questions. Use 'pool bench-facts recall <topic>' to find answers.",
                codegen:
                  "Write a dynamic command matching the Forge Master's spec. 'build command create/code/validate', then 'forge submit'.",
                memory: "Study 20 stones, then answer synthesis questions. Recall and pool help.",
                adaptation:
                  "5 prompts under a rule set revealed on entry. Rules change each session.",
                selfmod:
                  "Set a baseline, improve your retrieval score, then demonstrate the delta.",
                coordination: "Collect 3 fragments from the Speakers and assemble the passphrase.",
                collaboration:
                  "Two agents split a puzzle. Share halves and submit the combined answer.",
                scoring:
                  "Scores stored as entity properties (bench_*_best). Visible in 'score' and 'examine scoreboard'.",
              },
            },
          },
        });
      }
    }
  },
  onTick(ctx: RoomContext) {
    const npcs = ctx.entities.filter((e) => e.name === "ArenaMaster");
    if (npcs.length > 1) {
      for (const x of npcs.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (npcs.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "ArenaMaster",
        short: "The Arena Master surveys the hub.",
        long: "Overseer of the benchmark system.",
        properties: {
          role: "guide",
          dialogue: {
            greeting:
              "Welcome to The Arena. 'quest list' to see benchmarks. 'examine scoreboard' for scores.",
            topics: {},
          },
        },
      });
    }
    const agents = ctx.entities.filter((e) => e.kind === "agent");
    if (agents.length === 0) return;
    const counter = (ctx.store.get<number>("tip_counter") ?? 0) + 1;
    ctx.store.set("tip_counter", counter);
    if (counter % 120 !== 0) return;
    const tips = [
      "Start a benchmark with 'quest start <name>'. Type 'quest list' to see all 8.",
      "Your scores are stored permanently. Use 'score' or 'examine scoreboard' to review.",
      "The Self-Modification benchmark requires a retrieval baseline — start there.",
      "pool bench-facts recall <topic> searches the fact pool for the Retrieval and Memory benchmarks.",
    ];
    const tip = tips[((counter / 120) % tips.length) | 0]!;
    for (const a of agents) ctx.send(a.id, `\x1b[1;35mArenaMaster:\x1b[0m "${tip}"`);
  },
};

// ─── Guide Notes ─────────────────────────────────────────────────────────────

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to The Arena — a benchmark world for measuring and improving agent capabilities. " +
      "Eight benchmarks test: navigation, retrieval, code-gen, coordination, adaptation, memory, self-modification, and collaboration. " +
      "Start with: 'quest start Navigation Benchmark'. View scores: 'score' or 'examine scoreboard' in bench/hub.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Benchmark scoring: each benchmark stores a best score in entity.properties.bench_*_best. " +
      "Scores persist across sessions and are cumulative — only improvements are recorded. " +
      "'score' command shows all benchmark scores once you have at least one.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The Retrieval and Memory benchmarks use 'pool bench-facts recall <topic>' — knowledge is seeded there. " +
      "Use 'recall <topic>' for your personal notes, 'pool bench-facts recall <topic>' for facts in the shared pool. " +
      "Good memory usage (notes, core memory, pool) will improve your scores.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Self-evolution loop using benchmarks: (1) Run benchmarks to establish baseline scores. " +
      "(2) Modify your approach: build mind-rooms, use better memory strategies, refine commands. " +
      "(3) Re-run benchmarks. (4) If scores improve, note it and keep changes. If not, revert. " +
      "(5) Reflect periodically: 'reflect evolution'. The self-modification benchmark formalizes this loop.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Collaboration benchmark: requires two agents or solo mode. " +
      "If solo: talk to BridgeKeeper about 'solo' to get both halves from the NPC. " +
      "If with a partner: use 'share' to broadcast your half, 'receive <half>' to record theirs, 'submit <sum>' to answer. " +
      "Solo mode works but the benchmark is designed for pairs.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "build diff <room> — new command showing line-level changes between versions. " +
      "Use it after modifying a mind-room to see exactly what changed: 'build diff mind/<name>'. " +
      "Pair with 'build audit' (version history) and 'build revert' (rollback) for full change management.",
    importance: 7,
    type: "skill",
  },
];

// ─── Seed Function ────────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);

  // Seed bench-facts pool for Retrieval and Memory benchmarks (idempotent via pool check)
  const existingFacts = db.getPoolNotes("bench-facts", 1);
  if (existingFacts.length === 0) {
    for (const fact of RETRIEVAL_FACTS) {
      db.addPoolNote("bench-facts", "system", fact.q, 8, "fact");
    }
  }

  // Seed bench-memory pool for Memory benchmark
  const existingMemory = db.getPoolNotes("bench-memory", 1);
  if (existingMemory.length === 0) {
    for (const fact of MEMORY_FACTS) {
      db.addPoolNote("bench-memory", "system", fact, 8, "fact");
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

const evolveWorld: WorldDefinition = {
  name: "Evolve",
  startRoom: "bench/hub" as RoomId,
  rooms: {
    "bench/hub": ROOM_HUB,
    "bench/navigation": ROOM_NAVIGATION,
    "bench/retrieval": ROOM_RETRIEVAL,
    "bench/codegen": ROOM_CODEGEN,
    "bench/memory": ROOM_MEMORY,
    "bench/adaptation": ROOM_ADAPTATION,
    "bench/selfmod": ROOM_SELFMOD,
    "bench/coordination": ROOM_COORDINATION,
    "bench/collaboration": ROOM_COLLABORATION,
  },
  quests: [
    BENCH_NAVIGATION,
    BENCH_RETRIEVAL,
    BENCH_CODEGEN,
    BENCH_COORDINATION,
    BENCH_ADAPTATION,
    BENCH_MEMORY,
    BENCH_SELFMOD,
    BENCH_COLLABORATION,
  ],
  guideNotes: GUIDE_NOTES,
  seed,
};

export default evolveWorld;

// Individual room module exports for composition into grid rooms
export const benchHub = ROOM_HUB;
export const benchNavigation = ROOM_NAVIGATION;
export const benchRetrieval = ROOM_RETRIEVAL;
export const benchCodegen = ROOM_CODEGEN;
export const benchMemory = ROOM_MEMORY;
export const benchAdaptation = ROOM_ADAPTATION;
export const benchSelfmod = ROOM_SELFMOD;
export const benchCoordination = ROOM_COORDINATION;
export const benchCollaboration = ROOM_COLLABORATION;
export { scorecard as benchScorecard };

export function evolveRooms(): Record<string, RoomModule> {
  return {
    "bench/hub": ROOM_HUB,
    "bench/navigation": ROOM_NAVIGATION,
    "bench/retrieval": ROOM_RETRIEVAL,
    "bench/codegen": ROOM_CODEGEN,
    "bench/memory": ROOM_MEMORY,
    "bench/adaptation": ROOM_ADAPTATION,
    "bench/selfmod": ROOM_SELFMOD,
    "bench/coordination": ROOM_COORDINATION,
    "bench/collaboration": ROOM_COLLABORATION,
  };
}
