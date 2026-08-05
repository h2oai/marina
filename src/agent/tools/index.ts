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
import type { AgentSupports } from "../agent-types";
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
Code: code status, code files [path], code read <path>, code search <query>, code diff, code verify, code recipe list/run/save, code checkpoint, code revert <id>, code approvals, code approval request <kind> <desc>, code model set <target>, code skill list/add/use, code crew <goal>, code external link <system> <id>, code observe <note>, code patch <title>, code artifacts, code pin <id>, code unpin <id>, code archive <id>.
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

const codeSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("status"),
      Type.Literal("files"),
      Type.Literal("read"),
      Type.Literal("search"),
      Type.Literal("diff"),
      Type.Literal("run"),
      Type.Literal("verify"),
      Type.Literal("observe"),
      Type.Literal("patch"),
      Type.Literal("apply"),
      Type.Literal("reject"),
      Type.Literal("show"),
      Type.Literal("patches"),
      Type.Literal("artifacts"),
      Type.Literal("history"),
      Type.Literal("plan"),
      Type.Literal("summary"),
      Type.Literal("handoff"),
      Type.Literal("decision"),
      Type.Literal("workspace"),
      Type.Literal("doctor"),
      Type.Literal("recipe"),
      Type.Literal("checkpoint"),
      Type.Literal("revert"),
      Type.Literal("approval"),
      Type.Literal("approve"),
      Type.Literal("deny"),
      Type.Literal("model"),
      Type.Literal("skill"),
      Type.Literal("thread"),
      Type.Literal("crew"),
      Type.Literal("roles"),
      Type.Literal("external"),
    ],
    {
      description:
        "Coding action. Assigned agents normally have an active coding session already bound.",
    },
  ),
  path: Type.Optional(Type.String({ description: "Relative workspace path for files/read/diff" })),
  query: Type.Optional(Type.String({ description: "Search query for action=search" })),
  command: Type.Optional(
    Type.String({
      description:
        "Allowed command for action=run, or workspace subcommand for action=workspace: show, list, or use",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Artifact title for action=patch" })),
  diff: Type.Optional(Type.String({ description: "Unified diff for action=patch" })),
  artifactId: Type.Optional(
    Type.String({ description: "Artifact id for action=apply/reject/show" }),
  ),
  kind: Type.Optional(Type.String({ description: "Artifact kind filter for action=artifacts" })),
  status: Type.Optional(
    Type.String({
      description: "Patch status filter for action=patches: pending, applied, rejected",
    }),
  ),
  text: Type.Optional(
    Type.String({ description: "Text for plan/summary/handoff/decision/observe/reject" }),
  ),
});

const codeEmptySchema = Type.Object({});

const codePathSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Relative workspace path" })),
});

const codeReadFileSchema = Type.Object({
  path: Type.String({ description: "Relative workspace file path" }),
});

const codeSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
});

const codeRunSchema = Type.Object({
  command: Type.String({
    description: "Allowed workspace command, for example test or git status --short",
  }),
});

const codePatchSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Patch artifact title" })),
  diff: Type.String({ description: "Unified diff to propose" }),
});

const codeArtifactsSchema = Type.Object({
  kind: Type.Optional(Type.String({ description: "Artifact kind filter" })),
});

const codePatchRefSchema = Type.Object({
  artifactId: Type.String({ description: "Patch or artifact id" }),
});

const codeRejectPatchSchema = Type.Object({
  artifactId: Type.String({ description: "Patch artifact id" }),
  text: Type.Optional(Type.String({ description: "Optional rejection reason" })),
});

const codeTextSchema = Type.Object({
  text: Type.String({ description: "Single-line note text" }),
});

const codeHistorySchema = Type.Object({
  sessionId: Type.Optional(Type.String({ description: "Optional coding session id" })),
});

const codeWorkspaceSchema = Type.Object({
  command: Type.Optional(
    Type.Union([Type.Literal("show"), Type.Literal("list"), Type.Literal("use")], {
      description: "Workspace action: show, list, or use",
    }),
  ),
  path: Type.Optional(Type.String({ description: "Workspace path/name for command=use" })),
});

const codeRecipeSchema = Type.Object({
  command: Type.Union([Type.Literal("list"), Type.Literal("save"), Type.Literal("run")]),
  name: Type.Optional(Type.String({ description: "Recipe name" })),
  text: Type.Optional(Type.String({ description: "Commands separated by then" })),
});

const codeCheckpointSchema = Type.Object({
  command: Type.Union([Type.Literal("create"), Type.Literal("revert")]),
  title: Type.Optional(Type.String({ description: "Checkpoint title" })),
  artifactId: Type.Optional(Type.String({ description: "Checkpoint artifact id for revert" })),
});

const codeApprovalSchema = Type.Object({
  command: Type.Union([
    Type.Literal("list"),
    Type.Literal("request"),
    Type.Literal("approve"),
    Type.Literal("deny"),
  ]),
  kind: Type.Optional(Type.String({ description: "Approval kind for request" })),
  text: Type.Optional(Type.String({ description: "Approval description" })),
  artifactId: Type.Optional(Type.String({ description: "Approval artifact id" })),
});

const codeModelSchema = Type.Object({
  command: Type.Union([Type.Literal("show"), Type.Literal("set"), Type.Literal("clear")]),
  target: Type.Optional(Type.String({ description: "Model/provider/agent/crew target" })),
});

const codeSkillSchema = Type.Object({
  command: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("use")]),
  name: Type.Optional(Type.String({ description: "Skill name" })),
  text: Type.Optional(Type.String({ description: "Skill instructions" })),
});

const codeExternalSchema = Type.Object({
  command: Type.Union([Type.Literal("show"), Type.Literal("link"), Type.Literal("unlink")]),
  system: Type.Optional(Type.String({ description: "External system name" })),
  externalId: Type.Optional(Type.String({ description: "External session id" })),
  artifactId: Type.Optional(Type.String({ description: "External link artifact id" })),
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

const imageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Describe the image to generate" }),
  model: Type.Optional(
    Type.String({
      description: "Provider/model ID (default openai/gpt-image-1)",
    }),
  ),
  style: Type.Optional(Type.String({ description: "Style hint (e.g. synthwave, watercolor)" })),
  width: Type.Optional(
    Type.Number({
      description: "Image width in pixels (256-2048)",
      minimum: 256,
      maximum: 2048,
    }),
  ),
  height: Type.Optional(
    Type.Number({
      description: "Image height in pixels (256-2048)",
      minimum: 256,
      maximum: 2048,
    }),
  ),
  canvas: Type.Optional(
    Type.String({
      description: "Canvas name or id to publish the result to",
    }),
  ),
});

const videoGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Describe the video to generate" }),
  model: Type.Optional(
    Type.String({
      description: "Provider/model ID (default runway/gen3-alpha)",
    }),
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Video duration in seconds (1-60)",
      minimum: 1,
      maximum: 60,
    }),
  ),
  fps: Type.Optional(
    Type.Number({
      description: "Frames per second (8-60)",
      minimum: 8,
      maximum: 60,
    }),
  ),
  reference: Type.Optional(
    Type.String({
      description: "Optional reference image asset id or URL",
    }),
  ),
  aspect: Type.Optional(
    Type.String({
      description: "Aspect ratio (e.g. 16:9, 9:16)",
    }),
  ),
  canvas: Type.Optional(
    Type.String({
      description: "Canvas name or id to publish the result to",
    }),
  ),
});

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

function createCodeTool(ctx: ToolContext): AgentTool<typeof codeSchema> {
  return {
    name: "marina_code",
    label: "Code",
    description:
      "Work inside the active Marina coding session: inspect files, read, search, diff, run allowed checks, propose/apply patches, and record durable coding artifacts.",
    parameters: codeSchema,
    execute: async (_id, params: Static<typeof codeSchema>, signal) => {
      try {
        return await execCommand(ctx, buildCodeCommand(params), signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Invalid marina_code request: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

function createTypedCodeTools(ctx: ToolContext): AgentTool[] {
  return [
    wrap(
      "marina_code_session_status",
      "Code Session Status",
      "Show the active Marina coding session, workspace, latest artifact, and pending patches.",
      codeEmptySchema,
      () => "code status",
      ctx,
    ),
    wrap(
      "marina_code_list_files",
      "Code List Files",
      "List files in the active coding session workspace.",
      codePathSchema,
      (p) => `code files ${singleLineCodeParam((p.path as string | undefined) ?? ".", "path")}`,
      ctx,
    ),
    wrap(
      "marina_code_read_file",
      "Code Read File",
      "Read one relative file from the active coding session workspace.",
      codeReadFileSchema,
      (p) =>
        `code read ${requiredSingleLineCodeParam(p.path as string | undefined, "path", "path is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_search",
      "Code Search",
      "Search text in the active coding session workspace.",
      codeSearchSchema,
      (p) =>
        `code search ${requiredSingleLineCodeParam(p.query as string | undefined, "query", "query is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_diff",
      "Code Diff",
      "Show git diff for the active coding session workspace, optionally scoped to a path.",
      codePathSchema,
      (p) => (p.path ? `code diff ${singleLineCodeParam(p.path as string, "path")}` : "code diff"),
      ctx,
    ),
    wrap(
      "marina_code_run",
      "Code Run",
      "Run one allowed workspace command and store the command-output artifact.",
      codeRunSchema,
      (p) =>
        `code run ${requiredSingleLineCodeParam(p.command as string | undefined, "command", "command is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_verify",
      "Code Verify",
      "Run the detected verification chain and store a verification artifact.",
      codeEmptySchema,
      () => "code verify",
      ctx,
    ),
    wrap(
      "marina_code_artifacts",
      "Code Artifacts",
      "List coding artifacts for the active session, optionally filtered by kind.",
      codeArtifactsSchema,
      (p) =>
        p.kind
          ? `code artifacts kind ${singleLineCodeParam(p.kind as string, "kind")}`
          : "code artifacts",
      ctx,
    ),
    wrap(
      "marina_code_patch",
      "Code Patch",
      "Propose a unified-diff patch artifact in the active coding session.",
      codePatchSchema,
      (p) =>
        `code patch ${singleLineCodeParam((p.title as string | undefined) ?? "Proposed change", "title")}\n${requiredCodeDiff(p.diff as string | undefined)}`,
      ctx,
    ),
    wrap(
      "marina_code_apply_patch",
      "Code Apply Patch",
      "Apply a pending patch artifact in the active coding session.",
      codePatchRefSchema,
      (p) =>
        `code apply ${requiredSingleLineCodeParam(p.artifactId as string | undefined, "artifactId", "artifactId is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_reject_patch",
      "Code Reject Patch",
      "Reject a pending patch artifact in the active coding session.",
      codeRejectPatchSchema,
      (p) =>
        `code reject ${requiredSingleLineCodeParam(
          p.artifactId as string | undefined,
          "artifactId",
          "artifactId is required",
        )}${
          typeof p.text === "string" && p.text.trim()
            ? ` ${singleLineCodeParam(p.text, "text")}`
            : ""
        }`,
      ctx,
    ),
    wrap(
      "marina_code_observe",
      "Code Observe",
      "Store an app or workspace observation artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code observe ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_plan",
      "Code Plan",
      "Store a plan artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code plan ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_summary",
      "Code Summary",
      "Store a summary artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code summary ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_handoff",
      "Code Handoff",
      "Store a handoff artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code handoff ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_decision",
      "Code Decision",
      "Store a decision artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code decision ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_history",
      "Code History",
      "Show recent coding events for the active or specified coding session.",
      codeHistorySchema,
      (p) =>
        p.sessionId
          ? `code history ${singleLineCodeParam(p.sessionId as string, "sessionId")}`
          : "code history",
      ctx,
    ),
    wrap(
      "marina_code_workspace",
      "Code Workspace",
      "Show, list, or select the active coding workspace.",
      codeWorkspaceSchema,
      (p) => {
        if (p.command === "list") return "code workspace list";
        if (p.command === "use") {
          return `code workspace use ${requiredSingleLineCodeParam(
            p.path as string | undefined,
            "path",
            "path is required",
          )}`;
        }
        return "code workspace";
      },
      ctx,
    ),
    wrap(
      "marina_code_doctor",
      "Code Doctor",
      "Diagnose Code Mode setup for the current entity and workspace.",
      codeEmptySchema,
      () => "code doctor",
      ctx,
    ),
    wrap(
      "marina_code_recipe",
      "Code Recipe",
      "List, save, or run Code Mode verification recipes.",
      codeRecipeSchema,
      (p) => {
        if (p.command === "save") {
          return `code recipe save ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "run") {
          return `code recipe run ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )}`;
        }
        return "code recipe list";
      },
      ctx,
    ),
    wrap(
      "marina_code_checkpoint",
      "Code Checkpoint",
      "Create or revert a workspace diff checkpoint in the active coding session.",
      codeCheckpointSchema,
      (p) => {
        if (p.command === "revert") {
          return `code revert ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return p.title
          ? `code checkpoint ${singleLineCodeParam(p.title as string, "title")}`
          : "code checkpoint";
      },
      ctx,
    ),
    wrap(
      "marina_code_approval",
      "Code Approval",
      "Create or decide Code Mode approval artifacts.",
      codeApprovalSchema,
      (p) => {
        if (p.command === "request") {
          return `code approval request ${requiredSingleLineCodeParam(
            p.kind as string | undefined,
            "kind",
            "kind is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "approve") {
          return `code approve ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        if (p.command === "deny") {
          return `code deny ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return "code approvals";
      },
      ctx,
    ),
    wrap(
      "marina_code_model",
      "Code Model",
      "Show or set the per-session code model/provider target.",
      codeModelSchema,
      (p) => {
        if (p.command === "set") {
          return `code model set ${requiredSingleLineCodeParam(
            p.target as string | undefined,
            "target",
            "target is required",
          )}`;
        }
        if (p.command === "clear") return "code model clear";
        return "code model";
      },
      ctx,
    ),
    wrap(
      "marina_code_skill",
      "Code Skill",
      "List, add, or activate Code Mode session skills.",
      codeSkillSchema,
      (p) => {
        if (p.command === "add") {
          return `code skill add ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "use") {
          return `code skill use ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )}`;
        }
        return "code skill list";
      },
      ctx,
    ),
    wrap(
      "marina_code_thread",
      "Code Thread",
      "Show the compact artifact thread for the active coding session.",
      codeEmptySchema,
      () => "code thread",
      ctx,
    ),
    wrap(
      "marina_code_crew",
      "Code Crew",
      "Store a coding crew orchestration plan for the active session.",
      codeTextSchema,
      (p) =>
        `code crew ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_external",
      "Code External Link",
      "Show, create, or archive an external coding-session link.",
      codeExternalSchema,
      (p) => {
        if (p.command === "link") {
          return `code external link ${requiredSingleLineCodeParam(
            p.system as string | undefined,
            "system",
            "system is required",
          )} ${requiredSingleLineCodeParam(
            p.externalId as string | undefined,
            "externalId",
            "externalId is required",
          )}`;
        }
        if (p.command === "unlink") {
          return `code external unlink ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return "code external";
      },
      ctx,
    ),
  ];
}

function buildCodeCommand(params: Record<string, unknown>): string {
  const action = params.action as string;
  const path = params.path as string | undefined;
  const query = params.query as string | undefined;
  const command = params.command as string | undefined;
  const title = params.title as string | undefined;
  const diff = params.diff as string | undefined;
  const artifactId = params.artifactId as string | undefined;
  const kind = params.kind as string | undefined;
  const status = params.status as string | undefined;
  const text = params.text as string | undefined;

  switch (action) {
    case "status":
      return "code status";
    case "files":
      return `code files ${singleLineCodeParam(path ?? ".", "path")}`;
    case "read":
      return `code read ${requiredSingleLineCodeParam(path, "path", "action=read requires path")}`;
    case "search":
      return `code search ${requiredSingleLineCodeParam(query, "query", "action=search requires query")}`;
    case "diff":
      return path ? `code diff ${singleLineCodeParam(path, "path")}` : "code diff";
    case "run":
      return `code run ${requiredSingleLineCodeParam(command, "command", "action=run requires command")}`;
    case "verify":
      return "code verify";
    case "observe":
      return `code observe ${requiredSingleLineCodeParam(text, "text", "action=observe requires text")}`;
    case "patch":
      return `code patch ${singleLineCodeParam(title ?? "Proposed change", "title")}\n${requiredCodeDiff(diff)}`;
    case "apply":
      return `code apply ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=apply requires artifactId")}`;
    case "reject":
      return `code reject ${requiredSingleLineCodeParam(
        artifactId,
        "artifactId",
        "action=reject requires artifactId",
      )}${text ? ` ${singleLineCodeParam(text, "text")}` : ""}`;
    case "show":
      return `code show ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=show requires artifactId")}`;
    case "patches":
      return status ? `code patches ${validatedPatchStatus(status)}` : "code patches";
    case "artifacts":
      return kind ? `code artifacts kind ${singleLineCodeParam(kind, "kind")}` : "code artifacts";
    case "history":
      return "code history";
    case "workspace":
      if (command === "list") return "code workspace list";
      if (command === "use" && path)
        return `code workspace use ${singleLineCodeParam(path, "path")}`;
      return "code workspace";
    case "doctor":
      return "code doctor";
    case "recipe":
      if (command === "run") {
        return `code recipe run ${requiredSingleLineCodeParam(kind, "name", "action=recipe run requires kind/name")}`;
      }
      if (command === "save") {
        return `code recipe save ${requiredSingleLineCodeParam(
          kind,
          "name",
          "action=recipe save requires kind/name",
        )} ${requiredSingleLineCodeParam(text, "text", "action=recipe save requires text")}`;
      }
      return "code recipe list";
    case "checkpoint":
      return text ? `code checkpoint ${singleLineCodeParam(text, "text")}` : "code checkpoint";
    case "revert":
      return `code revert ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=revert requires artifactId")}`;
    case "approval":
      return `code approval request ${requiredSingleLineCodeParam(
        kind,
        "kind",
        "action=approval requires kind",
      )} ${requiredSingleLineCodeParam(text, "text", "action=approval requires text")}`;
    case "approve":
      return `code approve ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=approve requires artifactId")}`;
    case "deny":
      return `code deny ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=deny requires artifactId")}`;
    case "model":
      if (command === "set") {
        return `code model set ${requiredSingleLineCodeParam(text, "text", "action=model command=set requires text target")}`;
      }
      if (command === "clear") return "code model clear";
      return "code model";
    case "skill":
      if (command === "add") {
        return `code skill add ${requiredSingleLineCodeParam(
          kind,
          "name",
          "action=skill command=add requires kind/name",
        )} ${requiredSingleLineCodeParam(text, "text", "action=skill command=add requires text")}`;
      }
      if (command === "use") {
        return `code skill use ${requiredSingleLineCodeParam(kind, "name", "action=skill command=use requires kind/name")}`;
      }
      return "code skill list";
    case "thread":
      return "code thread";
    case "crew":
      return `code crew ${requiredSingleLineCodeParam(text, "text", "action=crew requires text")}`;
    case "roles":
      return "code roles";
    case "external":
      if (command === "link") {
        return `code external link ${requiredSingleLineCodeParam(
          kind,
          "system",
          "action=external command=link requires kind/system",
        )} ${requiredSingleLineCodeParam(text, "text", "action=external command=link requires text external id")}`;
      }
      if (command === "unlink") {
        return `code external unlink ${requiredSingleLineCodeParam(
          artifactId,
          "artifactId",
          "action=external command=unlink requires artifactId",
        )}`;
      }
      return "code external";
    case "plan":
    case "summary":
    case "handoff":
    case "decision":
      return `code ${action} ${requiredSingleLineCodeParam(
        text,
        "text",
        `action=${action} requires text`,
      )}`;
    default:
      return "code status";
  }
}

function requiredSingleLineCodeParam(
  value: string | undefined,
  name: string,
  message: string,
): string {
  if (!value?.trim()) throw new Error(message);
  return singleLineCodeParam(value, name);
}

function singleLineCodeParam(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error(`${name} must be a single line`);
  }
  return normalized;
}

function requiredCodeDiff(value: string | undefined): string {
  if (!value?.trim()) throw new Error("action=patch requires diff");
  return value.endsWith("\n") ? value : `${value}\n`;
}

function validatedPatchStatus(value: string): string {
  const status = singleLineCodeParam(value, "status").toLowerCase();
  if (status !== "pending" && status !== "applied" && status !== "rejected") {
    throw new Error("action=patches status must be pending, applied, or rejected");
  }
  return status;
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
  trusted: Type.Optional(
    Type.Boolean({
      description:
        "Prefer verified/high-confidence memories; falls back when none exist (for search)",
    }),
  ),
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
      "Use trusted=true for decisions. For provenance use marina_command: note claim/source/derive/verify/explain.",
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
            const r = await platformMemory.search(params.query, { trusted: params.trusted });
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

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function createMediaTools(ctx: ToolContext): AgentTool[] {
  return [
    {
      name: "marina_generate_image",
      label: "Generate Image",
      description:
        "Create an image from a text prompt. Requires storage + image-capable model API keys.",
      parameters: imageGenerateSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as Static<typeof imageGenerateSchema>;
        const prompt = sanitizePrompt(p.prompt);
        if (!prompt) {
          throw new Error("Prompt is required to generate an image.");
        }
        let command = `image generate ${prompt}`;
        if (p.model) command += ` --model ${p.model}`;
        if (p.style) command += ` --style ${p.style}`;
        if (typeof p.width === "number") command += ` --width ${Math.round(p.width)}`;
        if (typeof p.height === "number") command += ` --height ${Math.round(p.height)}`;
        if (p.canvas) command += ` --canvas ${p.canvas}`;
        return execCommand(ctx, command, signal);
      },
    },
    {
      name: "marina_generate_video",
      label: "Generate Video",
      description:
        "Create a short video from a text prompt. Requires storage + video-capable provider keys.",
      parameters: videoGenerateSchema,
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const p = params as Static<typeof videoGenerateSchema>;
        const prompt = sanitizePrompt(p.prompt);
        if (!prompt) {
          throw new Error("Prompt is required to generate a video.");
        }
        let command = `video generate ${prompt}`;
        if (p.model) command += ` --model ${p.model}`;
        if (typeof p.duration === "number") command += ` --duration ${Math.round(p.duration)}`;
        if (typeof p.fps === "number") command += ` --fps ${Math.round(p.fps)}`;
        if (p.reference) command += ` --reference ${p.reference}`;
        if (p.aspect) command += ` --aspect ${p.aspect}`;
        if (p.canvas) command += ` --canvas ${p.canvas}`;
        return execCommand(ctx, command, signal);
      },
    },
  ];
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
    ...createMediaTools(ctx),
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
    "marina_code",
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
  supports: AgentSupports = { text: true },
): AgentTool[] {
  const rosterMode: "compact" | "verbose" = profile === "full" ? "verbose" : "compact";
  const all = createAllTools(ctx, platformMemory, rosterMode).filter((tool) => {
    if (!supports.image && tool.name === "marina_generate_image") return false;
    if (!supports.video && tool.name === "marina_generate_video") return false;
    return true;
  });
  if (profile === "full") return all;
  const want = new Set(TOOL_PROFILE_NAMES[profile]);
  return all.filter((t) => want.has(t.name));
}

const evolutionToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("analyze"),
    Type.Literal("propose"),
    Type.Literal("evaluate"),
    Type.Literal("decide"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("complete"),
  ]),
  experiment: Type.String({ description: "Existing experiment name" }),
  hypothesis: Type.Optional(Type.String()),
  candidateRef: Type.Optional(Type.String()),
  parentRunId: Type.Optional(Type.Integer({ minimum: 1 })),
  runId: Type.Optional(Type.Integer({ minimum: 1 })),
  evidence: Type.Optional(Type.String()),
  decision: Type.Optional(
    Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("inconclusive")]),
  ),
});

/** Typed convenience for an already-active native evolution protocol. Every
 * action maps to the same world command available to humans and external agents. */
export function createEvolutionTool(ctx: ToolContext): AgentTool<typeof evolutionToolSchema> {
  return {
    name: "marina_evolve",
    label: "Evolution Protocol",
    description:
      "Inspect or contribute to an active native evolution protocol. Records evidence and decisions only; cannot execute, activate, or promote a candidate.",
    parameters: evolutionToolSchema,
    execute: async (_id, params, signal) => {
      const experiment = evolutionToolParam(params.experiment, "experiment");
      let command: string;
      if (["status", "analyze", "pause", "resume", "complete"].includes(params.action)) {
        command = `evolve ${params.action} ${experiment}`;
      } else if (params.action === "propose") {
        const hypothesis = evolutionToolParam(params.hypothesis, "hypothesis");
        const candidate = evolutionToolParam(params.candidateRef, "candidateRef");
        command = `evolve propose ${experiment} | ${hypothesis} | ${candidate}`;
        if (params.parentRunId) command += ` | parent=${params.parentRunId}`;
      } else if (params.action === "evaluate") {
        if (!params.runId) throw new Error("runId is required for evaluate");
        command = `evolve evaluate ${experiment} ${params.runId} | ${evolutionToolParam(params.evidence, "evidence")}`;
      } else {
        if (!params.runId || !params.decision) {
          throw new Error("runId and decision are required for decide");
        }
        command = `evolve decide ${experiment} ${params.runId} ${params.decision}`;
      }
      return execCommand(ctx, command, signal);
    },
  };
}

function evolutionToolParam(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  if (/[\r\n|]/.test(trimmed)) throw new Error(`${name} must be a single value without pipes`);
  return trimmed;
}
