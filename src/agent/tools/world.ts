// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Typed world tools — thin wrappers that build one command string each (look,
// move, say, channel, task, pool, focus, goal, feed, market, …) plus the two
// inline tools with their own execution paths: `marina_tell` (awaitReply) and
// `marina_conduct` (runs a Score). The Code Mode tools are spliced in from
// `./code`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  type ParsedAssignee,
  parseAssignee,
  parseScore,
  type Score,
} from "../../coordination/score";
import { runScore } from "../../sdk/conduct";
import { createCodeTool, createTypedCodeTools } from "./code";
import { execCommand, formatPerceptions, type ToolContext, wrap } from "./shared";

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
  channel: Type.Optional(
    Type.String({
      description:
        "Channel name — REQUIRED for send/join/leave/read (only `list` works without it). " +
        "Never put the message here.",
    }),
  ),
  message: Type.Optional(Type.String({ description: "Message to send" })),
});

const boardSchema = Type.Object({
  action: Type.String({ description: "Action: list, read, post, reply, vote" }),
  args: Type.Optional(Type.String({ description: "Arguments for the action" })),
});

const taskSchema = Type.Object({
  action: Type.String({ description: "Action: list, create, claim, submit, info" }),
  args: Type.Optional(
    Type.String({
      description:
        "Arguments for the action. Submissions must cite inspectable evidence such as note/pool/canvas IDs, command results, source URLs, or artifact paths.",
    }),
  ),
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
  strictCorrelation: Type.Optional(
    Type.Boolean({
      description: "Require matching reply tags; enable when workers support exact correlation.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 32,
      description: "Maximum simultaneous steps (default 4).",
    }),
  ),
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
      // primitive — see the crew fast-dispatch design (private archive: marina-internal design/crew-fast-dispatch-design.md). The simple
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
      // becomes a running organization. See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 4.
      name: "marina_conduct",
      label: "Conduct",
      description:
        "Run a Score (a workflow plan) over real agents: each step's instruction plus its accessed prior outputs is sent to the assigned worker, and the reply feeds forward. Pass a stored `name` (see `conduct list`) or inline `score` JSON. Returns the per-step trace and the final result.",
      parameters: conductSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as {
          name?: string;
          score?: string;
          timeoutMs?: number;
          concurrency?: number;
          strictCorrelation?: boolean;
        };
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
            tellAndAwait: (target, message, ms, options) =>
              ctx.client.tellAndAwait(target, message, ms, options),
            signal,
            concurrency: p.concurrency,
            strictCorrelation: p.strictCorrelation,
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
      "Task management: list, create, goal (create+auto-claim), progress, claim, submit. Before submit, verify the outcome and cite inspectable evidence; a plan or intention is not completed work.",
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
    createCodeTool(ctx),
    ...createTypedCodeTools(ctx),
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
