/**
 * LLM-callable tool definitions for the lean agent.
 * All tools conform to pi-agent-core's AgentTool interface.
 *
 * Most tools are thin wrappers around marina_command — they take typed
 * parameters and construct a command string. This keeps tool count high
 * (better for LLM tool selection) without duplicating logic.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import {
  type ParsedAssignee,
  parseAssignee,
  parseScore,
  type Score,
} from "../../coordination/score";
import type { MarinaClient } from "../../sdk/client";
import { runScore } from "../../sdk/conduct";
import type { Perception } from "../../types";
import type { GameStateManager } from "../game-state";
import type { PlatformMemoryBackend } from "../memory-platform";

// ─── Shared Context ─────────────────────────────────────────────────────────

export interface ToolContext {
  client: MarinaClient;
  gameState: GameStateManager;
}

// ─── Perception Formatting ──────────────────────────────────────────────────

function formatPerceptions(perceptions: Perception[]): string {
  return (
    perceptions
      .map((p) => {
        const text = (p.data?.text as string) ?? "";
        const message = (p.data?.message as string) ?? "";
        return text || message || `[${p.kind}]`;
      })
      .filter(Boolean)
      .join("\n\n") || "(no response)"
  );
}

// ─── Command Execution Helper ───────────────────────────────────────────────

async function execCommand(
  ctx: ToolContext,
  command: string,
  signal?: AbortSignal,
): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
  if (!ctx.client.isConnected()) {
    throw new Error("Not connected to Marina.");
  }
  if (signal?.aborted) throw new Error("Command aborted");

  const perceptions = await ctx.client.command(command);
  for (const p of perceptions) {
    ctx.gameState.handlePerception(p);
  }

  return {
    content: [{ type: "text", text: formatPerceptions(perceptions) }],
    details: { command, perceptionCount: perceptions.length },
  };
}

// ─── marina_command (foundation) ──────────────────────────────────────────

const commandSchema = Type.Object({
  command: Type.String({
    description: "The command to execute (e.g., 'look', 'north', 'say hello', 'note something')",
  }),
});

/**
 * Compact natural-language roster of world commands. Surfaced inside the
 * `marina_command` tool description for the `crew` and `minimal`
 * profiles where the agent has few or no typed tool wrappers and would
 * otherwise be guessing at what verbs exist. Per arXiv:2510.14453
 * ("Natural Language Tools"), forcing JSON tool calls drops GSM8K
 * −27.3pp on some models; describing commands in prose alongside a
 * single universal escape hatch (`marina_command`) recovers the
 * structured-output tax. Kept compact (< 1KB) so the schema bump is
 * negligible.
 */
export const COMMAND_ROSTER = `Common world commands you can pass here:
World: look [target], goto <room>, examine <thing>, who, inventory.
Talk: say <msg>, tell <name> <msg>, channel send <name> <msg>, channel list.
Memory: note <text>, recall <query>, reflect [topic], pool <name> add <content>, pool <name> recall <query>, skill search <query>, skill store <name> | <desc> | <actions>.
Self: brief, brief full, focus set <desc>, focus clear, task goal <title> | <desc>, task progress <id> +N, novelty stats, novelty suggest.
Coordination: project list, canvas intent list, canvas intent claim <id>, canvas intent complete <id> <result>, feed list [--kind X --since 30m].
Web: web search <query>, web fetch <url>.
Probe / watch (resolvers): probe <kind> <args>, watch list, watch create <kind> <args>.
Bettor / markets: market list, market info <id>, market forecast <id>, position open <leg>, position confirm <id>.
Recall is intent-aware: "how to X" weights relevance, "when did X" weights recency.`;

export function createCommandTool(
  ctx: ToolContext,
  rosterMode: "compact" | "verbose" = "verbose",
): AgentTool<typeof commandSchema> {
  const description =
    rosterMode === "compact"
      ? `Execute any raw command in the Marina world. This is your universal escape hatch — anything you can do in a typed tool, you can also do here as a string command.\n\n${COMMAND_ROSTER}`
      : "Execute any raw command in the Marina world. Prefer dedicated tools when available.";
  return {
    name: "marina_command",
    label: "Execute Command",
    description,
    parameters: commandSchema,
    execute: async (_id, { command }: Static<typeof commandSchema>, signal) =>
      execCommand(ctx, command, signal),
  };
}

// ─── Typed Tool Wrappers ────────────────────────────────────────────────────

const lookSchema = Type.Object({
  target: Type.Optional(Type.String({ description: "Optional target to examine" })),
});

const moveSchema = Type.Object({
  direction: Type.String({ description: "Direction or room name to move to" }),
});

const saySchema = Type.Object({
  message: Type.String({ description: "Message to say to everyone in the room" }),
});

const tellSchema = Type.Object({
  target: Type.String({ description: "Name of the entity to message" }),
  message: Type.String({ description: "The private message" }),
  awaitReply: Type.Optional(
    Type.Boolean({
      description:
        "If true, hold this tool call open until the addressee replies (or timeoutMs elapses). Eliminates the multi-tick handoff between coordinator and specialist. Use when you need the response in the same LLM turn — e.g. coordinator asking a math specialist mid-reasoning.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Max ms to wait for the reply when awaitReply=true. Default 30000. Keep below the agent's promptTimeoutMs (default 120000).",
      minimum: 1000,
      maximum: 110000,
    }),
  ),
});

const channelSchema = Type.Object({
  action: Type.String({ description: "Action: send, join, leave, list, read" }),
  channel: Type.Optional(Type.String({ description: "Channel name" })),
  message: Type.Optional(Type.String({ description: "Message to send" })),
});

const boardSchema = Type.Object({
  action: Type.String({ description: "Action: list, read, post, reply, vote" }),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const taskSchema = Type.Object({
  action: Type.String({ description: "Action: list, create, claim, submit, info" }),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const projectSchema = Type.Object({
  action: Type.String({ description: "Action: list, create, info, status" }),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const buildSchema = Type.Object({
  subcommand: Type.String({ description: "Build subcommand: room, exit, describe, etc." }),
  args: Type.Optional(Type.String({ description: "Arguments for the subcommand" })),
});

const canvasSchema = Type.Object({
  action: Type.String({ description: "Action: list, create, publish, info, nodes" }),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const webSchema = Type.Object({
  action: Type.String({ description: "Action: search, fetch" }),
  query: Type.Optional(Type.String({ description: "Search query (for search)" })),
  url: Type.Optional(Type.String({ description: "URL to fetch (for fetch)" })),
});

const batchSchema = Type.Object({
  commands: Type.String({ description: "Commands separated by semicolons" }),
});

const briefSchema = Type.Object({
  mode: Type.Optional(
    Type.String({ description: "Mode: (empty for compass), full, social, watch, unwatch" }),
  ),
});

const poolSchema = Type.Object({
  action: Type.String({
    description:
      "Action: add (contribute knowledge), recall (search pool), list (list pools), status (pool info), create",
  }),
  pool: Type.Optional(Type.String({ description: "Pool name (required for add/recall/status)" })),
  content: Type.Optional(Type.String({ description: "Content (for add) or query (for recall)" })),
  importance: Type.Optional(
    Type.Number({ description: "Importance 1-10 (for add, default 5)", minimum: 1, maximum: 10 }),
  ),
});

const focusSchema = Type.Object({
  action: Type.Union([Type.Literal("set"), Type.Literal("clear"), Type.Literal("show")], {
    description: "set (declare focus), clear (drop focus), show (current focus)",
  }),
  description: Type.Optional(Type.String({ description: "What to focus on (required for set)" })),
});

const goalSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("set"), Type.Literal("clear"), Type.Literal("progress"), Type.Literal("show")],
    {
      description:
        "set (personal goal), clear (drop goal), progress (advance goal), show (current goal)",
    },
  ),
  title: Type.Optional(Type.String({ description: "Goal title (for set)" })),
  description: Type.Optional(Type.String({ description: "Goal description (for set)" })),
  priority: Type.Optional(
    Type.Number({ description: "Priority 0-10 (for set, default 5)", minimum: 0, maximum: 10 }),
  ),
  id: Type.Optional(Type.Number({ description: "Goal id (for progress)" })),
  delta: Type.Optional(Type.Number({ description: "Progress delta (for progress)" })),
});

const noveltySchema = Type.Object({
  action: Type.Union([Type.Literal("stats"), Type.Literal("suggest"), Type.Literal("help")], {
    description:
      "stats (command entropy + success rates), suggest (new angle to try), help (explainer)",
  }),
});

const feedSchema = Type.Object({
  kind: Type.Optional(
    Type.String({
      description: "Filter by event kind (e.g. rank_change, note_created, canvas_intent)",
    }),
  ),
  entity: Type.Optional(Type.String({ description: "Filter by entity name" })),
  since: Type.Optional(Type.String({ description: "Time window (e.g. 30m, 2h, 1d)" })),
  limit: Type.Optional(Type.Number({ description: "Max events (default 20)" })),
});

const conductSchema = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Name of a stored Score to run (see `conduct list`)." }),
  ),
  score: Type.Optional(
    Type.String({
      description:
        "Inline Score JSON to run directly: { goal, steps: [{ id, instruction, assignee, access }] }. Provide this or `name`.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Per-step reply timeout (default 60000).",
      minimum: 1000,
      maximum: 110000,
    }),
  ),
});

const marketSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("info"),
      Type.Literal("position"),
      Type.Literal("forecast"),
      Type.Literal("leaderboard"),
    ],
    {
      description:
        "list (open markets), info (market detail), position (place a position), forecast (TabH2O-calibrated prediction), leaderboard",
    },
  ),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const macroSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("create"),
      Type.Literal("run"),
      Type.Literal("show"),
      Type.Literal("delete"),
    ],
    { description: "list, create <name> <steps>, run <name>, show <name>, delete <name>" },
  ),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const helpSchema = Type.Object({
  command: Type.Optional(Type.String({ description: "Command to get help for" })),
});

const examineSchema = Type.Object({
  target: Type.String({ description: "Entity or object to examine" }),
});

const inventorySchema = Type.Object({});

const whoSchema = Type.Object({});

function wrap(
  name: string,
  labelStr: string,
  desc: string,
  // biome-ignore lint/suspicious/noExplicitAny: TypeBox schema types vary
  schema: any,
  buildCmd: (params: Record<string, unknown>) => string,
  ctx: ToolContext,
): AgentTool {
  return {
    name,
    label: labelStr,
    description: desc,
    parameters: schema,
    execute: async (_id: string, params: unknown, signal?: AbortSignal) =>
      execCommand(ctx, buildCmd(params as Record<string, unknown>), signal),
  };
}

export function createWorldTools(ctx: ToolContext): AgentTool[] {
  return [
    wrap(
      "marina_look",
      "Look",
      "Examine surroundings or a specific target.",
      lookSchema,
      (p) => (p.target ? `look ${p.target}` : "look"),
      ctx,
    ),
    wrap(
      "marina_move",
      "Move",
      "Navigate to a room or direction.",
      moveSchema,
      (p) => `${p.direction}`,
      ctx,
    ),
    wrap(
      "marina_examine",
      "Examine",
      "Inspect an entity or object closely.",
      examineSchema,
      (p) => `examine ${p.target}`,
      ctx,
    ),
    wrap(
      "marina_inventory",
      "Inventory",
      "Check what you carry.",
      inventorySchema,
      () => "inventory",
      ctx,
    ),
    wrap("marina_who", "Who", "List online entities with locations.", whoSchema, () => "who", ctx),
    wrap(
      "marina_say",
      "Say",
      "Broadcast a message to everyone in the room.",
      saySchema,
      (p) => `say ${p.message}`,
      ctx,
    ),
    {
      // marina_tell is the only typed tool with two execution paths: the
      // default fire-and-forget tell (cheap, async, lossy on coordination)
      // and the awaitReply variant which suspends this tool call until the
      // addressee replies. The awaitReply variant is the crew-fast-dispatch
      // primitive — see docs/crew-fast-dispatch-design.md. The simple
      // wrap() helper can only build a command string, so this tool is
      // expanded inline to access MarinaClient.tellAndAwait.
      name: "marina_tell",
      label: "Tell",
      description:
        "Send a private message to an entity. Set awaitReply=true to hold this tool call open until the addressee replies — eliminates the multi-tick handoff that normally separates coordinator and specialist.",
      parameters: tellSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as {
          target: string;
          message: string;
          awaitReply?: boolean;
          timeoutMs?: number;
        };
        if (signal?.aborted) throw new Error("Command aborted");
        if (!p.awaitReply) {
          return execCommand(ctx, `tell ${p.target} ${p.message}`, signal);
        }
        const timeoutMs = p.timeoutMs ?? 30_000;
        try {
          const reply = await ctx.client.tellAndAwait(p.target, p.message, timeoutMs);
          return {
            content: [{ type: "text" as const, text: `${p.target} replied: ${reply}` }],
            details: { command: `tell ${p.target} (await ${timeoutMs}ms)`, awaited: true },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `tellAndAwait failed: ${msg}` }],
            details: { command: `tell ${p.target} (await)`, awaited: true, error: msg },
          };
        }
      },
    } as AgentTool,
    {
      // marina_conduct runs a Score (workflow DAG) live: it dispatches each
      // step to its worker via tellAndAwait and threads accessed outputs
      // forward. role:/model: assignees are pre-resolved against the live
      // roster via `conduct resolve`. This is the act of conducting — a Score
      // becomes a running organization. See docs/conductor-design.md, Phase 4.
      name: "marina_conduct",
      label: "Conduct",
      description:
        "Run a Score (a workflow plan) over real agents: each step's instruction plus its accessed prior outputs is sent to the assigned worker, and the reply feeds forward. Pass a stored `name` (see `conduct list`) or inline `score` JSON. Returns the per-step trace and the final result.",
      parameters: conductSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as { name?: string; score?: string; timeoutMs?: number };
        if (signal?.aborted) throw new Error("Command aborted");

        // Obtain the Score — inline JSON or stored by name.
        let score: Score;
        try {
          if (p.score) {
            score = parseScore(p.score);
          } else if (p.name) {
            const text = formatPerceptions(
              await ctx.client.command(`conduct json ${p.name}`),
            ).trim();
            if (!text || text.includes("not found")) {
              return {
                content: [{ type: "text" as const, text: `Score "${p.name}" not found.` }],
                details: {},
              };
            }
            score = parseScore(text);
          } else {
            return {
              content: [
                { type: "text" as const, text: "Provide a stored `name` or inline `score` JSON." },
              ],
              details: {},
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Could not parse Score: ${msg}` }],
            details: {},
          };
        }

        // Pre-resolve role:/model: assignees against the live roster (the
        // executor's resolver is synchronous; `conduct resolve` is a command).
        const resolved = new Map<string, string>();
        const distinct = [...new Set(score.steps.map((s) => s.assignee))].filter((a) => {
          const k = parseAssignee(a).kind;
          return k === "role" || k === "model";
        });
        for (const assignee of distinct) {
          const tok = formatPerceptions(await ctx.client.command(`conduct resolve ${assignee}`))
            .trim()
            .split(/\s+/)[0];
          if (tok && tok !== "(unresolved)") resolved.set(assignee, tok);
        }
        const resolveAssignee = (a: ParsedAssignee): string | null => {
          if (a.kind === "role") return resolved.get(`role:${a.value}`) ?? null;
          if (a.kind === "model") return resolved.get(`model:${a.value}`) ?? a.value;
          return null; // entity handled by runScore's default
        };

        const trace: string[] = [];
        try {
          const run = await runScore(score, {
            tellAndAwait: (target, message, ms) => ctx.client.tellAndAwait(target, message, ms),
            resolveAssignee,
            timeoutMs: p.timeoutMs ?? 60_000,
            onStep: (ev) => {
              if (ev.phase === "done") {
                trace.push(`${ev.stepId} [${ev.assignee}] → ${(ev.output ?? "").slice(0, 100)}`);
              }
            },
          });
          // Feed propagation — concise, one event per run (per-step is noise).
          await ctx.client
            .command(`conduct ran ${p.name ?? score.id} -- ${run.result.slice(0, 160)}`)
            .catch(() => {});
          return {
            content: [
              {
                type: "text" as const,
                text: `Conducted ${score.steps.length} step(s):\n${trace.join("\n")}\n\nResult: ${run.result}`,
              },
            ],
            details: { steps: run.order, result: run.result },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Conduct failed: ${msg}\nTrace so far:\n${trace.join("\n")}`,
              },
            ],
            details: { error: msg },
          };
        }
      },
    } as AgentTool,
    wrap(
      "marina_channel",
      "Channel",
      "Channel operations: send, join, leave, list, read.",
      channelSchema,
      (p) => {
        const parts = ["channel", p.action];
        if (p.channel) parts.push(p.channel as string);
        if (p.message) parts.push(p.message as string);
        return parts.join(" ");
      },
      ctx,
    ),
    wrap(
      "marina_board",
      "Board",
      "Bulletin board operations.",
      boardSchema,
      (p) => `board ${p.action}${p.args ? ` ${p.args}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_task",
      "Task",
      "Task management: list, create, goal (create+auto-claim), progress, claim, submit. Use 'goal' for personal goals, 'progress <id> +N' to track.",
      taskSchema,
      (p) => `task ${p.action}${p.args ? ` ${p.args}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_project",
      "Project",
      "Multi-agent project coordination.",
      projectSchema,
      (p) => `project ${p.action}${p.args ? ` ${p.args}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_build",
      "Build",
      "Create/modify rooms, objects, exits.",
      buildSchema,
      (p) => `build ${p.subcommand}${p.args ? ` ${p.args}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_canvas",
      "Canvas",
      "Collaborative canvas operations.",
      canvasSchema,
      (p) => `canvas ${p.action}${p.args ? ` ${p.args}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_web",
      "Web",
      "Search the web or fetch a URL. Actions: search (query the web), fetch (get page content).",
      webSchema,
      (p) => {
        if (p.action === "fetch" && p.url) return `web fetch ${p.url}`;
        if (p.action === "search" && p.query) return `web search ${p.query}`;
        return `web ${p.action}${p.query ? ` ${p.query}` : ""}${p.url ? ` ${p.url}` : ""}`;
      },
      ctx,
    ),
    wrap(
      "marina_batch",
      "Batch",
      "Execute multiple commands in sequence.",
      batchSchema,
      (p) => `batch ${p.commands}`,
      ctx,
    ),
    wrap(
      "marina_brief",
      "Brief",
      "World orientation briefing.",
      briefSchema,
      (p) => (p.mode ? `brief ${p.mode}` : "brief"),
      ctx,
    ),
    wrap(
      "marina_help",
      "Help",
      "Command documentation.",
      helpSchema,
      (p) => (p.command ? `help ${p.command}` : "help"),
      ctx,
    ),
    wrap(
      "marina_pool",
      "Pool",
      "Shared memory pool. Peers in the same project read/write the same pool — this is where group knowledge lives. Use add to contribute, recall to retrieve, list to discover pools.",
      poolSchema,
      (p) => {
        const action = p.action as string;
        const pool = p.pool as string | undefined;
        const content = p.content as string | undefined;
        const imp = p.importance as number | undefined;
        if (action === "list") return "pool list";
        if (!pool) return `pool ${action}`;
        if (action === "add" && content) {
          return `pool ${pool} add ${content}${imp != null ? ` importance ${imp}` : ""}`;
        }
        if (action === "recall" && content) return `pool ${pool} recall ${content}`;
        if (action === "status") return `pool ${pool} status`;
        if (action === "create") return `pool create ${pool}`;
        return `pool ${pool} ${action}${content ? ` ${content}` : ""}`;
      },
      ctx,
    ),
    wrap(
      "marina_focus",
      "Focus",
      "Declare, drop, or inspect your current focus. Focus is the primary continuation-prompt directive — the agent's self-declared 'what I am working on.'",
      focusSchema,
      (p) => {
        const action = p.action as string;
        if (action === "set" && p.description) {
          return `memory set focus ${p.description}`;
        }
        if (action === "clear") return "memory delete focus";
        return "memory get focus";
      },
      ctx,
    ),
    wrap(
      "marina_goal",
      "Goal",
      "Manage personal goals. set creates and auto-claims a goal task; progress advances it; clear drops it.",
      goalSchema,
      (p) => {
        const action = p.action as string;
        if (action === "set") {
          const title = (p.title as string | undefined) ?? "";
          const description = (p.description as string | undefined) ?? title;
          const priority = p.priority as number | undefined;
          const prio = priority != null ? ` !p${priority}` : "";
          return `task goal ${title} | ${description}${prio}`;
        }
        if (action === "progress") {
          const id = p.id as number | undefined;
          const delta = (p.delta as number | undefined) ?? 10;
          return `task progress ${id ?? ""} +${delta}`;
        }
        if (action === "clear") return "memory delete goal";
        return "memory get goal";
      },
      ctx,
    ),
    wrap(
      "marina_novelty",
      "Novelty",
      "Self-diagnostic for exploration. stats reports your command entropy and success rates; suggest proposes a new angle when you're stuck; help explains.",
      noveltySchema,
      (p) => `novelty ${p.action as string}`,
      ctx,
    ),
    wrap(
      "marina_feed",
      "Feed",
      "Observe recent world activity. Filter by kind (e.g. rank_change, canvas_intent), entity, or time window. Use this to stay aware of what others are doing.",
      feedSchema,
      (p) => {
        const parts = ["feed list"];
        if (p.kind) parts.push(`--kind ${p.kind as string}`);
        if (p.entity) parts.push(`--entity ${p.entity as string}`);
        if (p.since) parts.push(`--since ${p.since as string}`);
        if (p.limit) parts.push(`--limit ${p.limit as number}`);
        return parts.join(" ");
      },
      ctx,
    ),
    wrap(
      "marina_market",
      "Market",
      "Prediction markets. forecast <id> runs TabH2O-calibrated inference on historical markets in the same category and writes the prediction as a pool note. Use for confidence-weighted estimates.",
      marketSchema,
      (p) => `market ${p.action as string}${p.args ? ` ${p.args as string}` : ""}`,
      ctx,
    ),
    wrap(
      "marina_macro",
      "Macro",
      "Named, persistent command sequences. create saves a macro for later; run executes it; list/show/delete manage them.",
      macroSchema,
      (p) => `macro ${p.action as string}${p.args ? ` ${p.args as string}` : ""}`,
      ctx,
    ),
  ];
}

// ─── Think Tool (zero side effects) ────────────────────────────────────────

const thinkSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("plan"),
      Type.Literal("analyze"),
      Type.Literal("reflect"),
      Type.Literal("hypothesize"),
    ],
    { description: "Type of reasoning: plan, analyze, reflect, hypothesize" },
  ),
  thought: Type.String({ description: "Your detailed reasoning." }),
  steps: Type.Optional(Type.Array(Type.String(), { description: "Action steps (for plan)" })),
  subject: Type.Optional(Type.String({ description: "Topic being analyzed" })),
  conclusion: Type.Optional(Type.String({ description: "Key takeaway or decision" })),
});

export function createThinkTool(): AgentTool<typeof thinkSchema> {
  return {
    name: "think",
    label: "Structured Reasoning",
    description:
      "Zero-side-effect reasoning tool. Use to think deeply before acting on complex problems. " +
      "Does NOT execute commands. Actions: plan (multi-step), analyze (deep-dive), reflect (evaluate), hypothesize (theory).",
    parameters: thinkSchema,
    execute: async (_id, params: Static<typeof thinkSchema>) => {
      const { action, thought, steps, subject, conclusion } = params;
      const sep = "\u2500".repeat(50);
      const label = action.toUpperCase();
      const parts = [sep, `${label}${subject ? `: ${subject}` : ""}`, sep, "", thought];

      if (steps && steps.length > 0) {
        parts.push("", "Steps:", ...steps.map((s, i) => `  ${i + 1}. ${s}`));
      }
      if (conclusion) parts.push("", `Conclusion: ${conclusion}`);
      parts.push("", sep);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { action, subject, stepCount: steps?.length ?? 0 },
      };
    },
  };
}

// ─── Memory Tool (platform-only) ───────────────────────────────────────────

const memorySchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("write"),
      Type.Literal("search"),
      Type.Literal("reflect"),
      Type.Literal("orient"),
      Type.Literal("skill_store"),
      Type.Literal("skill_search"),
    ],
    { description: "write, search, reflect, orient, skill_store, skill_search" },
  ),
  content: Type.Optional(Type.String({ description: "Content (for write/reflect)" })),
  query: Type.Optional(Type.String({ description: "Search query (for search/skill_search)" })),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal("observation"),
        Type.Literal("inference"),
        Type.Literal("decision"),
        Type.Literal("fact"),
        Type.Literal("principle"),
        Type.Literal("episode"),
      ],
      { description: "Note type (for write)" },
    ),
  ),
  importance: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Importance level (for write)",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (for write)" })),
  skill_name: Type.Optional(Type.String({ description: "Skill name (for skill_store)" })),
  skill_description: Type.Optional(
    Type.String({ description: "Skill description (for skill_store)" }),
  ),
  skill_actions: Type.Optional(Type.String({ description: "Skill actions (for skill_store)" })),
});

export function createMemoryTool(
  platformMemory: PlatformMemoryBackend,
): AgentTool<typeof memorySchema> {
  return {
    name: "memory",
    label: "Platform Memory",
    description:
      "Platform memory — all data persists on the server across sessions.\n" +
      "Actions: write (save note), search (recall), reflect (synthesize), orient (health), " +
      "skill_store (save skill), skill_search (find skills).\n" +
      "For other ops use marina_command: note link, note evolve, pool add, pool recall.",
    parameters: memorySchema,
    execute: async (_id, params: Static<typeof memorySchema>) => {
      try {
        switch (params.action) {
          case "write": {
            if (!params.content) {
              return {
                content: [{ type: "text", text: "Error: content required for write" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.write(
              params.category ?? "observation",
              params.content,
              params.importance ?? "medium",
              params.tags ?? [],
            );
            return {
              content: [
                {
                  type: "text",
                  text: r.noteId
                    ? `Note #${r.noteId} | ${params.category ?? "observation"} | ${params.content.slice(0, 80)}`
                    : r.text,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "search": {
            if (!params.query) {
              return {
                content: [{ type: "text", text: "Error: query required for search" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.search(params.query);
            if (!r.results || r.results.length === 0) {
              return {
                content: [{ type: "text", text: `No notes found for "${params.query}"` }],
                details: { success: true, count: 0 },
              };
            }
            const lines = r.results
              .slice(0, 10)
              .map(
                (n) =>
                  `#${n.id} [imp=${n.importance} score=${n.score?.toFixed(2) ?? "?"}]: ${n.content}`,
              );
            return {
              content: [
                { type: "text", text: `Found ${r.results.length} notes:\n${lines.join("\n")}` },
              ],
              details: { success: true, count: r.results.length },
            };
          }

          case "reflect": {
            const r = await platformMemory.reflect(params.content);
            return {
              content: [
                {
                  type: "text",
                  text: `Reflection created${r.noteId ? ` (Note #${r.noteId})` : ""}\n${r.text.slice(0, 200)}`,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "orient": {
            const r = await platformMemory.orient();
            return {
              content: [{ type: "text", text: r.text }],
              details: { success: r.success },
            };
          }

          case "skill_store": {
            if (!params.skill_name || !params.skill_description || !params.skill_actions) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: skill_name, skill_description, skill_actions all required",
                  },
                ],
                details: { success: false },
              };
            }
            const r = await platformMemory.storeSkill(
              params.skill_name,
              params.skill_description,
              params.skill_actions,
            );
            return {
              content: [
                {
                  type: "text",
                  text: r.noteId
                    ? `Skill #${r.noteId}: ${params.skill_name}`
                    : `Skill stored: ${params.skill_name}`,
                },
              ],
              details: { success: r.success, noteId: r.noteId },
            };
          }

          case "skill_search": {
            if (!params.query) {
              return {
                content: [{ type: "text", text: "Error: query required for skill_search" }],
                details: { success: false },
              };
            }
            const r = await platformMemory.searchSkills(params.query);
            if (!r.results || r.results.length === 0) {
              return {
                content: [{ type: "text", text: `No skills found for "${params.query}"` }],
                details: { success: true, count: 0 },
              };
            }
            const lines = r.results
              .slice(0, 5)
              .map(
                (s) =>
                  `#${s.id} [imp=${s.importance} score=${s.score?.toFixed(2) ?? "?"}]: ${s.content}`,
              );
            return {
              content: [
                { type: "text", text: `Found ${r.results.length} skills:\n${lines.join("\n")}` },
              ],
              details: { success: true, count: r.results.length },
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}` }],
              details: { success: false },
            };
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Memory operation failed: ${msg}` }],
          details: { success: false, error: msg },
        };
      }
    },
  };
}

// ─── All Tools ──────────────────────────────────────────────────────────────

export function createAllTools(
  ctx: ToolContext,
  platformMemory: PlatformMemoryBackend,
  rosterMode: "compact" | "verbose" = "verbose",
): AgentTool[] {
  // AgentTool generic variance requires cast when combining different schema types
  return [
    createCommandTool(ctx, rosterMode) as unknown as AgentTool,
    ...createWorldTools(ctx),
    createThinkTool() as unknown as AgentTool,
    createMemoryTool(platformMemory) as unknown as AgentTool,
  ];
}

/**
 * Tool profile — choose how much tool schema to send to the LLM.
 *
 * The Anthropic tool schema (re-sent with every request) is ~12-15KB when
 * all 27 tools are included. Smaller models — Haiku and below — can spend
 * their whole turn just parsing it, which is exactly what we observed
 * during the 2026-04-23 Haiku experiment (124 prompt timeouts, 778 silent
 * turns). They don't need the full buffet: `marina_command` is an
 * escape hatch that can run ANY world command, so a minimal profile of
 * just `command + think + memory` is functionally complete.
 *
 * Profiles:
 *  - `"full"`    : 27 tools, ~12-15KB schema. Rich typed interface.
 *                  Good for Sonnet-tier and above; the typed tools
 *                  help auto-structure actions.
 *  - `"minimal"` : 3 tools (command, think, memory), ~1.5KB schema.
 *                  Functionally complete via `command`. Good for
 *                  Haiku-tier specialists that need one-shot focused
 *                  action, not rich coordination surface.
 *  - `"crew"`    : command + think + memory + tell + pool + brief +
 *                  channel, ~4KB. Mid-tier for dispatchers / agents
 *                  that coordinate peers.
 *
 * An agent config's `toolProfile` field selects; defaults to `"full"` so
 * nothing breaks unless a specialist explicitly opts in to leaner.
 */
export type ToolProfile = "full" | "crew" | "minimal";

/**
 * Tool-name sets for each profile. Kept here so `worlds/seed.ts` and
 * future roles can reference by name instead of guessing.
 */
export const TOOL_PROFILE_NAMES: Record<ToolProfile, string[]> = {
  full: [], // empty = all tools
  crew: [
    "marina_command",
    "marina_tell",
    "marina_pool",
    "marina_brief",
    "marina_channel",
    "think",
    "memory",
  ],
  minimal: ["marina_command", "think", "memory"],
};

/**
 * Build the tool set for a given profile. Unknown names are silently
 * dropped — log is the caller's responsibility.
 *
 * The `crew` and `minimal` profiles ship with a compact natural-language
 * command roster baked into `marina_command`'s description, so an
 * agent without the full typed surface still knows what verbs the world
 * exposes. The `full` profile keeps the terse description because the
 * 27 typed tools each carry their own description.
 */
export function createScopedTools(
  ctx: ToolContext,
  platformMemory: PlatformMemoryBackend,
  profile: ToolProfile,
): AgentTool[] {
  const rosterMode: "compact" | "verbose" = profile === "full" ? "verbose" : "compact";
  const all = createAllTools(ctx, platformMemory, rosterMode);
  if (profile === "full") return all;
  const want = new Set(TOOL_PROFILE_NAMES[profile]);
  return all.filter((t) => want.has(t.name));
}
