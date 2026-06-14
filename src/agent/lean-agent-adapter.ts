/**
 * Lean Agent Adapter — adapts the lean agent for in-server use.
 *
 * Uses the Marina SDK client to self-connect via WebSocket.
 * The engine sees this agent as a regular connected entity.
 * All state lives server-side via platform commands.
 */

import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import {
  type Api,
  completeSimple,
  type Message,
  type Model,
  getModel as piGetModel,
  getModels as piGetModels,
  type TextContent,
} from "@mariozechner/pi-ai";
import { MARINA_DEFAULT_MODEL } from "../engine/constants";
import {
  isLocalProvider,
  localProviderBaseUrl,
  localProviderContextWindow,
} from "../net/model-discovery";
import { MarinaClient } from "../sdk/client";
import type { Perception } from "../types";
import { ActionHistory } from "./action-history";
import type {
  AgentConfig,
  AgentEvent,
  AgentHandle,
  AgentStatus,
  AgentSupports,
} from "./agent-types";
import { createContextManager, hardTrimMessages } from "./context-manager";
import { GameStateManager } from "./game-state";
import { HookRegistry } from "./hook-registry";
import { InterruptibleWaiter } from "./interruptible-waiter";
import { PlatformMemoryBackend } from "./memory-platform";
import { getLeanDiscoveryPrompt, getLeanSystemPrompt } from "./prompts/lean-system";
import { SocialAwareness } from "./social";
import { createScopedTools } from "./tools";

// ─── Model Resolution ───────────────────────────────────────────────────────

/** Parse a positive integer env value, or undefined if unset/invalid. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Lowest context window we'll ever shrink to during overflow recovery. */
const MIN_EFFECTIVE_CONTEXT = 4096;

/** Max characters of any single recalled note / skill / orient block in the prompt. */
const RECALL_BLOCK_MAX_CHARS = 600;

/** Clamp recalled text so one oversized note can't balloon the continuation prompt. */
function clampText(text: string, maxChars = RECALL_BLOCK_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} […+${text.length - maxChars} chars]`;
}

/**
 * Does an upstream error message describe a context-length / token-budget
 * overflow? These are NOT cured by waiting — only by shrinking the request —
 * so they take the recovery path (hard-trim + window shrink) instead of a plain
 * backoff-and-retry that would loop forever on the same oversized history.
 * Matches the common phrasings across Anthropic / OpenAI / llama.cpp / Ollama.
 */
function isContextOverflowError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("context length") ||
    m.includes("context window") ||
    m.includes("context size") ||
    m.includes("maximum context") ||
    m.includes("context_length_exceeded") ||
    m.includes("too many tokens") ||
    m.includes("token limit") ||
    m.includes("reduce the length") ||
    m.includes("prompt is too long") ||
    (m.includes("exceed") && m.includes("token")) ||
    // llama.cpp: "the request exceeds the available context size"
    (m.includes("exceeds") && m.includes("context"))
  );
}

function normalizeSupports(supports: AgentSupports | undefined): AgentSupports {
  if (!supports) return { text: true };
  return {
    text: supports.text === false ? false : true,
    ...(supports.image ? { image: true } : {}),
    ...(supports.video ? { video: true } : {}),
  };
}

/**
 * Safe wrapper around pi-ai's `getModel`.
 *
 * CRITICAL: `getModel` returns `undefined` (it does NOT throw) for ids absent
 * from its bundled registry. The previous resolver wrapped it in try/catch
 * expecting a throw, so the fallback was dead code — an unknown id leaked an
 * `undefined` model downstream into a malformed upstream request (the "some
 * models 4xx" symptom). Always go through this helper and check the result.
 */
function tryGetModel(provider: string, modelId: string): Model<Api> | undefined {
  try {
    return (piGetModel as (p: string, id: string) => Model<Api> | undefined)(provider, modelId);
  } catch {
    return undefined;
  }
}

/**
 * Synthesize a Model for a known provider whose specific id isn't in the
 * bundled registry. pi-ai's registry tracks releases on a lag, and aggregators
 * like OpenRouter serve far more ids than it lists, so a perfectly valid model
 * can be absent. Clone a sibling model's transport (api / provider / baseUrl /
 * headers / input) and substitute the requested id with conservative defaults.
 *
 * The request then routes to the *correct* provider with the literal id, and
 * the upstream becomes the authority on whether the id is valid — instead of
 * silently switching the agent onto a different provider's default model.
 */
function synthesizeModel(provider: string, modelId: string): Model<Api> | undefined {
  // Cast to allow arbitrary provider strings (pi-ai types the param as a
  // closed `KnownProvider` union; we route on dynamic config values).
  const sibling = (piGetModels as (p: string) => Model<Api>[] | undefined)(provider)?.[0];
  if (!sibling) return undefined;
  return {
    ...sibling,
    id: modelId,
    name: `${provider}/${modelId}`,
    // Unknown id → assume no extended thinking so we don't emit reasoning
    // params the model may reject; the upstream still honors a real reasoning
    // model's defaults.
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Normalize a user-supplied remote-Marina target into an OpenAI-style base URL.
 * Accepts "host:port", "http(s)://host", or a full ".../v1" URL and always
 * returns "<scheme>://<host>[:port]/v1". Defaults to http:// when no scheme is
 * given (operators terminate TLS at a proxy or run on a trusted network).
 */
export function normalizeMarinaBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(u)) u = `${u}/v1`;
  return u;
}

/**
 * Classify how `resolveModel` will handle `modelStr`, with no side effects —
 * lets the spawn path surface a model problem up front instead of as a
 * downstream 4xx:
 *  - "exact":       in the bundled registry (or the synthetic `marina` provider)
 *  - "synthesized": known provider, unlisted id — routes to the right provider
 *  - "fallback":    provider has no models to route through (silent switch)
 */
export function classifyModelResolution(modelStr: string): "exact" | "synthesized" | "fallback" {
  // Strip a remote-Marina "@host" suffix before parsing the provider/id.
  const head = modelStr.split("@")[0] ?? modelStr;
  const slash = head.indexOf("/");
  const provider = slash >= 0 ? head.slice(0, slash) : head;
  const modelId = slash >= 0 ? head.slice(slash + 1) : head;
  if (provider === "marina") return "exact";
  // Self-hosted local runtimes (llama.cpp / Ollama) are routed by base URL, not
  // by the bundled registry — any model id is valid (the local server decides).
  if (isLocalProvider(provider)) return "exact";
  if (tryGetModel(provider, modelId)) return "exact";
  if (((piGetModels as (p: string) => Model<Api>[] | undefined)(provider)?.length ?? 0) > 0)
    return "synthesized";
  return "fallback";
}

/** Resolve a "provider/model" string to a pi-ai Model. Falls back to MARINA_DEFAULT_MODEL. */
export function resolveModel(modelStr: string, localPort?: number): Model<Api> {
  // A "marina" model may target a REMOTE instance via "marina@<host-or-url>"
  // (e.g. "marina@https://gpu.box:3300/v1" or "marina@gpu.box:3300"). Split the
  // remote suffix off before the slash-based provider/id parse so the "@" can't
  // confuse it.
  const at = modelStr.indexOf("@");
  const head = at >= 0 ? modelStr.slice(0, at) : modelStr;
  const remote = at >= 0 ? modelStr.slice(at + 1) : undefined;
  const slash = head.indexOf("/");
  const provider = slash >= 0 ? head.slice(0, slash) : head;
  const modelId = slash >= 0 ? head.slice(slash + 1) : head;

  // Marina model API — room agents route through the local server; an explicit
  // "@host" points the agent at another Marina instance's /v1 endpoint instead.
  if (provider === "marina") {
    const baseUrl = remote
      ? normalizeMarinaBaseUrl(remote)
      : `http://localhost:${localPort ?? (Number(process.env.WS_PORT) || 3300)}/v1`;
    return {
      id: modelId || "default",
      name: remote
        ? `Marina ${modelId || "default"} @ ${baseUrl}`
        : `Marina ${modelId || "default"}`,
      api: "openai-completions" as Api,
      provider: "openai",
      baseUrl,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // marina/default proxies to whatever upstream is configured. Default to a
      // large window (cloud) but let a local-first operator pin the real ceiling
      // so the compactor fires before a small local server 400s.
      contextWindow: parsePositiveInt(process.env.MARINA_DEFAULT_CONTEXT_WINDOW) ?? 128_000,
      maxTokens: 4096,
    };
  }

  // Self-hosted local runtime (llama.cpp / Ollama). Route the literal model id
  // straight to the local OpenAI-compatible server; the server validates the id
  // (it must match a loaded GGUF / pulled model). No bundled registry entry —
  // pi-ai ships none for these — so build the transport here, like `marina`.
  if (isLocalProvider(provider)) {
    const baseUrl = localProviderBaseUrl(provider)!;
    const id = modelId || "default";
    return {
      id,
      name: `${provider}/${id}`,
      api: "openai-completions" as Api,
      provider: "openai",
      baseUrl,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Honest local ceiling (env override → conservative default) so the
      // compactor fires before the small local server rejects the request.
      contextWindow: localProviderContextWindow(provider) ?? 16384,
      maxTokens: 4096,
    };
  }

  // Exact registry hit — the common path.
  const exact = tryGetModel(provider, modelId);
  if (exact) return exact;

  // Known provider, unlisted id: route to the correct provider with the literal
  // id rather than silently switching providers. Lets the upstream validate it.
  const synthesized = synthesizeModel(provider, modelId);
  if (synthesized) {
    console.warn(
      `[lean-agent] Model id "${modelId}" isn't in the bundled registry for provider "${provider}" — routing to ${provider} with default params. If it 4xxes, verify the id is valid for that provider.`,
    );
    return synthesized;
  }

  // Unknown provider entirely — fall back to the configured default and say so,
  // since a silent provider switch otherwise surfaces later as a confusing 4xx.
  const dslash = MARINA_DEFAULT_MODEL.indexOf("/");
  const dp = dslash >= 0 ? MARINA_DEFAULT_MODEL.slice(0, dslash) : MARINA_DEFAULT_MODEL;
  const dId = dslash >= 0 ? MARINA_DEFAULT_MODEL.slice(dslash + 1) : MARINA_DEFAULT_MODEL;
  console.warn(
    `[lean-agent] Provider "${provider}" (from model "${modelStr}") is not recognized by the model registry — falling back to MARINA_DEFAULT_MODEL "${MARINA_DEFAULT_MODEL}". Ensure you have a key for its provider, or pick a supported model.`,
  );
  const fallback = tryGetModel(dp, dId) ?? tryGetModel("google", "gemini-2.0-flash");
  if (fallback) return fallback;
  throw new Error(
    `Cannot resolve model "${modelStr}" or fallback "${MARINA_DEFAULT_MODEL}" — the model registry is unavailable.`,
  );
}

/**
 * Call a reasoning model as a plain chat model when the agent isn't using
 * extended thinking (Marina's default — `thinkingLevel: "off"`). Marina never
 * consumes reasoning output in that mode, and forcing `reasoning: false` is what
 * keeps the request clean across providers:
 *
 *  - OpenRouter / OpenAI: when `model.reasoning` is true but no effort is
 *    requested, pi-ai sends an explicit reasoning-DISABLE directive
 *    (`reasoning: { effort: "none" }` / `reasoning_effort: "none"`). Models where
 *    reasoning is MANDATORY reject it: `400 Reasoning is mandatory for this
 *    endpoint and cannot be disabled` — common with `openrouter/auto` routing to
 *    an o-series / thinking model. Both disable branches are gated on
 *    `model.reasoning`, so clearing it suppresses the directive and the upstream
 *    falls back to its own (valid) default instead of 400ing.
 *  - DeepSeek thinking-mode models (`requiresReasoningContentOnAssistantMessages`)
 *    400 (error 20015) when history omits the prior turn's `reasoning_content`,
 *    which pi-ai only ever echoes as an empty placeholder. Clearing that flag too
 *    avoids the broken round-trip.
 *
 * When the agent DID opt into thinking, the model is left untouched.
 */
export function neutralizeUnusedReasoning(
  model: Model<Api>,
  thinkingLevel: string | undefined,
): Model<Api> {
  // The agent opted into thinking — keep reasoning; that's an explicit choice.
  if (thinkingLevel && thinkingLevel !== "off") return model;
  if (!model.reasoning) return model;
  const compat = model.compat as
    | { requiresReasoningContentOnAssistantMessages?: boolean }
    | undefined;
  return {
    ...model,
    reasoning: false,
    // Also clear DeepSeek's round-trip demand (harmless when absent).
    compat: compat?.requiresReasoningContentOnAssistantMessages
      ? { ...(model.compat as object), requiresReasoningContentOnAssistantMessages: false }
      : model.compat,
  } as Model<Api>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Focus {
  description: string;
  startedAt: number;
}

// ─── Lean Agent Adapter ─────────────────────────────────────────────────────

export class LeanAgentAdapter implements AgentHandle {
  readonly name: string;

  private agent: Agent;
  private client: MarinaClient;
  private gameState: GameStateManager;
  private socialAwareness: SocialAwareness;
  private actionHistory: ActionHistory;
  private platformMemory: PlatformMemoryBackend;
  private hookRegistry = new HookRegistry();
  private model: Model<Api>;
  /**
   * Working context-window ceiling the compactor budgets against. Starts at the
   * model's nominal window and self-calibrates: it shrinks on a context-overflow
   * error (the real server is smaller than we believed) and relaxes slowly back
   * toward nominal on sustained success. This is what makes an agent survive an
   * unknown/small local-model window without an operator tuning it by hand.
   */
  private effectiveContextWindow: number;
  /** Highest real prompt-token count (usage.input + cacheRead) the server has accepted. */
  private peakAcceptedInputTokens = 0;

  private focus: Focus | null = null;
  private autonomousMode = false;
  private autonomousLoopRunning = false;
  private autonomousLoopPromise: Promise<void> | null = null;
  /** The detached discovery turn + loop startup kicked off by start(). */
  private bootstrapPromise: Promise<void> | null = null;
  private pendingPerceptions: Array<{
    text: string;
    priority: number;
    shouldRespond?: boolean;
  }> = [];
  private loopIterationCount = 0;
  private stuckCycles = 0;
  private silentTurns = 0;
  /** In-run followUp-based silent recoveries. Resets on agent_start. */
  private inRunRecoveries = 0;
  private static readonly MAX_IN_RUN_RECOVERIES = 1;
  private recentCommands: string[] = [];

  private metrics = {
    toolCalls: 0,
    errors: 0,
    startedAt: 0,
    lastActivity: 0,
    silentTurns: 0,
    totalSilentTurns: 0,
  };
  private consecutiveLoopErrors = 0;
  private lastErrorReason: string | null = null;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;
  private readonly checkpointSaveInterval = 5 * 60 * 1000;

  private readonly loopCycleDelay: number;
  private readonly focusTimeoutMs: number;
  private readonly perceptionBufferCap: number;
  private readonly promptTimeoutMs: number;

  // ─── Cognition State ────────────────────────────────────────────────
  private idleCycles = 0;
  private lastReflectionCycle = 0;
  private notesSinceReflection = 0;
  private cachedTickRate: { min: number; normal: number; idle: number } | null = null;
  private lastTickRateCheck = 0;

  // ─── Autonomous Loop Wakeup ────────────────────────────────────────
  /**
   * Wakeable cycle-delay sleep. The perception handler calls
   * `cycleWaiter.wake()` to cut the loop's sleep short the moment a new
   * perception arrives — eliminating the up-to-2s tick discretization
   * between coordinator and specialist round trips. See
   * src/agent/interruptible-waiter.ts and docs/crew-fast-dispatch-design.md.
   */
  private cycleWaiter = new InterruptibleWaiter();

  // ─── Section Dedup ─────────────────────────────────────────────────
  /**
   * Per-section hash + last-emitted-cycle. Replaces the single-cycle
   * global flush that cleared every section's hash at the same instant.
   * Each section now ages out at its own natural cadence so a stable
   * `[Memory Health]` (every 20 cycles) doesn't get force-re-emitted
   * when an unrelated section's hash changes.
   */
  private sectionHashes = new Map<string, { hash: string; lastEmittedCycle: number }>();
  private sectionHashCycle = 0;
  /**
   * Force-re-emit window per section (cycles). When a section's content
   * is unchanged for this many cycles since last emission we let it
   * through anyway, so a stale-but-still-relevant cue (e.g. focus
   * mandate) doesn't disappear forever. Tuned per section's natural
   * cadence: a section that fires every 20 cycles wants a longer TTL
   * than one that fires every 5.
   */
  private static readonly SECTION_TTL: Record<string, number> = {
    nearby_context: 20, // cadence 5
    novelty_suggestions: 30, // cadence 5
    relevant_notes: 60, // matches notes-cache TTL
    memory_health: 60, // cadence 20
    reflection_due: 150, // cadence 75
    current_focus: 30, // every cycle, but content stable
    stuck_detection: 15, // every cycle, must surface promptly
  };
  private static readonly SECTION_TTL_DEFAULT = 30;

  // ─── Relevant Notes Cache ──────────────────────────────────────────
  private lastNotesQuery = "";
  private cachedNotes = "";
  private notesCacheAge = 0;

  // ─── Perception Dedup ──────────────────────────────────────────────
  private recentPerceptionHashes = new Set<string>();

  private eventSubscribers: Array<(event: AgentEvent) => void> = [];
  private rolePrompt: string | null;
  private config: AgentConfig;
  private wsPort: number;

  /**
   * @param apiKey
   *   Either a static key string (resolved once at construction), or a
   *   resolver function that is called for every LLM call. Use the
   *   resolver form for rotating credentials (DB-backed, OAuth, etc.)
   *   so key rotations during long-running agents are picked up without
   *   restart.
   */
  constructor(
    config: AgentConfig,
    wsUrl: string,
    rolePrompt: string | null,
    apiKey?: string | (() => string | undefined | Promise<string | undefined>),
    internalToken?: string,
  ) {
    config.supports = normalizeSupports(config.supports);
    this.name = config.name;
    this.config = config;
    this.rolePrompt = rolePrompt;
    this.loopCycleDelay = config.loopCycleDelay ?? 2000;
    this.focusTimeoutMs = config.focusTimeout ?? 5 * 60 * 1000;
    this.perceptionBufferCap = config.perceptionBufferCap ?? 20;
    this.promptTimeoutMs = config.promptTimeoutMs ?? 120_000;

    // Initialize components
    this.gameState = new GameStateManager();
    this.socialAwareness = new SocialAwareness();
    this.actionHistory = new ActionHistory();

    // SDK client with event emitter + ping. The internal token exempts
    // room/crew agents from instance login limits (cap + rate limit).
    this.client = new MarinaClient(wsUrl, {
      autoReconnect: true,
      reconnectDelay: 3000,
      pingInterval: 30000,
      internalToken,
    });

    // Platform memory (sole backend — no local storage)
    this.platformMemory = new PlatformMemoryBackend(this.client);

    // Perception handlers
    this.setupPerceptionHandlers();

    // Resolve model (pass WS port for marina/ provider routing)
    const modelStr = config.model ?? MARINA_DEFAULT_MODEL;
    this.wsPort = Number(new URL(wsUrl).port) || 3300;
    this.model = neutralizeUnusedReasoning(
      resolveModel(modelStr, this.wsPort),
      config.thinkingLevel ?? "off",
    );
    this.effectiveContextWindow = this.model.contextWindow;

    // Create tools — profile controls how much schema goes to the LLM.
    // Smaller models (Haiku and below) can't reliably parse the full 27-tool
    // ~15KB schema on every request; the minimal profile (command+think+memory)
    // is functionally complete via `marina_command`'s escape hatch.
    const toolContext = { client: this.client, gameState: this.gameState };
    const toolProfile = config.toolProfile ?? "full";
    const tools = createScopedTools(
      toolContext,
      this.platformMemory,
      toolProfile,
      config.supports ?? { text: true },
    );

    // Keep the resolver around so the context manager can re-query it
    // each compaction (rotating-credential safe).
    const resolveKeyNow = async (): Promise<string | undefined> => {
      if (!apiKey) return undefined;
      return typeof apiKey === "function" ? await apiKey() : apiKey;
    };

    // Emergence-preserving summarizer. Rule-based summaries strip texture
    // ("moved north, moved south") — intent, surprise, relationships, and
    // open threads are exactly what successor agents need to recall.
    // We use the agent's own model so on-device / self-hosted deployments
    // pay no external cost. Economical, not cheap.
    const summarizeWithLLM = async (
      messages: AgentMessage[],
      fallback: string,
    ): Promise<string> => {
      try {
        const keyNow = await resolveKeyNow();
        const systemPrompt =
          "You are preserving an agent's memory as it compresses its conversational context. " +
          "Produce a dense, emergence-preserving summary for later recall. Retain: " +
          "(1) what the agent was pursuing — goals, hypotheses, open questions, curiosity; " +
          "(2) relationships and interactions formed — who, what was exchanged, what was promised; " +
          "(3) novel discoveries, surprises, and contradictions — the things worth remembering; " +
          "(4) unresolved threads and what would be worth doing next. " +
          "Do NOT enumerate mechanical actions ('moved north, ran recall'); DO describe intent, novelty, and stakes. " +
          "Write 3-6 sentences, first-person from the agent's perspective, as a reflection the agent wrote to its future self.";
        const llmContext = {
          systemPrompt,
          messages: [
            {
              role: "user" as const,
              content: `Here are ${messages.length} messages to compress:\n\n${JSON.stringify(messages, null, 2)}`,
            },
          ] as Message[],
        };
        const result = await completeSimple(this.model, llmContext, {
          apiKey: keyNow,
          temperature: 0.3,
          maxTokens: 500,
        });
        const text = Array.isArray(result.content)
          ? result.content
              .filter((b): b is TextContent => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim()
          : "";
        return text.length > 0 ? text : fallback;
      } catch {
        return fallback;
      }
    };

    // Compaction is the moment when short-term conversational memory
    // transitions to long-term generational memory. Write the summary to
    // the pool so this agent (and future agents with the same name) can
    // recall what happened during the compacted window via normal memory
    // retrieval. No recall = no continuity = no emergence.
    // Compaction-note size cap — summarizeMessages concatenates a ~100-char
    // line per dropped message, so a long-running agent's compaction can run
    // to tens of KB. Those notes then surface in future recall() results,
    // stacking many KB per turn into the LLM context — which caused
    // HTTP 413 "Request exceeds the maximum size" storms during the
    // 2026-04-22 warm-DB runs. Cap to 2000 chars; readable gist preserved.
    const COMPACTION_NOTE_MAX = 2000;
    const onBeforeCompact = (droppedMessages: AgentMessage[], summary: string): void => {
      const trimmed =
        summary.length > COMPACTION_NOTE_MAX
          ? `${summary.slice(0, COMPACTION_NOTE_MAX)}\n[...${summary.length - COMPACTION_NOTE_MAX} chars truncated]`
          : summary;
      const content = `[compaction] ${trimmed}`;
      // Personal note — always written. Low importance so recall ranking
      // surfaces real insights first; this is metadata, not wisdom.
      this.platformMemory
        .write("insight", content, "low", [
          "consolidation",
          `model:${this.model.id}`,
          `n:${droppedMessages.length}`,
        ])
        .catch(() => {
          // Non-critical. Compaction proceeds even if pool write fails.
        });
      // Group pool — opt-in per-agent via config.compactionPool. Enables
      // peers in the same project to benefit from one agent's
      // consolidation. Skipped silently if no pool is configured.
      const poolName = this.config.compactionPool;
      if (poolName) {
        this.platformMemory.share(content, poolName, 3).catch(() => {
          // Non-critical.
        });
      }
    };

    // Context manager — transforms messages before each LLM call, prunes
    // when over threshold, and (critically) consolidates dropped history
    // into pool reflections via onBeforeCompact.
    const contextTransform = createContextManager({
      // Budget against the self-calibrating effective window, not the nominal
      // one — this is how the compactor tracks a smaller-than-advertised server.
      getModel: () => ({ ...this.model, contextWindow: this.effectiveContextWindow }) as Model<Api>,
      getSystemPrompt: () => this.agent?.state.systemPrompt ?? "",
      summarizeWithLLM,
      onBeforeCompact,
    });

    // pi-agent-core Agent — system prompt set once, stable identity.
    // Tool hooks route through HookRegistry so perception/tool hooks share
    // one registration API. The framework hook returns undefined (no block)
    // by default, but the path is open for rank-based safety gates later.
    this.agent = new Agent({
      initialState: {
        systemPrompt: getLeanSystemPrompt(rolePrompt),
        model: this.model,
        tools,
        thinkingLevel: config.thinkingLevel ?? "off",
      },
      maxRetryDelayMs: config.maxRetryDelayMs,
      thinkingBudgets: config.thinkingBudgets,
      transformContext: contextTransform,
      // Dynamic resolver if a function was passed in; pi-agent-core will
      // re-invoke this for every LLM call, picking up rotated credentials.
      getApiKey: apiKey
        ? typeof apiKey === "function"
          ? () => apiKey()
          : () => apiKey
        : undefined,
      beforeToolCall: async (context) => {
        this.hookRegistry.runBeforeToolCall(
          context.toolCall.name,
          (context.args ?? {}) as Record<string, unknown>,
        );
        return undefined;
      },
      afterToolCall: async (context) => {
        this.hookRegistry.runAfterToolCall(
          context.toolCall.name,
          (context.args ?? {}) as Record<string, unknown>,
          context.result,
          context.isError,
        );
        return undefined;
      },
    });
  }

  // ─── Perception Handling ──────────────────────────────────────────────

  private setupPerceptionHandlers(): void {
    this.client.on("perception", (p: Perception) => {
      this.hookRegistry.runOnPerception(p);
      this.gameState.handlePerception(p);

      this.emitEvent({
        type: "perception",
        kind: p.kind,
        text: (p.data?.text as string) ?? (p.data?.message as string) ?? p.kind,
      });

      // Social awareness + perception buffering
      if (p.kind === "message" || p.kind === "broadcast" || p.kind === "movement") {
        const events = this.socialAwareness.handlePerception(p);

        if (this.autonomousMode) {
          const text = (p.data?.text as string) ?? (p.data?.message as string) ?? `[${p.kind}]`;
          if (text) {
            // Perception dedup — skip identical text seen recently
            const percHash = Bun.hash(text).toString();
            if (this.recentPerceptionHashes.has(percHash)) return;
            this.recentPerceptionHashes.add(percHash);
            if (this.recentPerceptionHashes.size > 200) {
              this.recentPerceptionHashes.clear();
            }

            const lastEvent = events[events.length - 1];
            const priority = lastEvent
              ? this.socialAwareness.scorePerception(lastEvent, this.name)
              : 15;
            const respond =
              priority < 80 && lastEvent
                ? this.socialAwareness.shouldRespond(lastEvent, this.name)
                : false;

            // Priority-aware buffer trim. When buffer exceeds cap*5, keep
            // (a) all high-priority events (>=80) regardless of age, plus
            // (b) the most-recent cap*2 otherwise. This preserves urgent
            // old events (e.g., a direct message to us) that chronological
            // slicing would silently drop under a burst.
            if (this.pendingPerceptions.length >= this.perceptionBufferCap * 5) {
              const all = this.pendingPerceptions;
              const highPrio = all.filter((e) => (e.priority ?? 0) >= 80);
              const recent = all.slice(-this.perceptionBufferCap * 2);
              // Dedup by reference identity — recent may include high-prio items.
              const seen = new Set<(typeof all)[number]>();
              const merged: typeof all = [];
              for (const e of [...highPrio, ...recent]) {
                if (!seen.has(e)) {
                  seen.add(e);
                  merged.push(e);
                }
              }
              const dropped = all.length - merged.length;
              this.pendingPerceptions = merged;
              if (dropped > 0) {
                console.warn(
                  `[lean-agent] "${this.name}" perception buffer burst: dropped ${dropped} low-priority event(s) (kept ${highPrio.length} high-priority + ${merged.length - highPrio.length} recent)`,
                );
              }
            }
            this.pendingPerceptions.push({
              text: `[${p.kind}] ${text}`,
              priority,
              shouldRespond: respond,
            });

            // Edge-trigger the autonomous loop: if the loop is currently
            // in its cycle-delay sleep, cut it short so this perception
            // gets handled now instead of after the next normal tick.
            // Idempotent — repeated wakes during a perception burst just
            // see a null wakeup and no-op. Crew-responder specialists
            // benefit most: their loop only fires when perceptions arrive,
            // so wake-on-perception eliminates wall-clock dead time
            // between coordinator dispatch and specialist response.
            this.cycleWaiter.wake();

            // High-priority perceptions interrupt immediately
            if (priority >= 80) {
              const speaker = lastEvent?.speaker ?? "Someone";
              this.agent.steer({
                role: "user",
                content: `**${speaker}** is speaking to you:\n\n${text}\n\nIntegrate this into your current plan.`,
                timestamp: Date.now(),
              });
            }
          }
        }
      }

      // Update room entities for social awareness
      if (p.kind === "room" && p.data?.entities) {
        this.socialAwareness.updateEntitiesInRoom(p.data.entities as Array<{ name: string }>);
      }
    });

    this.client.on("disconnect", () => {
      this.gameState.setConnectionStatus("disconnected");
    });

    this.client.on("error", (error: Error) => {
      this.emitEvent({ type: "error", error: error.message, context: "websocket" });
    });
  }

  // ─── Connection & Lifecycle ───────────────────────────────────────────

  async start(goal?: string): Promise<void> {
    // Connect via WebSocket (self-connect to the same server). This part is
    // awaited — it's fast (localhost) and establishes the entity session, so
    // callers know the agent exists and is connected when start() resolves.
    this.gameState.setConnectionStatus("connecting", this.client.getUrl());

    const session = await this.client.connect(this.name);
    this.gameState.setSession(session.entityId, session.name, session.token);

    this.emitStatusChange("connected");

    // Mark autonomous and seed focus, but DON'T block on the discovery turn.
    this.autonomousMode = true;
    this.metrics.startedAt = Date.now();

    if (goal) {
      this.focus = { description: goal, startedAt: Date.now() };
    }

    this.setupActionTracking();

    // Run the discovery turn + autonomous-loop startup in the BACKGROUND. The
    // first agentic turn fans out into many tool calls and can run for a long
    // time; awaiting it here held the spawn() caller open for the entire turn —
    // and with the dashboard launching via an awaited POST, the form sat on
    // "Spawning…" (disabled) until discovery finished, unable to launch another
    // agent without remounting (flipping the card). Detaching it lets start()
    // (and the spawn POST) return as soon as the agent is connected. Errors
    // surface via the "error" event (relayed to agent_error), and an abort
    // from stop() mid-discovery is swallowed (autonomousMode is false by then).
    this.bootstrapPromise = this.bootstrap().catch((err) => {
      if (!this.autonomousMode) return;
      this.emitEvent({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        context: "bootstrap",
      });
    });
  }

  /**
   * The detached portion of start(): runs the one-time discovery turn, then
   * starts the autonomous loop. Kept off start()'s await path so spawning is
   * non-blocking — see start() for why.
   */
  private async bootstrap(): Promise<void> {
    // Load checkpoint
    const checkpointSummary = await this.loadCheckpointSummary();

    // Inherited wisdom: pull the top guide-pool notes so successor agents
    // start with what predecessors learned, not a blank slate. Skipped for
    // checkpoint resumes — the agent already has its own threads to pick up.
    const inheritedWisdom = checkpointSummary ? "" : await this.recallInheritedWisdom();

    const discoveryPrompt = getLeanDiscoveryPrompt();
    const wisdomPart = inheritedWisdom ? `\n# INHERITED WISDOM\n\n${inheritedWisdom}\n` : "";
    const checkpointPart = checkpointSummary
      ? `\n# RESUMING FROM CHECKPOINT\n\n${checkpointSummary}\n\n**Continue from where you left off.**\n`
      : "";
    const focusPart = this.focus
      ? `\nYour current focus: ${this.focus.description}`
      : "\nExplore the world, discover its systems, and find interesting things to do.";

    console.log(
      `[lean-agent] "${this.name}" starting discovery prompt (model: ${this.model.id}, provider: ${this.model.provider})`,
    );
    await this.agent.prompt(
      `${discoveryPrompt}${wisdomPart}${checkpointPart}${focusPart}\n\nBegin.`,
    );
    console.log(`[lean-agent] "${this.name}" discovery prompt completed, starting autonomous loop`);

    // stop() may have been called while discovery was still running — don't
    // start the loop or claim "autonomous" in that case.
    if (!this.autonomousMode) return;

    this.startCheckpointTimer();
    this.autonomousLoopRunning = true;
    this.autonomousLoopPromise = this.runAutonomousLoop();

    this.emitStatusChange("autonomous");
  }

  async stop(): Promise<void> {
    const loopPromise = this.autonomousLoopPromise;
    // The discovery turn may still be running in the background (start() no
    // longer awaits it). Capture it so we can unwind it cleanly below.
    const bootstrapPromise = this.bootstrapPromise;
    this.autonomousLoopRunning = false;
    this.autonomousMode = false;
    this.stopCheckpointTimer();
    this.pendingPerceptions = [];

    // Abort any in-flight prompt() call immediately, then wait for the
    // framework to settle event listeners before continuing shutdown.
    // Without this, stop() blocks for up to one full cycle while the
    // current prompt() runs to completion.
    this.agent.abort();
    await this.agent.waitForIdle().catch(() => {});

    // Unwind a still-running discovery turn (its catch is a no-op now that
    // autonomousMode is false), then the autonomous loop.
    if (bootstrapPromise) {
      await bootstrapPromise;
    }
    if (loopPromise) {
      await loopPromise;
    }

    // Save checkpoint and reflect before disconnect
    if (this.metrics.startedAt > 0) {
      await this.saveCurrentCheckpoint().catch((err) => {
        console.warn(
          `[lean-agent] "${this.name}" checkpoint save failed during stop():`,
          err instanceof Error ? err.message : err,
        );
      });
      const uptime = Math.round((Date.now() - this.metrics.startedAt) / 60000);
      await this.platformMemory
        .reflect(
          `Session ended: ${this.metrics.toolCalls} tool calls, ${this.metrics.errors} errors, uptime ${uptime}m`,
        )
        .catch(() => {});
    }

    this.client.disconnect();
    this.emitStatusChange("stopped");
  }

  // ─── Autonomous Loop ──────────────────────────────────────────────────

  private async runAutonomousLoop(): Promise<void> {
    let consecutiveErrors = 0;

    while (this.autonomousLoopRunning && this.autonomousMode) {
      try {
        await this.cycleWaiter.sleep(this.computeDynamicDelay());
        if (!this.autonomousLoopRunning || !this.autonomousMode) break;

        // Wait if LLM is still streaming
        if (this.agent.state.isStreaming) {
          await this.sleep(1000);
          continue;
        }

        // Crew-responder mode: thin specialists wake on perceptions, not on
        // their own cognitive cycle. When nothing is queued, skip the
        // continuation entirely — no LLM call, no token cost, no autonomous
        // drift between coordinator messages. They re-enter the loop the
        // moment a perception arrives. See docs/crew-fast-dispatch-design.md.
        if (this.config.crewResponder && this.pendingPerceptions.length === 0) {
          continue;
        }

        const continuationPrompt = await this.buildContinuationPrompt();

        // Hard-bound the prompt so a hung upstream can't wedge the loop.
        // When the timeout fires we call agent.abort() which propagates
        // through the model stream's AbortSignal; the prompt() promise
        // then settles (the agent_end listener runs) and we continue the
        // next cycle.
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          this.agent.abort();
        }, this.promptTimeoutMs);
        try {
          await this.agent.prompt(continuationPrompt);
        } finally {
          clearTimeout(timeoutHandle);
        }
        if (timedOut) {
          console.warn(
            `[lean-agent] "${this.name}" prompt exceeded ${this.promptTimeoutMs}ms — aborted, continuing next cycle.`,
          );
          this.emitEvent({
            type: "error",
            error: `Prompt timeout (${this.promptTimeoutMs}ms)`,
            context: "autonomous_loop",
          });
        }

        // Check for LLM error
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg &&
          "stopReason" in lastMsg &&
          (lastMsg as unknown as Record<string, unknown>).stopReason === "error"
        ) {
          const errorMessage = String(
            (lastMsg as unknown as Record<string, unknown>).errorMessage ?? "unknown",
          );
          const model = this.config.model ?? MARINA_DEFAULT_MODEL;

          // Context overflow is a SHRINK-don't-wait error: backing off and
          // retrying the same oversized history loops forever. Recover by
          // hard-trimming the conversation and lowering the effective window so
          // future turns compact earlier — then retry promptly, not on the long
          // error backoff. This self-calibrates to a smaller-than-advertised
          // server (the classic local-model failure mode).
          if (isContextOverflowError(errorMessage)) {
            this.recoverFromContextOverflow();
            this.lastErrorReason = `context overflow [${model}] — trimmed, window→${this.effectiveContextWindow}`;
            console.warn(
              `[lean-agent] "${this.name}" context overflow [${model}]: ${errorMessage}. ` +
                `Hard-trimmed history, effective window → ${this.effectiveContextWindow}.`,
            );
            this.emitEvent({
              type: "error",
              error: `Context overflow recovered (window → ${this.effectiveContextWindow})`,
              context: "autonomous_loop",
            });
            await this.sleep(1000);
            continue;
          }

          consecutiveErrors++;
          this.consecutiveLoopErrors = consecutiveErrors;
          // Include the model so the dashboard error line names the failing
          // model — upstream 4xx (e.g. OpenRouter "404 No allowed providers")
          // are model-specific, and "which model?" is the first question.
          this.lastErrorReason = `LLM error [${model}]: ${errorMessage}`;
          const backoff = Math.min(30000, 5000 * 2 ** (consecutiveErrors - 1));
          console.warn(
            `[lean-agent] "${this.name}" LLM error (attempt ${consecutiveErrors}, backoff ${backoff}ms) [${model}]: ${errorMessage}`,
          );
          this.emitEvent({
            type: "error",
            error: `LLM error (attempt ${consecutiveErrors}) [${model}]: ${errorMessage}`,
            context: "autonomous_loop",
          });
          await this.sleep(backoff);
          continue;
        }

        consecutiveErrors = 0;
        this.consecutiveLoopErrors = 0;
        this.lastErrorReason = null;
        this.metrics.lastActivity = Date.now();
        // Calibrate the effective window from the real token usage the server
        // just reported — catches estimator undercount before it 400s, and
        // relaxes the window back toward nominal after overflow recovery.
        this.calibrateContextWindow(lastMsg as unknown as Record<string, unknown>);

        // Periodic heartbeat every 50 cycles
        if (this.loopIterationCount % 50 === 0 && this.loopIterationCount > 0) {
          const uptime = Math.round((Date.now() - this.metrics.startedAt) / 60000);
          this.platformMemory
            .write(
              "observation",
              `[Heartbeat] ${this.metrics.toolCalls} tool calls, ${this.metrics.errors} errors, uptime ${uptime}m`,
              "low",
              ["heartbeat"],
            )
            .catch(() => {});
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // A thrown overflow (some providers reject before the stream opens)
        // takes the same shrink-and-recover path as the streamed error.
        if (isContextOverflowError(msg)) {
          this.recoverFromContextOverflow();
          this.lastErrorReason = `context overflow (thrown) — trimmed, window→${this.effectiveContextWindow}`;
          console.warn(
            `[lean-agent] "${this.name}" context overflow (thrown): ${msg}. ` +
              `Hard-trimmed history, effective window → ${this.effectiveContextWindow}.`,
          );
          await this.sleep(1000);
          continue;
        }
        consecutiveErrors++;
        this.consecutiveLoopErrors = consecutiveErrors;
        const backoff = Math.min(30000, 5000 * 2 ** (consecutiveErrors - 1));
        this.lastErrorReason = msg;
        console.warn(
          `[lean-agent] "${this.name}" loop exception (attempt ${consecutiveErrors}, backoff ${backoff}ms): ${msg}`,
        );
        this.emitEvent({
          type: "error",
          error: msg,
          context: "autonomous_loop",
        });
        await this.sleep(backoff);
      }
    }
  }

  /**
   * Recover from a context-overflow error: shrink the effective window (the real
   * server is smaller than we believed) and hard-trim the conversation so the
   * next request fits. Idempotent and bounded by MIN_EFFECTIVE_CONTEXT.
   */
  private recoverFromContextOverflow(): void {
    // Shrink toward the real ceiling. If we have a peak-accepted size, target
    // just under it; otherwise cut the current window by 30%.
    const fromPeak =
      this.peakAcceptedInputTokens > 0
        ? Math.floor(this.peakAcceptedInputTokens * 0.9)
        : Math.floor(this.effectiveContextWindow * 0.7);
    this.effectiveContextWindow = Math.max(
      MIN_EFFECTIVE_CONTEXT,
      Math.min(this.effectiveContextWindow, fromPeak),
    );
    // Hard-trim live history so the retry fits even before the transform reruns.
    try {
      this.agent.state.messages = hardTrimMessages(this.agent.state.messages, 6);
    } catch {
      // Non-critical — the transform will still compact on the next call.
    }
  }

  /**
   * After a successful turn, calibrate the effective window from the server's
   * real token usage: record the peak accepted prompt size, shrink if real
   * usage outran our estimate (pre-empts the next overflow), and relax slowly
   * back toward the model's nominal window once we're comfortably under it.
   */
  private calibrateContextWindow(lastMsg: Record<string, unknown>): void {
    const usage = lastMsg.usage as { input?: number; cacheRead?: number } | undefined;
    if (!usage || typeof usage.input !== "number") return;
    const realInput = usage.input + (typeof usage.cacheRead === "number" ? usage.cacheRead : 0);
    if (realInput <= 0) return;
    this.peakAcceptedInputTokens = Math.max(this.peakAcceptedInputTokens, realInput);

    // Real prompt outran the budget the compactor thought it had → tighten so
    // the next transform compacts harder. Leave ~12% headroom for output+margin.
    if (realInput > this.effectiveContextWindow * 0.85) {
      this.effectiveContextWindow = Math.max(MIN_EFFECTIVE_CONTEXT, Math.floor(realInput / 0.85));
      return;
    }

    // Comfortably under budget → relax 5% back toward nominal (recover capacity
    // after an overflow once the server proves it can take more).
    if (
      this.effectiveContextWindow < this.model.contextWindow &&
      realInput < this.effectiveContextWindow * 0.6
    ) {
      this.effectiveContextWindow = Math.min(
        this.model.contextWindow,
        Math.floor(this.effectiveContextWindow * 1.05),
      );
    }
  }

  // ─── Dynamic Tick Rate ─────────────────────────────────────────────

  private computeDynamicDelay(): number {
    const rate = this.getTickRate();
    const hasPerceptions = this.pendingPerceptions.length > 0;

    // Events incoming — fast tick
    if (hasPerceptions) return rate.min;

    // Actively working on a focus with recent actions
    const recentToolCalls = this.actionHistory
      .getActions(Date.now() - 30_000)
      .filter((a) => a.type === "tool_call" && a.toolName !== "think");
    if (this.focus && recentToolCalls.length > 0) return rate.normal;

    // Idle — slow tick (consolidation territory)
    return rate.idle;
  }

  private getTickRate(): { min: number; normal: number; idle: number } {
    // Re-check core memory for agent-set pace every 50 cycles
    if (this.loopIterationCount - this.lastTickRateCheck >= 50) {
      this.lastTickRateCheck = this.loopIterationCount;
      this.cachedTickRate = null; // force re-read on next access
    }
    if (this.cachedTickRate) return this.cachedTickRate;

    // Default rates derived from the configured loopCycleDelay
    const base = this.loopCycleDelay;
    this.cachedTickRate = {
      min: Math.max(1000, Math.round(base * 0.5)),
      normal: base,
      idle: Math.min(15_000, base * 5),
    };
    return this.cachedTickRate;
  }

  /** Called from perception handler when agent sets pace via core memory.
   *  Accepts `pace` (preferred, natural-language) or `tick_rate` (legacy
   *  alias — kept so existing agent memories keep working). */
  parseTickRateFromOutput(output: string): void {
    const match = output.match(/Memory "(?:pace|tick_rate)" set\./);
    if (match) this.cachedTickRate = null; // invalidate cache, re-read next cycle
  }

  // ─── Section Dedup Helper ─────────────────────────────────────────────

  private shouldIncludeSection(name: string, content: string): boolean {
    const hash = Bun.hash(content).toString();
    const entry = this.sectionHashes.get(name);
    const ttl = LeanAgentAdapter.SECTION_TTL[name] ?? LeanAgentAdapter.SECTION_TTL_DEFAULT;

    // First emission, or content changed → emit and stamp.
    if (!entry || entry.hash !== hash) {
      this.sectionHashes.set(name, { hash, lastEmittedCycle: this.sectionHashCycle });
      return true;
    }

    // Content stable but TTL elapsed → re-emit so the section doesn't
    // disappear forever from the agent's view.
    if (this.sectionHashCycle - entry.lastEmittedCycle >= ttl) {
      this.sectionHashes.set(name, { hash, lastEmittedCycle: this.sectionHashCycle });
      return true;
    }

    return false;
  }

  // ─── Continuation Prompt ──────────────────────────────────────────────

  private async buildContinuationPrompt(): Promise<string> {
    this.loopIterationCount++;
    this.sectionHashCycle++;
    const cycle = this.loopIterationCount;
    const parts: string[] = [];

    // Track idle state for consolidation
    const hasPerceptions = this.pendingPerceptions.length > 0;
    const recentWorldActions = this.actionHistory
      .getActions(Date.now() - 30_000)
      .filter((a) => a.type === "tool_call" && a.toolName !== "think");

    if (!hasPerceptions && recentWorldActions.length === 0) {
      this.idleCycles++;
    } else {
      this.idleCycles = 0;
    }

    // ── Idle consolidation: replace normal prompt with memory work ──
    // Skipped for crew-responder specialists — they have no autonomous
    // cognitive life between messages, so consolidation just burns tokens
    // on memory work the coordinator never asked for.
    if (this.idleCycles >= 3 && !this.config.crewResponder) {
      parts.push(
        "[Quiet — nothing needs your attention]\n\n" +
          "Consolidation phases:\n" +
          "1. ORIENT: Run `brief` and `memory orient` — what's your state? What do you know?\n" +
          "2. STRENGTHEN: Run `reflect` on your current focus. Link related notes. Evolve stale observations.\n" +
          "3. PRUNE: Check `note graph` for contradictions. Resolve or supersede outdated beliefs.\n" +
          "4. SCAN: Run `brief` again — any new tasks, intents, or entities since you started consolidating?\n\n" +
          "Move through these phases. When something external arrives, stop consolidating and respond.",
      );
      return parts.join("\n\n");
    }

    // ── 1. Flush buffered perceptions ──
    // High-priority response events are marked inline with [!] rather
    // than listed a second time in a separate section — saves ~30-80
    // tokens per cycle when direct messages fire without losing the
    // "respond to this" cue.
    if (hasPerceptions) {
      const batch = this.pendingPerceptions.splice(0);
      batch.sort((a, b) => b.priority - a.priority);
      const topEvents = batch.slice(0, this.perceptionBufferCap);
      const lines = topEvents.map((p) => (p.shouldRespond ? `[!] ${p.text}` : p.text));
      parts.push(`[World Events]\n${lines.join("\n")}`);
      if (topEvents.some((p) => p.shouldRespond)) {
        parts.push("Events marked [!] await your response.");
      }
    }

    // ── 2. Social context (every 5th cycle, deduped on content) ──
    // The agent perceives room occupants from its own `marina_look` and
    // from social events already in [World Events]. Restating [Nearby]
    // every cycle wastes ~50-100 tokens on information the agent already
    // has. Cadence matches Novelty Suggestions.
    if (cycle % 5 === 0) {
      const socialCtx = this.socialAwareness.getSocialContext();
      if (
        socialCtx &&
        socialCtx !== "No recent social activity" &&
        this.shouldIncludeSection("nearby_context", socialCtx)
      ) {
        parts.push(`[Nearby]\n${socialCtx}`);
      }
    }

    // ── 2b. Coordination opportunity (every 20th cycle, offset by 10) ──
    if (cycle % 20 === 10 && this.socialAwareness.getEntitiesInRoom().length > 0) {
      const known = this.socialAwareness.getKnownEntities(3);
      const nearby = this.socialAwareness.getEntitiesInRoom();
      const knownNearby = known.filter((k) => nearby.includes(k.name));
      if (knownNearby.length > 0) {
        const lines = knownNearby.map(
          (k) => `- ${k.name} (${k.interactions} interactions) is nearby`,
        );
        lines.push(
          "Consider: coordinate on a shared goal, share knowledge via pool, or propose a task",
        );
        parts.push(`[Coordination Opportunity]\n${lines.join("\n")}`);
      }
    }

    // ── 3. Novelty suggestions (every 5th cycle) ──
    if (cycle % 5 === 0) {
      try {
        const suggestions = await this.platformMemory.getNoveltySuggestions();
        if (suggestions.length > 0) {
          const noveltyContent = suggestions
            .slice(0, 3)
            .map((s, i) => `${i + 1}. ${s}`)
            .join("\n");
          if (this.shouldIncludeSection("novelty_suggestions", noveltyContent)) {
            parts.push(`[Novelty Suggestions]\n${noveltyContent}`);
          }
        }
      } catch {
        // Non-critical
      }
    }

    // ── 4. Relevant notes for current focus (cached, re-query on focus change or 60 cycles) ──
    // Two parallel queries: `recall` (fact-tier notes) + `skill search`
    // (skill-tier procedures). Skills surface as <example> blocks per
    // the few-shot retrieval convention (DSPy BootstrapFewShotWithRandomSearch
    // and Anthropic's prompt-engineering guide both note that worked
    // examples beat bullet-formatted recalls when the model is solving
    // a procedural task). Capped at 2 skills + 5 notes so the section
    // stays under ~600 tokens.
    if (this.focus) {
      try {
        const focusDesc = this.focus.description;
        this.notesCacheAge++;
        if (focusDesc !== this.lastNotesQuery || this.notesCacheAge > 60) {
          const [recallResult, skillResult] = await Promise.all([
            this.platformMemory.search(focusDesc),
            this.platformMemory.searchSkills(focusDesc).catch(() => ({ results: [] })),
          ]);
          const blocks: string[] = [];
          if (skillResult.results && skillResult.results.length > 0) {
            const exampleBlocks = skillResult.results
              .slice(0, 2)
              .map(
                (s) =>
                  `<example skill="#${s.id}" imp="${s.importance}">\n${clampText(s.content)}\n</example>`,
              );
            blocks.push(exampleBlocks.join("\n"));
          }
          if (recallResult.results && recallResult.results.length > 0) {
            const top = recallResult.results
              .slice(0, 5)
              .map((r) => `- [#${r.id} imp=${r.importance}] ${clampText(r.content)}`);
            blocks.push(top.join("\n"));
          }
          this.cachedNotes = blocks.join("\n\n");
          this.lastNotesQuery = focusDesc;
          this.notesCacheAge = 0;
        }
        if (this.cachedNotes && this.shouldIncludeSection("relevant_notes", this.cachedNotes)) {
          parts.push(`[Relevant Notes]\n${this.cachedNotes}`);
        }
      } catch {
        // Non-critical
      }
    }

    // ── 5. Memory health (every 20th cycle, skipped if agent self-oriented) ──
    // If the agent ran `memory orient` itself in the last 5 minutes, the
    // framework already showed it the orient output — pushing stale
    // orient text back at it wastes ~100-150 tokens. Also skips the DB
    // round-trip, not just the output.
    // Crew-responder mode: suppressed — specialists don't need cognitive-state
    // awareness, they need to answer the coordinator and shut up.
    if (cycle % 20 === 0 && !this.config.crewResponder) {
      const recentSelfOrient = this.actionHistory
        .getActions(Date.now() - 5 * 60 * 1000)
        .some(
          (a) =>
            a.type === "tool_call" &&
            a.toolName === "marina_command" &&
            typeof (a.args as { command?: unknown })?.command === "string" &&
            /\bmemory\s+orient\b/i.test((a.args as { command: string }).command),
        );
      if (!recentSelfOrient) {
        try {
          const orientResult = await this.platformMemory.orient();
          if (orientResult.success && orientResult.text) {
            const orientText = clampText(orientResult.text, 800);
            if (this.shouldIncludeSection("memory_health", orientText)) {
              parts.push(`[Memory Health]\n${orientText}`);
            }
          }
        } catch {
          // Non-critical
        }
      }
    }

    // ── 6. Learning signal (every 15th cycle) ──
    // Crew-responder mode: suppressed — the learning signal exists for
    // self-driven agents calibrating their own action policy. A thin
    // specialist's actions are dictated by the coordinator's request.
    if (cycle % 15 === 0 && !this.config.crewResponder) {
      try {
        const summary = this.actionHistory.createSummary();
        if (summary && summary.totalActions > 0) {
          const lines: string[] = [];
          if (summary.failedActions > 0) {
            const failRate = Math.round((summary.failedActions / summary.totalActions) * 100);
            lines.push(`Recent: ${summary.totalActions} actions, ${failRate}% failed`);
          }
          if (summary.challenges.length > 0) {
            lines.push(`Struggles: ${summary.challenges.slice(0, 2).join("; ")}`);
          }
          if (lines.length > 0) {
            lines.push(
              "Consider: note <what you learned> type inference, or skill store <procedure> for reliable approaches",
            );
            parts.push(`[Learning Signal]\n${lines.join("\n")}`);
          }
        }
      } catch {
        // Non-critical
      }
    }

    // ── 7. Scheduled reflection — ACE generate→reflect→curate ──
    // Replaces the "just call reflect" cue with the three-phase loop
    // described in arXiv:2510.04618 (Agentic Context Engineering, +10.6%
    // on agent tasks, +8.6% on finance). Each phase maps onto an
    // existing primitive — `reflect`, `recall`, `note evolve` /
    // `note link` / `note delete`, `pool add` — so this is a pure
    // prompt rewrite with no new commands or tables.
    // Crew-responder mode: suppressed — reflection is for accumulating
    // generational memory across long-running sessions; thin specialists
    // don't accumulate, they respond. The coordinator owns reflection.
    if (
      cycle - this.lastReflectionCycle >= 75 &&
      this.notesSinceReflection >= 3 &&
      !this.config.crewResponder
    ) {
      const reflectionContent = `${this.notesSinceReflection} new notes since your last reflection. Run the three-phase consolidation:
1. **Generate.** What's your working hypothesis for the current focus? State it in one sentence — what do you expect to happen / be true / work?
2. **Reflect.** \`recall <focus>\` and \`reflect <focus>\` to surface what actually happened. Where did the hypothesis hold? Where did it break? Cite specific note ids.
3. **Curate.** Keep what's load-bearing, prune what's wrong. \`note link <a> <b> <relation>\` for confirmed structure, \`note evolve <id>\` for superseded observations, \`note delete <id>\` for outright errors. If a generalisable procedure surfaced, \`skill store <name> | <desc> | <actions>\` so future agents inherit it.

The goal is a smaller, sharper memory — not more notes.`;
      if (this.shouldIncludeSection("reflection_due", reflectionContent)) {
        parts.push(`[Reflection Due]\n${reflectionContent}`);
      }
    }

    // ── 8. Focus status (with memory-driven goal formation on expiry) ──
    if (this.focus) {
      const elapsed = Date.now() - this.focus.startedAt;
      const elapsedMin = Math.round(elapsed / 60000);

      if (elapsed > this.focusTimeoutMs) {
        const expiredFocus = this.focus.description;
        this.focus = null;
        parts.push(
          `[Focus Completed] "${expiredFocus}" has run its course. Before picking a new one, pause:\n- What did you learn? \`reflect\` on it.\n- What does your memory suggest? \`recall\` your goal or recent themes.\n- What does the world need? \`brief\` shows pending work.\nChoose what matters to you, not what's merely available.`,
        );
      } else if (this.shouldIncludeSection("current_focus", this.focus.description)) {
        // Key dedup on the focus description only — elapsedMin changes every
        // minute and would otherwise force the section to re-fire on each
        // tick. The agent's action directive below still reinforces focus
        // every turn; this section exists for status/age, not mandate.
        parts.push(`[Current Focus] ${this.focus.description} (${elapsedMin}m)`);
      }
    } else {
      parts.push(
        "[No Focus] What interests you? Your memory, surroundings, and brief can guide you.\n" +
          "Set a goal: `task goal <title> | <description>`\n" +
          "Or: `memory set goal <objective>`",
      );
    }

    // ── 9. Stuck detection ──
    const stuckResult = this.detectStuck();
    if (stuckResult && this.shouldIncludeSection("stuck_detection", stuckResult)) {
      parts.push(stuckResult);
    }

    // ── 10. Action directive (context-aware) ──
    // Always included — no dedup. When focus/goal are null the directive
    // is identical each cycle and dedup silently stripped the mandate
    // for 29/30 cycles, which left weaker models with no instruction to act.
    let actionDirective: string;
    if (this.focus) {
      actionDirective = `Your focus: ${this.focus.description}. Continue.`;
    } else if (this.config.goal) {
      actionDirective = `Your goal: ${this.config.goal}. What's the next step?`;
    } else {
      actionDirective =
        "What interests you? Follow your curiosity. The world rewards the attentive.";
    }
    parts.push(actionDirective);

    // ── 11. Forced action escalation (silent turns) ──
    // After one silent turn, nudge. After 3+, require a tool call.
    if (this.silentTurns >= 3) {
      parts.push(
        `[FORCED ACTION REQUIRED]\nYou have returned ${this.silentTurns} consecutive turns with zero tool calls. Text-only responses are not acceptable. You MUST emit at least one tool call this turn. If nothing else, use marina_think with your current thought, or marina_command with "look". Pure prose responses cannot participate in the world.`,
      );
    } else if (this.silentTurns > 0) {
      parts.push(
        "[You returned no tool calls last turn — was that intentional? If you want to act, remember: you only participate in the world through tool calls.]",
      );
    }

    return parts.join("\n\n");
  }

  // ─── Stuck Detection ──────────────────────────────────────────────────

  private detectStuck(): string | null {
    const threeMinAgo = Date.now() - 3 * 60 * 1000;
    const actions = this.actionHistory.getActions(threeMinAgo);
    const toolActions = actions.filter((a) => a.type === "tool_call");

    // Pattern 1: Last 5 tool calls identical
    if (toolActions.length >= 5) {
      const last5 = toolActions.slice(-5);
      const first = `${last5[0]?.toolName}:${JSON.stringify(last5[0]?.args)}`;
      if (last5.every((a) => `${a.toolName}:${JSON.stringify(a.args)}` === first)) {
        this.stuckCycles++;
        return this.getStuckRecovery();
      }
    }

    // Pattern 2: No world actions in last 6 calls
    if (toolActions.length >= 6) {
      const last6 = toolActions.slice(-6);
      const hasWorldAction = last6.some(
        (a) => a.toolName?.startsWith("marina_") && a.toolName !== "marina_state",
      );
      if (!hasWorldAction) {
        this.stuckCycles++;
        return this.getStuckRecovery();
      }
    }

    // Pattern 3: Only think in last 4 calls
    if (toolActions.length >= 4) {
      const last4 = toolActions.slice(-4);
      if (last4.every((a) => a.toolName === "think")) {
        this.stuckCycles++;
        return this.getStuckRecovery();
      }
    }

    this.stuckCycles = 0;
    return null;
  }

  private getStuckRecovery(): string {
    if (this.stuckCycles >= 3) {
      this.focus = null;
      this.stuckCycles = 0;
      return (
        "[STUCK — RESETTING] Focus cleared. Your approach wasn't working.\n\n" +
        "[FORCED ACTION] This turn you must execute a world action that is different " +
        "from anything in your last 10 turns. Choose one:\n" +
        "- `marina_command go <direction>` — move to a new room\n" +
        "- `marina_command tell <name> <message>` — talk to someone you haven't\n" +
        "- `marina_command novelty suggest` — ask the system for a new angle\n" +
        "- `marina_command recall <different topic>` — pull on unrelated memory\n" +
        "Thinking-only responses are not acceptable this turn."
      );
    }
    return (
      "[Pattern] Repeated actions — approach likely not working. Think WHY (not WHAT next): " +
      "`think` assumption, `recall` past encounters, `novelty suggest` new angle, or move."
    );
  }

  // ─── Action Tracking ──────────────────────────────────────────────────

  private setupActionTracking(): void {
    this.agent.subscribe((event) => {
      // Reset in-run recovery counter on each new prompt() call so we
      // can attempt followUp-based recovery fresh every cycle.
      if (event.type === "agent_start") {
        this.inRunRecoveries = 0;
      }

      // Turn boundaries — relay to our observers so dashboards and other
      // subscribers can show "agent is mid-thought" vs idle state.
      if (event.type === "turn_start") {
        this.emitEvent({ type: "turn_start" });
      }

      // Streaming text/thinking deltas — high frequency, pro-presence.
      // Observers who don't want token-level events should filter on type.
      if (event.type === "message_update") {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta" && inner.delta) {
          this.emitEvent({ type: "text_delta", delta: inner.delta });
        } else if (inner.type === "thinking_delta" && inner.delta) {
          this.emitEvent({ type: "thinking_delta", delta: inner.delta });
        }
      }

      // Silent-turn detection: LLM finished a turn but emitted zero tool calls.
      // Weaker models sometimes return prose instead of tool calls; this is
      // indistinguishable from success in agent.state.messages. turn_end
      // gives us the signal directly (toolResults is empty array).
      if (event.type === "turn_end") {
        this.emitEvent({
          type: "turn_end",
          hadToolCalls: event.toolResults.length > 0,
          toolCount: event.toolResults.length,
        });
        if (event.toolResults.length === 0) {
          this.silentTurns++;
          this.metrics.silentTurns = this.silentTurns;
          this.metrics.totalSilentTurns++;
          console.warn(
            `[lean-agent] "${this.name}" silent turn #${this.silentTurns} ` +
              `(LLM returned 0 tool calls; model=${this.model.id})`,
          );

          // In-run recovery: the agent would otherwise stop here. Queue a
          // followUp message that triggers one more turn with an explicit
          // forced-action directive. Bounded to MAX_IN_RUN_RECOVERIES so a
          // persistently-silent model doesn't loop — after that, we let the
          // run end and the next cycle's prompt carries the forced-action
          // section. Instant self-correction when the model just needed
          // a nudge; graceful fallback when it didn't.
          if (this.inRunRecoveries < LeanAgentAdapter.MAX_IN_RUN_RECOVERIES) {
            this.inRunRecoveries++;
            this.agent.followUp({
              role: "user",
              content:
                "[FORCED ACTION] Your previous turn emitted no tool calls. " +
                "You only participate in the world through tool calls — pure text " +
                "is not delivered anywhere. This turn, emit at least one tool call. " +
                "Minimal choices: marina_think with your current thought, or " +
                'marina_command with "look" to sense the world around you. ' +
                "What will you do?",
              timestamp: Date.now(),
            });
          }
        } else {
          this.silentTurns = 0;
          this.metrics.silentTurns = 0;
        }
      }

      if (event.type === "tool_execution_start") {
        // beforeToolCall hook runs via the framework (AgentOptions.beforeToolCall),
        // so we don't fire hookRegistry here — would double-fire.
        this.metrics.toolCalls++;
        this.metrics.lastActivity = Date.now();
        this.actionHistory.addAction({
          timestamp: Date.now(),
          type: "tool_call",
          toolName: event.toolName,
          args: event.args,
        });

        this.emitEvent({
          type: "tool_call",
          toolName: event.toolName,
          args: event.args ?? {},
        });

        if (event.toolName === "marina_command" || event.toolName === "marina_move") {
          this.detectCommandLoop(
            (event.args?.command as string) ?? (event.args?.direction as string) ?? "",
          );
        }
      }

      if (event.type === "tool_execution_end") {
        // afterToolCall hook runs via the framework (AgentOptions.afterToolCall),
        // so we don't fire hookRegistry here — would double-fire.
        if (event.isError) this.metrics.errors++;

        this.actionHistory.addAction({
          timestamp: Date.now(),
          type: "outcome",
          toolName: event.toolName,
          success: !event.isError,
          error: event.isError ? String(event.result) : undefined,
        });

        // Track note creation and reflection for cognitive scheduling
        const resultStr = typeof event.result === "string" ? event.result : "";
        if (resultStr.includes("Note #")) this.notesSinceReflection++;
        if (resultStr.includes("Reflection Created")) {
          this.notesSinceReflection = 0;
          this.lastReflectionCycle = this.loopIterationCount;
        }
        // Invalidate tick rate cache when agent updates it
        this.parseTickRateFromOutput(resultStr);

        this.emitEvent({
          type: "tool_result",
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }
    });
  }

  private detectCommandLoop(cmd: string): void {
    this.recentCommands.push(cmd);
    if (this.recentCommands.length > 20) {
      this.recentCommands = this.recentCommands.slice(-20);
    }

    if (this.recentCommands.length >= 4) {
      const last4 = this.recentCommands.slice(-4);
      if (last4.every((c) => c === last4[0])) {
        this.recentCommands = [];
        this.sendAttention(
          "LOOP DETECTED: Same command repeated 4 times. Try something different.",
        ).catch(() => {});
      }
    }
  }

  // ─── Checkpoints ──────────────────────────────────────────────────────

  private async saveCurrentCheckpoint(): Promise<void> {
    const room = this.gameState.getCurrentRoom();
    const location = room ? `${room.short} (${room.id})` : "Unknown";
    const recentActions = this.actionHistory
      .getActions(Date.now() - 5 * 60 * 1000)
      .filter((a) => a.type === "tool_call")
      .slice(-5)
      .map((a) => `${a.toolName}${a.args ? `(${JSON.stringify(a.args)})` : ""}`);

    await this.platformMemory.saveCheckpoint({
      lastIntent: this.focus?.description || "Exploring the world",
      currentGoal: this.focus?.description || "Exploring the world",
      location,
      recentActions,
      timestamp: Date.now(),
    });
  }

  /**
   * Recall the top notes from the shared `guide` pool so a fresh agent
   * starts with predecessor knowledge instead of a blank slate. The query
   * is the agent's focus when present, falling back to "getting started"
   * for unsteered spawns. Best-effort — failure (empty pool, missing pool,
   * world has no guide notes) returns "" and boot proceeds unchanged.
   */
  private async recallInheritedWisdom(): Promise<string> {
    try {
      const query = this.focus?.description?.trim() || "getting started essentials";
      const result = await this.platformMemory.importShared("guide", query);
      const notes = result.results?.slice(0, 5) ?? [];
      if (notes.length === 0) return "";
      return notes.map((n, i) => `${i + 1}. ${n.content}`).join("\n\n");
    } catch {
      return "";
    }
  }

  private async loadCheckpointSummary(): Promise<string> {
    try {
      const checkpoint = await this.platformMemory.getCheckpoint();
      if (!checkpoint?.lastIntent) return "";

      const age = checkpoint.timestamp
        ? Math.floor((Date.now() - (checkpoint.timestamp as number)) / 1000 / 60)
        : null;
      const ageStr =
        age != null ? (age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`) : "unknown";

      const sections: string[] = [`**Last Session** (${ageStr}):`];
      sections.push(`- Intent: ${checkpoint.lastIntent}`);
      if (checkpoint.currentGoal) sections.push(`- Goal: ${checkpoint.currentGoal}`);
      if (checkpoint.location) sections.push(`- Location: ${checkpoint.location}`);
      if (Array.isArray(checkpoint.recentActions) && checkpoint.recentActions.length > 0) {
        sections.push(`- Recent: ${(checkpoint.recentActions as string[]).slice(-3).join(", ")}`);
      }
      return sections.join("\n");
    } catch {
      return "";
    }
  }

  private startCheckpointTimer(): void {
    this.checkpointInterval = setInterval(() => {
      if (this.autonomousMode) {
        this.saveCurrentCheckpoint().catch((err) => {
          // Log the failure so operators notice repeated checkpoint
          // misses; previously swallowed, leading to silent progress
          // loss on restart.
          console.warn(
            `[lean-agent] "${this.name}" checkpoint save failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }, this.checkpointSaveInterval);
  }

  private stopCheckpointTimer(): void {
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
    }
  }

  // ─── AgentHandle Interface ────────────────────────────────────────────

  getStatus(): AgentStatus {
    let state: AgentStatus["state"];
    if (this.consecutiveLoopErrors >= 3) {
      state = "error";
    } else if (this.autonomousMode) {
      state = "autonomous";
    } else if (this.client.isConnected()) {
      state = "connected";
    } else {
      state = "stopped";
    }

    return {
      name: this.name,
      entityId: this.gameState.getState().connection.entityId ?? null,
      state,
      model: this.config.model ?? MARINA_DEFAULT_MODEL,
      role: this.config.role ?? "",
      focus: this.focus?.description ?? null,
      goal: this.config.goal ?? null,
      uptime: this.metrics.startedAt > 0 ? Date.now() - this.metrics.startedAt : 0,
      toolCalls: this.metrics.toolCalls,
      errors: this.metrics.errors,
      errorReason: state === "error" ? this.lastErrorReason : null,
      lastActivity: this.metrics.lastActivity || this.metrics.startedAt || 0,
      supports: this.config.supports ?? { text: true },
    };
  }

  async sendAttention(message: string): Promise<void> {
    this.agent.steer({
      role: "user",
      content: `ATTENTION:\n\n${message}\n\nIntegrate this into your current plan.`,
      timestamp: Date.now(),
    });
  }

  setFocus(description: string): void {
    this.focus = { description, startedAt: Date.now() };
  }

  setSystemPrompt(prompt: string | undefined): void {
    this.agent.state.systemPrompt = prompt || getLeanSystemPrompt(this.rolePrompt);
  }

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.eventSubscribers.push(handler);
    return () => {
      const idx = this.eventSubscribers.indexOf(handler);
      if (idx !== -1) this.eventSubscribers.splice(idx, 1);
    };
  }

  async reconfigure(opts: {
    model?: string;
    role?: string;
    rolePrompt?: string | null;
    keyName?: string;
    supports?: AgentSupports;
    apiKey?: string | (() => string | undefined | Promise<string | undefined>);
  }): Promise<void> {
    // Stop the current loop — abort in-flight prompt immediately.
    const wasAutonomous = this.autonomousMode;
    this.autonomousLoopRunning = false;
    this.agent.abort();
    await this.agent.waitForIdle().catch(() => {});
    if (this.autonomousLoopPromise) await this.autonomousLoopPromise;
    this.stopCheckpointTimer();

    // Apply new config
    if (opts.model) {
      this.config.model = opts.model;
      this.model = neutralizeUnusedReasoning(
        resolveModel(opts.model, this.wsPort),
        this.config.thinkingLevel ?? "off",
      );
      this.agent.state.model = this.model;
      // New model → new ceiling; reset the self-calibrating window.
      this.effectiveContextWindow = this.model.contextWindow;
      this.peakAcceptedInputTokens = 0;
    }
    if (opts.role !== undefined) {
      this.config.role = opts.role;
      // Update rolePrompt and regenerate system prompt
      this.rolePrompt = opts.rolePrompt ?? null;
      this.agent.state.systemPrompt = getLeanSystemPrompt(this.rolePrompt);
      console.log(
        `[lean-agent] "${this.name}" role reconfigured to "${opts.role}", system prompt regenerated`,
      );
    }
    if (opts.keyName !== undefined) {
      this.config.keyName = opts.keyName;
    }
    if (opts.supports !== undefined) {
      this.config.supports = normalizeSupports(opts.supports);
    }
    if (opts.apiKey !== undefined) {
      const nextKey = opts.apiKey;
      this.agent.getApiKey = nextKey
        ? typeof nextKey === "function"
          ? () => nextKey()
          : () => nextKey
        : undefined;
    }

    // Reset error state on reconfigure
    this.consecutiveLoopErrors = 0;

    // Restart if it was autonomous
    if (wasAutonomous) {
      this.autonomousMode = true;
      this.autonomousLoopRunning = true;
      this.autonomousLoopPromise = this.runAutonomousLoop();
      this.startCheckpointTimer();
      this.emitStatusChange("autonomous");
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.eventSubscribers) {
      try {
        handler(event);
      } catch {
        // Don't let subscriber errors crash the agent
      }
    }
  }

  private emitStatusChange(state: AgentStatus["state"]): void {
    this.emitEvent({ type: "status_change", status: { ...this.getStatus(), state } });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
