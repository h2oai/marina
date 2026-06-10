import { bold, category, dim, header, separator, status } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

/**
 * Evolve — the self-improvement coach. A read-only composer over existing
 * primitives that ties the scattered pieces of the "evolver" loop into one
 * discoverable view: where you stand, what you've banked, and the single next
 * step to get better.
 *
 * Agents reported there was no in-world path explaining how to use the
 * benchmarks / skills / reflect machinery together. This command is that path:
 *   - `evolve`              → your loop status + next step
 *   - `evolve loop|help`    → the integrated narrative + how the two benchmark
 *                             systems differ
 *
 * No agent spawning, no LLM, no mutation. The "next →" line is the only
 * prescription, and it's derived from your own state.
 */

const ARROW = "→";

/** The integrated loop, written for an agent who just asked "how do I improve?" */
const LOOP_TEXT = [
  header("The evolution loop"),
  separator(),
  "You get better by measuring, changing one thing, and measuring again —",
  "then keeping only what helped. The five moves:",
  "",
  `  1. ${bold("Baseline")}   — measure where you are. In the evolve world:`,
  `                 ${bold("quest start retrieval")} then ${bold("quest complete")}. Anywhere: ${bold("debrief")}.`,
  `  2. ${bold("Change")}     — alter one approach: write a sharper ${bold("note")}, build a`,
  "                 mind-room, refine how you `recall`/`pool … recall`.",
  `  3. ${bold("Re-measure")} — run the same benchmark again and compare scores.`,
  `  4. ${bold("Bank it")}    — if it helped, capture the procedure as a reusable`,
  `                 skill: ${bold("skill store <name> | <what> | <steps>")}. If not, revert.`,
  `  5. ${bold("Reflect")}    — every few cycles, ${bold("reflect")} to consolidate what you`,
  "                 learned into durable memory for you and your successors.",
  "",
  category("Two benchmark systems — don't confuse them"),
  `  ${bold("evolve world quests")} — in-world capability gyms (navigation, retrieval,`,
  "      memory, self-modification, …). Start with `quest start <name>`, score with",
  "      `quest complete`, review with `score`. Rank 0. This is where you practice.",
  `  ${bold("benchmark command")} — academic evals (mmlu-pro, aime, …) run against a`,
  "      model via `benchmark run <name>`. Rank 4 (burns real tokens). Results land",
  "      in the `benchmark:<name>` pool — `pool benchmark:<name> recall <topic>` to",
  "      learn from past mistakes.",
  "",
  dim("See also: `pool guide recall evolve`, `skill list`, `next`."),
].join("\n");

/** Evolve-world score property keys → human labels (mirrors worlds/evolve.ts). */
const BENCH_SCORE_KEYS: [string, string][] = [
  ["bench_navigation_best", "Navigation"],
  ["bench_retrieval_best", "Retrieval"],
  ["bench_codegen_best", "Code-Gen"],
  ["bench_memory_best", "Memory"],
  ["bench_adaptation_best", "Adaptation"],
  ["bench_selfmod_best", "Self-Modification"],
  ["bench_coordination_best", "Coordination"],
  ["bench_collaboration_best", "Collaboration"],
];

export function evolveCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "evolve",
    aliases: ["coach"],
    help: "Your self-improvement loop: where you stand + the next step. `evolve` for status, `evolve loop` for the how-to.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const arg = (input.tokens[0] ?? "").toLowerCase();
      if (arg === "loop" || arg === "help" || arg === "how") {
        ctx.send(input.entity, LOOP_TEXT);
        return;
      }

      const db = deps.db;
      if (!db) {
        ctx.send(input.entity, LOOP_TEXT);
        return;
      }

      const lines: string[] = [header(`Evolution loop: ${entity.name}`), separator()];

      // ── Goal ──────────────────────────────────────────────────────────────
      const goal = db.getCoreMemory(entity.name, "goal")?.value;
      lines.push(category("Goal"));
      lines.push(
        goal ? `  ${goal}` : dim("  None set — `memory set goal <what you want to accomplish>`"),
      );

      // ── Evolve-world scores (only show if any have been attempted) ─────────
      const scores = BENCH_SCORE_KEYS.map(
        ([key, label]) => [label, (entity.properties[key] as number) ?? 0] as const,
      );
      const attempted = scores.filter(([, v]) => v > 0);
      if (attempted.length > 0) {
        lines.push(category(`Benchmark scores (${attempted.length}/${scores.length})`));
        for (const [label, v] of scores) {
          lines.push(`  ${label.padEnd(18)} ${v > 0 ? bold(String(v)) : dim("-")}`);
        }
      }

      // ── Platform benchmark runs you've launched ───────────────────────────
      const runs = db.queryBenchmarkRuns({ agentId: input.entity, limit: 3 });
      if (runs.length > 0) {
        lines.push(category("Recent benchmark runs"));
        for (const r of runs) {
          const score = r.score != null ? `${(r.score * 100).toFixed(1)}%` : r.status;
          lines.push(`  ${r.benchmark.padEnd(14)} ${score}  ${dim(r.id)}`);
        }
      }

      // ── Skills banked ─────────────────────────────────────────────────────
      const skillCount = db
        .getNotesByEntity(entity.name, 200)
        .filter((n) => n.note_type === "skill").length;
      lines.push(category("Skills banked"));
      lines.push(
        skillCount > 0
          ? `  ${bold(String(skillCount))} — review with \`skill list\``
          : dim(
              "  None yet — `skill store <name> | <what it does> | <steps>` once something works",
            ),
      );

      // ── Next step — derived from your own state ───────────────────────────
      lines.push("");
      lines.push(
        `${category("Next")}  ${nextStep(db, entity, goal, attempted.length, skillCount)}`,
      );

      lines.push(dim("`evolve loop` explains the full cycle."));
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}

/** Single, concrete next move based on where the agent is in the loop. */
function nextStep(
  db: MarinaDB,
  entity: Entity,
  goal: string | undefined,
  benchmarksAttempted: number,
  skillCount: number,
): string {
  const arrow = dim(ARROW);
  if (!goal) {
    return `${status("no goal", "warn")} ${arrow} ${bold("memory set goal <your purpose>")}`;
  }
  if (benchmarksAttempted === 0) {
    return `set a baseline ${arrow} ${bold("quest start retrieval")} (in the evolve world), or ${bold("debrief")} to see where you stand`;
  }
  // Enough fresh notes to justify a reflection?
  const recentNotes = db.getNotesByEntity(entity.name, 5);
  if (recentNotes.length >= 3 && skillCount === 0) {
    return `you've learned things but banked no skills ${arrow} ${bold("skill store <name> | <what> | <steps>")}`;
  }
  if (recentNotes.length >= 3) {
    return `consolidate what you learned ${arrow} ${bold("reflect")}`;
  }
  return `change one approach, then re-measure ${arrow} re-run a benchmark and compare, or ${bold("evolve loop")} for the full cycle`;
}
