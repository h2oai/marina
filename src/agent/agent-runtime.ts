/**
 * Agent Runtime — central manager for spawning and managing AI agents.
 *
 * The runtime is always present. Spawning requires LLM API keys to be configured.
 * Agents self-connect via WebSocket — the engine sees them as regular connections.
 */

import { MARINA_DEFAULT_MODEL } from "../engine/constants";
import {
  inferModelCapabilities,
  isLocalProvider,
  LOCAL_PROVIDERS,
  MODEL_DISCOVERY_PROVIDERS,
} from "../net/model-discovery";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";
import type { AgentConfig, AgentHandle, AgentStatus, AgentSupports } from "./agent-types";
import { classifyModelResolution, LeanAgentAdapter } from "./lean-agent-adapter";
import { detectModelLimits } from "./model-probe";
import { getRolePrompt, inferTaskCategory } from "./roles";
import { isSeedDisabled } from "./seed-registry";

const KNOWN_PROVIDERS = new Set<string>([...MODEL_DISCOVERY_PROVIDERS, "marina"]);
const DEFAULT_SUPPORTS: AgentSupports = { text: true };
type SupportsLike = Partial<Record<"text" | "image" | "video", unknown>> | undefined;

function normalizeSupports(supports: SupportsLike): AgentSupports {
  const normalized: AgentSupports = { text: supports?.text !== false };
  if (supports?.image === true) normalized.image = true;
  if (supports?.video === true) normalized.video = true;
  return normalized;
}

function supportsFromModel(model: string | undefined): AgentSupports {
  if (!model) return DEFAULT_SUPPORTS;
  const snapshot = inferModelCapabilities(model);
  return normalizeSupports({
    text: snapshot.text,
    image: snapshot.image,
    video: snapshot.video,
  });
}

function resolveSupports(model: string | undefined, provided?: AgentSupports): AgentSupports {
  if (provided) return normalizeSupports(provided);
  return supportsFromModel(model);
}

function parseSupports(raw: string | null | undefined): AgentSupports | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as SupportsLike;
    return normalizeSupports(parsed);
  } catch {
    return undefined;
  }
}

// ─── Internal Model Token ───────────────────────────────────────────────────
// Generated once at startup — room agents use this to authenticate against the
// local model API without requiring MARINA_OPEN_API=true or MODEL_API_KEYS.
const INTERNAL_MODEL_TOKEN = `marina-internal-${crypto.randomUUID().slice(0, 16)}`;

/** Return the internal bearer token that room agents use for the local model API. */
export function getInternalModelToken(): string {
  return INTERNAL_MODEL_TOKEN;
}

// ─── Agent Runtime ──────────────────────────────────────────────────────────

/** Global cap on concurrently running agents. Exported so the spawn
 * command can clamp per-parent budgets to it (see docs/conductor-design.md). */
export const MAX_AGENTS = Number(process.env.MAX_AGENTS) || 30;
const MAX_AGENT_UPTIME_MS = Number(process.env.MAX_AGENT_UPTIME_MS) || 24 * 60 * 60 * 1000;

/**
 * Pick a tool profile for a role.
 *
 * The `crew` and `minimal` profiles drop typed tools in favour of a compact
 * natural-language command roster baked into `marina_command`. They cut
 * prompt size by ~10× for thin specialists, but our crew protocol leans on
 * `marina_tell` as a typed tool — without it specialists reliably miss
 * coordinator handoffs (smaller models stop committing to tool calls at the
 * rate the crew protocol expects).
 *
 * Until the slim profiles can keep the coordination surfaces (`tell`,
 * `channel`, `pool`) typed, the default is `full` universally. The other
 * profiles stay in the codebase for deliberate experiments; flip via
 * `AgentConfig.toolProfile`.
 */
const COMPACT_TOOL_ROLES = new Set([
  "general",
  "guide",
  "architect",
  "scholar",
  "chronicler",
  "coding-agent",
]);

function inferToolProfile(role: string | null | undefined): "full" | "crew" | "minimal" {
  const normalized = role?.trim().toLowerCase();
  return inferCrewResponder(normalized) || (normalized ? COMPACT_TOOL_ROLES.has(normalized) : false)
    ? "crew"
    : "full";
}

/**
 * Specialist roles that should run as thin crew responders — wake on
 * perception, answer the coordinator, sleep. No autonomous cognitive
 * cycle (memory health / learning signal / ACE reflection / idle
 * consolidation are all suppressed when crewResponder=true). See
 * `AgentConfig.crewResponder` and docs/crew-fast-dispatch-design.md.
 *
 * Endpoint coordinators are event-driven too: they retain full autonomy over
 * routing and synthesis after a request arrives, but do not wander into
 * unrelated bounties while callers wait or burn tokens between requests.
 *
 * Adding a role here is the single touchpoint for marking a new
 * specialist as a crew responder; no DB migration needed because the
 * flag is derived at spawn from the saved role string.
 */
const CREW_RESPONDER_ROLES = new Set<string>([
  "mathematician",
  "skeptic",
  "format-verifier",
  "historian",
  "scholar",
  "chronicler",
  "crew-reflector",
  "translator",
  "answerer",
  "councilor",
  "debater",
  "decomposer",
]);

export function inferCrewResponder(role: string | null | undefined): boolean {
  if (!role) return false;
  return CREW_RESPONDER_ROLES.has(role);
}

export class AgentRuntime {
  private agents = new Map<string, AgentHandle>();
  private agentUnsubscribers = new Map<string, () => void>();
  /** Names currently spawning. Used to prevent concurrent spawns of the
   * same name racing past the `agents.has()` check during the await
   * window inside spawn(). */
  private spawnsInFlight = new Set<string>();
  private lastSpawnAt = 0;
  private db?: MarinaDB;
  private wsPort: number;
  private uptimeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private onEvent?: (event: EngineEvent) => void;

  constructor(opts: { db?: MarinaDB; wsPort?: number; onEvent?: (event: EngineEvent) => void }) {
    this.db = opts.db;
    this.wsPort = opts.wsPort ?? 3300;
    this.onEvent = opts.onEvent;
  }

  /** Configure the in-process WebSocket endpoint without replacing this runtime instance. */
  setWsPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid agent WebSocket port: ${port}`);
    }
    if (this.agents.size > 0 || this.spawnsInFlight.size > 0) {
      throw new Error("Cannot change the agent WebSocket port while agents are running");
    }
    this.wsPort = port;
  }

  /**
   * Initialize: auto-respawn agents from saved configs.
   * Call after WebSocket server is ready.
   */
  async init(): Promise<number> {
    if (!this.db) return 0;

    // Skip operator-retired agents so a disable survives even if a stale config
    // row lingers in the DB (it normally won't — disable deletes it — but env
    // overlays and user-saved configs can both name a disabled agent).
    const configs = this.db.getAllAgentConfigs().filter((c) => !isSeedDisabled(this.db, c.name));

    // Spawn in parallel with a 1.1s stagger between starts. Awaiting
    // spawn() sequentially blocks on each agent's discovery prompt (which
    // can take minutes with tools available), so N configs take N × minutes
    // — that's fine for 3 agents, broken for 8. Stagger respects the
    // spawn cooldown (1s) while letting discoveries run concurrently.
    const STAGGER_MS = 1100;
    const spawnPromises = configs.map(async (config, i) => {
      await new Promise((r) => setTimeout(r, i * STAGGER_MS));
      try {
        await this.spawn({
          name: config.name,
          model: config.model,
          role: config.role || undefined,
          goal: config.goal || undefined,
          keyName: config.key_name || undefined,
          room: config.room || undefined,
          supports: parseSupports(config.supports),
          toolProfile: inferToolProfile(config.role),
          crewResponder: inferCrewResponder(config.role),
        });
        if (config.room) {
          // Give the agent a moment to connect, then direct it to its room
          setTimeout(async () => {
            const handle = this.agents.get(config.name);
            if (handle) {
              try {
                await handle.sendAttention(`Navigate to your assigned room: goto ${config.room}`);
              } catch {
                /* agent may not be ready yet */
              }
            }
          }, 5000);
        }
        return true;
      } catch (error) {
        console.warn(
          `[agents] Failed to respawn agent "${config.name}":`,
          error instanceof Error ? error.message : error,
        );
        return false;
      }
    });

    const results = await Promise.all(spawnPromises);
    const spawned = results.filter(Boolean).length;

    if (spawned > 0) {
      console.log(`[agents] Respawned ${spawned} agent(s) from saved configs.`);
    }

    // Start periodic uptime enforcement
    this.uptimeCheckInterval = setInterval(() => this.enforceUptimeLimits(), 60_000);

    return spawned;
  }

  /**
   * Spawn a new agent. Connects via WebSocket and starts autonomous loop.
   */
  async spawn(config: AgentConfig): Promise<AgentHandle> {
    if (this.agents.has(config.name) || this.spawnsInFlight.has(config.name)) {
      throw new Error(`Agent "${config.name}" is already running.`);
    }

    if (this.agents.size + this.spawnsInFlight.size >= MAX_AGENTS) {
      throw new Error(
        `Agent limit reached (${MAX_AGENTS}). Stop an agent before spawning another.`,
      );
    }

    // Spawn cooldown — prevent thundering herd. Only the *check* runs here;
    // lastSpawnAt is set on the success path (after start) so a spawn that
    // fails validation/start doesn't burn the window and reject the operator's
    // immediate corrected retry.
    const now = Date.now();
    if (now - this.lastSpawnAt < 1000) {
      throw new Error("Spawn cooldown — wait 1 second between spawns.");
    }

    // Reserve the name synchronously, before any awaits, so a second
    // concurrent spawn with the same name fails fast at the guard above
    // instead of both passing and racing to agents.set(). Released in
    // the finally block — on success the name moves into `agents`, on
    // failure it's freed for retry.
    this.spawnsInFlight.add(config.name);
    const savedPolicy = this.db?.getAgentConfig(config.name);
    try {
      // Resolve role prompt from DB. PRISM-style task-conditional
      // gating: infer the agent's primary task category from its goal
      // string and pass it to getRolePrompt so traits that declared
      // `applicableTasks` outside this category are suppressed for
      // this agent. Inference is keyword-based and conservative —
      // when no signal is found, no gating is applied (current
      // behavior preserved).
      let rolePrompt: string | null = null;
      if (config.role && this.db) {
        const taskCategory = inferTaskCategory(config.goal);
        rolePrompt = getRolePrompt(this.db, config.role, taskCategory);
      }

      // Crew-responder mode: if the caller didn't set it explicitly, infer
      // from the role name. Specialist roles (mathematician, scholar, etc.)
      // default to crew responders; coordinator and freeform roles stay
      // false. Explicit values from the caller win.
      const resolvedModel = config.model ?? this.db?.getDefaultModel() ?? MARINA_DEFAULT_MODEL;
      const supports = resolveSupports(resolvedModel, config.supports);

      // Autodetect the real context window for local models so the compactor
      // budgets against the truth. Best-effort: skipped when the caller pinned a
      // value or an env override exists (operator intent wins), and a failed /
      // unreachable probe silently falls back to the conservative default.
      let detectedContextWindow: number | undefined;
      const spawnProvider = this.extractProvider(resolvedModel);
      const ctxEnv = LOCAL_PROVIDERS[spawnProvider]?.contextWindowEnv;
      if (
        config.contextWindow === undefined &&
        isLocalProvider(spawnProvider) &&
        !(ctxEnv && process.env[ctxEnv])
      ) {
        const limits = await detectModelLimits(resolvedModel).catch(() => null);
        if (limits?.contextWindow) {
          detectedContextWindow = limits.contextWindow;
          console.log(
            `[agent-runtime] Autodetected context window ${limits.contextWindow} for "${config.name}" (${resolvedModel}, ${limits.source}).`,
          );
        }
      }

      const effectiveConfig: AgentConfig = {
        ...config,
        attentionMode: config.attentionMode ?? savedPolicy?.attention_mode,
        attentionThreshold: config.attentionThreshold ?? savedPolicy?.attention_threshold,
        // No explicit model → use the operator's runtime default (DB), then the
        // env/built-in default. This is what makes "change the default once the
        // world is running" apply to newly spawned agents.
        model: resolvedModel,
        crewResponder: config.crewResponder ?? inferCrewResponder(config.role),
        supports,
        ...((config.contextWindow ?? detectedContextWindow)
          ? { contextWindow: config.contextWindow ?? detectedContextWindow }
          : {}),
      };

      // Validate a key exists at spawn time (fail fast on missing config),
      // but hand the adapter a resolver so rotations in the DB are picked
      // up on every LLM call without restarting the agent.
      const apiKeyAtSpawn = this.resolveApiKey(resolvedModel, config.keyName);
      const modelStr = resolvedModel;
      const provider = this.extractProvider(modelStr);
      if (!KNOWN_PROVIDERS.has(provider)) {
        // Most common cause: caller passed a bare model id ("claude-opus-4-7")
        // expecting it to resolve, when the runtime requires "<provider>/<id>".
        // Differentiate the missing-slash case from the typoed-provider case.
        const hint = modelStr.includes("/")
          ? `Unknown provider "${provider}". Known providers: ${[...KNOWN_PROVIDERS].join(", ")}.`
          : `Model "${modelStr}" is missing the provider prefix. Use "<provider>/<model-id>" (e.g. "anthropic/claude-sonnet-4-5-20250929"). Known providers: ${[...KNOWN_PROVIDERS].join(", ")}.`;
        throw new Error(hint);
      }
      // Local runtimes (llama.cpp / Ollama) are key-optional — a self-hosted
      // server may be keyless. `marina` uses the internal token. Every other
      // provider needs a key up front so we fail fast instead of at first call.
      if (!apiKeyAtSpawn && provider !== "marina" && !isLocalProvider(provider)) {
        throw new Error(
          `No API key for provider "${provider}". Add one via dashboard Admin > Keys, or run: bun run init`,
        );
      }
      // Remote Marina target with no resolvable key: allowed (the remote may run
      // MARINA_OPEN_API), but warn so a 401 later isn't a surprise.
      if (provider === "marina" && modelStr.includes("@") && !apiKeyAtSpawn) {
        console.warn(
          `[agent-runtime] Spawning "${config.name}" against remote Marina "${modelStr}" with no key. ` +
            `This works only if the remote runs MARINA_OPEN_API=true; otherwise add a token via Admin > Keys and pass \`key <name>\`.`,
        );
      }
      // The provider is known and keyed, but the specific model id may still be
      // absent from the bundled model registry. An unlisted id under a known
      // provider can still be routed ("synthesized" → the upstream validates
      // it); only a provider with nothing to route through forces a silent
      // switch to the default model. Fail fast on the unroutable case, and warn
      // (attributed to the agent) on the unlisted case so a typoed/unsupported
      // id is debuggable up front rather than as a downstream 4xx.
      if (provider !== "marina") {
        const resolution = classifyModelResolution(modelStr);
        if (resolution === "fallback") {
          throw new Error(
            `Model "${modelStr}" can't be routed — provider "${provider}" has no models in the registry. ` +
              `Use "<provider>/<model-id>" with a supported provider: ${[...KNOWN_PROVIDERS].join(", ")}.`,
          );
        }
        if (resolution === "synthesized") {
          console.warn(
            `[agent-runtime] Spawning "${config.name}" with model "${modelStr}": id not in the bundled registry ` +
              `for "${provider}". Routing to ${provider} with default params — verify the id is valid for that provider if it errors.`,
          );
        }
      }
      const apiKeyResolver = () => this.resolveApiKey(effectiveConfig.model, config.keyName);

      // Create adapter — use effectiveConfig so the inferred crewResponder
      // flag (and any other adapter-level defaults) reach the runtime.
      const wsUrl = `ws://localhost:${this.wsPort}`;
      const adapter = new LeanAgentAdapter(
        effectiveConfig,
        wsUrl,
        rolePrompt,
        apiKeyResolver,
        INTERNAL_MODEL_TOKEN,
      );

      // Relay per-agent adapter events as engine events so dashboard / MCP /
      // gateway peers can observe agent cognitive lifecycle: errors, turn
      // boundaries, streaming thought, and state transitions. Registered
      // BEFORE start() so the initial connected/autonomous status changes
      // (start() emits "connected" synchronously and "autonomous" from the
      // background discovery turn) are observed rather than fired into the void.
      if (this.onEvent) {
        const onEvent = this.onEvent;
        const unsub = adapter.subscribe((event) => {
          const now = Date.now();
          switch (event.type) {
            case "status_change":
              onEvent({
                type: "agent_state_change",
                name: config.name,
                state: event.status.state,
                timestamp: now,
              });
              break;
            case "error":
              onEvent({
                type: "agent_error",
                name: config.name,
                error: event.error,
                timestamp: now,
              });
              break;
            case "tool_call":
              onEvent({
                type: "agent_tool_call",
                name: config.name,
                toolName: event.toolName,
                risk: event.risk,
                trustSources: event.trustSources,
                timestamp: now,
              });
              break;
            case "tool_result":
              onEvent({
                type: "agent_tool_result",
                name: config.name,
                toolName: event.toolName,
                isError: event.isError,
                timestamp: now,
              });
              break;
            case "turn_start":
              onEvent({ type: "agent_turn_start", name: config.name, timestamp: now });
              break;
            case "turn_end":
              onEvent({
                type: "agent_turn_end",
                name: config.name,
                hadToolCalls: event.hadToolCalls,
                toolCount: event.toolCount,
                timestamp: now,
              });
              break;
            case "text_delta":
              onEvent({
                type: "agent_text_delta",
                name: config.name,
                delta: event.delta,
                timestamp: now,
              });
              break;
            case "thinking_delta":
              onEvent({
                type: "agent_thinking_delta",
                name: config.name,
                delta: event.delta,
                timestamp: now,
              });
              break;
          }
        });
        this.agentUnsubscribers.set(config.name, unsub);
      }

      // Start the agent — connects synchronously, then runs the discovery turn
      // in the background (see LeanAgentAdapter.start), so this resolves as soon
      // as the agent is connected instead of after the whole first turn.
      await adapter.start(config.goal);

      // Spawn succeeded — now consume the cooldown window.
      this.lastSpawnAt = Date.now();

      // Track it
      this.agents.set(config.name, adapter);

      // Save config for auto-respawn
      if (this.db) {
        this.db.saveAgentConfig({
          name: config.name,
          // Snapshot the resolved model so respawns are stable even if the
          // operator later changes the runtime default.
          model: effectiveConfig.model ?? MARINA_DEFAULT_MODEL,
          role: config.role,
          goal: config.goal,
          keyName: config.keyName,
          room: config.room,
          spawnedBy: config.spawnedBy ?? "system",
          supports: effectiveConfig.supports ?? supports,
        });
      }

      return adapter;
    } finally {
      this.spawnsInFlight.delete(config.name);
    }
  }

  /**
   * Stop a running agent by name. Also clears any in-flight spawn
   * reservation under the same name — without that, a hung discovery
   * prompt would leave the name permanently unbookable.
   */
  async stop(name: string, opts?: { keepConfig?: boolean }): Promise<void> {
    // Resolve to the canonical map key so `agent stop alice` finds "Alice".
    // Falls back to the raw name for the in-flight-only path (a spawn still
    // reserving the name, not yet in the agents map).
    const key = this.resolveKey(name) ?? name;
    const agent = this.agents.get(key);
    const inFlight = this.spawnsInFlight.has(key);
    if (!agent && !inFlight) {
      throw new Error(`Agent "${name}" is not running.`);
    }

    if (agent) {
      await agent.stop();
      this.agents.delete(key);
    }

    // Free the in-flight slot so a fresh spawn with the same name can
    // proceed. The original spawn() finally block will also try to
    // delete this on its way out — that's harmless (Set.delete is
    // idempotent on missing keys).
    this.spawnsInFlight.delete(key);

    // Clean up event subscriber
    const unsub = this.agentUnsubscribers.get(key);
    if (unsub) {
      unsub();
      this.agentUnsubscribers.delete(key);
    }

    // Remove saved config — unless the caller is winding the agent down to
    // restart it (graceful shutdown). An explicit `agent stop` / entity
    // removal means "this agent is gone", so the config is deleted and it
    // won't respawn. A shutdown means "see you on the next boot", so the
    // config must survive for AgentRuntime.init() to respawn it — otherwise
    // user-spawned agents silently vanish on every restart.
    if (this.db && !opts?.keepConfig) {
      this.db.deleteAgentConfig(key);
    }
  }

  /**
   * Stop all running agents (for graceful shutdown). Preserves saved configs
   * so every agent — system-seeded AND user-spawned — respawns on the next
   * boot. Each agent's stop() still flushes its checkpoint first.
   */
  async stopAll(): Promise<void> {
    if (this.uptimeCheckInterval) {
      clearInterval(this.uptimeCheckInterval);
      this.uptimeCheckInterval = null;
    }
    const names = [...this.agents.keys()];
    await Promise.allSettled(names.map((name) => this.stop(name, { keepConfig: true })));
  }

  /**
   * Resolve a caller-supplied name to the canonical agent-map key.
   *
   * Exact match wins; otherwise a *unique* case-insensitive match is used.
   * Returns undefined when nothing matches or the case-insensitive match is
   * ambiguous (two agents differing only in case — vanishingly rare, but we
   * refuse to guess rather than act on the wrong one). Keeps lookups
   * (`agent status alice`) in step with `agent list` and the engine's own
   * case-insensitive name resolution, instead of failing on a case mismatch.
   */
  private resolveKey(name: string): string | undefined {
    if (this.agents.has(name)) return name;
    const lower = name.toLowerCase();
    const matches = [...this.agents.keys()].filter((k) => k.toLowerCase() === lower);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Get an agent handle by name. Case-insensitive (see resolveKey).
   */
  get(name: string): AgentHandle | undefined {
    const key = this.resolveKey(name);
    return key ? this.agents.get(key) : undefined;
  }

  /**
   * Reconfigure a running agent with resolved role prompt and API key.
   * This is the proper entry point — it resolves DB-dependent values before
   * delegating to the adapter.
   */
  async reconfigure(
    name: string,
    opts: { model?: string; role?: string; keyName?: string; supports?: AgentSupports },
  ): Promise<void> {
    const key = this.resolveKey(name);
    const agent = key ? this.agents.get(key) : undefined;
    if (!agent || !key) throw new Error(`Agent "${name}" is not running.`);

    // Resolve role prompt from DB if role is changing. Re-infer task
    // category from the agent's current goal so trait gating stays
    // consistent across reconfigures.
    let rolePrompt: string | null | undefined;
    if (opts.role !== undefined && this.db) {
      const goal = agent.getStatus().goal ?? undefined;
      const taskCategory = inferTaskCategory(goal);
      rolePrompt = getRolePrompt(this.db, opts.role, taskCategory);
    }

    // Rebuild the resolver so the adapter keeps picking up DB rotations
    // after reconfigure. Resolve once now to fail fast on missing config.
    const effectiveModel = opts.model ?? agent.getStatus().model;
    const apiKeyAtReconfigure = this.resolveApiKey(effectiveModel, opts.keyName);
    const provider = this.extractProvider(effectiveModel);
    if (!apiKeyAtReconfigure && provider !== "marina") {
      throw new Error(`No API key for provider "${provider}".`);
    }
    const apiKeyResolver = () => this.resolveApiKey(effectiveModel, opts.keyName);

    const currentStatus = agent.getStatus();
    const supports =
      opts.supports !== undefined
        ? normalizeSupports(opts.supports)
        : opts.model !== undefined
          ? supportsFromModel(effectiveModel)
          : (currentStatus.supports ?? DEFAULT_SUPPORTS);

    await agent.reconfigure({
      model: opts.model,
      role: opts.role,
      rolePrompt,
      keyName: opts.keyName,
      supports,
      apiKey: apiKeyResolver,
    });

    // Persist updated config to DB
    if (this.db) {
      const status = agent.getStatus();
      this.db.saveAgentConfig({
        name: key,
        model: status.model,
        role: status.role || undefined,
        goal: status.goal || undefined,
        keyName: opts.keyName,
        spawnedBy: "system",
        supports,
      });
    }
  }

  setAttentionMode(name: string, mode: "focused" | "balanced" | "open"): void {
    const agent = this.get(name);
    if (!agent) throw new Error(`Agent "${name}" is not running.`);
    if (!agent.setAttentionMode)
      throw new Error(`Agent "${name}" does not support attention modes.`);
    agent.setAttentionMode(mode);
    this.db?.updateAttentionPolicy(name, mode);
  }

  recordAttentionFeedback(name: string, feedback: "useful" | "noise"): number {
    const agent = this.get(name);
    if (!agent) throw new Error(`Agent "${name}" is not running.`);
    const saved = this.db?.recordAttentionFeedback(name, feedback);
    const threshold =
      saved?.attention_threshold ??
      Math.max(
        10,
        Math.min(
          90,
          (agent.getStatus().attentionThreshold ?? 50) + (feedback === "useful" ? -5 : 5),
        ),
      );
    agent.setAttentionThreshold?.(threshold);
    return threshold;
  }

  recordAttentionOutcome(name: string, outcome: "success" | "failure"): number | undefined {
    const saved = this.db?.recordAutomaticAttentionOutcome(name, outcome);
    if (!saved) return undefined;
    this.get(name)?.setAttentionThreshold?.(saved.attention_threshold);
    return saved.attention_threshold;
  }

  /** Restart in place while preserving the saved config and current focus. */
  async restart(name: string, opts?: { model?: string }): Promise<AgentHandle> {
    const key = this.resolveKey(name);
    const agent = key ? this.agents.get(key) : undefined;
    if (!key || !agent) throw new Error(`Agent "${name}" is not running.`);
    const status = agent.getStatus();
    const saved = this.db?.getAgentConfig(key);
    await this.stop(key, { keepConfig: true });
    const cooldownRemaining = 1_000 - (Date.now() - this.lastSpawnAt);
    if (cooldownRemaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, cooldownRemaining));
    }
    const restarted = await this.spawn({
      name: key,
      model: opts?.model || saved?.model || status.model,
      role: saved?.role || status.role || undefined,
      goal: saved?.goal || status.goal || undefined,
      keyName: saved?.key_name || undefined,
      room: saved?.room || undefined,
      spawnedBy: saved?.spawned_by || "system",
    });
    if (status.focus) restarted.setFocus(status.focus);
    return restarted;
  }

  /**
   * List all running agents with their status. Includes agents whose
   * spawn is still in flight (state="starting") so a hung discovery
   * prompt is visible to operators instead of presenting as "not
   * running but already running."
   */
  list(): AgentStatus[] {
    const running = [...this.agents.values()].map((a) => a.getStatus());
    const inFlight: AgentStatus[] = [];
    for (const name of this.spawnsInFlight) {
      if (this.agents.has(name)) continue; // already represented above
      inFlight.push({
        name,
        entityId: null,
        state: "starting",
        model: "",
        role: "",
        focus: null,
        goal: null,
        uptime: 0,
        toolCalls: 0,
        errors: 0,
        errorReason: null,
        lastActivity: 0,
        supports: DEFAULT_SUPPORTS,
        contextWindow: 0,
        effectiveContextWindow: 0,
        maxOutputTokens: 0,
        peakInputTokens: 0,
        lastTurnMs: 0,
        avgTurnMs: 0,
        silentTurns: 0,
      });
    }
    return [...running, ...inFlight];
  }

  /**
   * Check if agent spawning is available (API keys present).
   */
  isAvailable(): boolean {
    return this.hasAnyApiKey();
  }

  /**
   * Get the count of running agents.
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Resolve a provider API key for non-text surfaces (media generation, etc.).
   */
  getProviderKey(provider: string, keyName?: string): string | undefined {
    if (provider === "marina") return INTERNAL_MODEL_TOKEN;
    return this.resolveApiKey(`${provider}/_`, keyName);
  }

  // ─── Uptime Enforcement ────────────────────────────────────────────────

  private enforceUptimeLimits(): void {
    for (const [name, agent] of this.agents) {
      const status = agent.getStatus();
      if (status.uptime > MAX_AGENT_UPTIME_MS) {
        console.log(
          `[agents] Agent "${name}" exceeded max uptime (${Math.round(MAX_AGENT_UPTIME_MS / 3600000)}h), stopping.`,
        );
        this.stop(name).catch((e) =>
          console.warn(`[agents] Failed to stop overdue agent "${name}":`, e),
        );
      }
    }
  }

  // ─── API Key Resolution ───────────────────────────────────────────────

  private resolveApiKey(model?: string, keyName?: string): string | undefined {
    const provider = this.extractProvider(model ?? MARINA_DEFAULT_MODEL);

    // Marina model API. The LOCAL instance accepts the auto-generated internal
    // token. A REMOTE target ("marina@host") does not — it needs a real
    // MODEL_API_KEYS bearer token, supplied via `key <name>`. If none is given
    // we send no auth header, which works against a remote running
    // MARINA_OPEN_API=true and 401s otherwise (surfaced as a runtime error).
    if (provider === "marina") {
      if (!(model ?? "").includes("@")) return INTERNAL_MODEL_TOKEN;
      if (keyName && this.db) {
        const dbKey = this.db.getApiKey(keyName);
        if (dbKey) return dbKey.encrypted_value;
      }
      return undefined;
    }

    // 1. Explicit key name → DB lookup
    if (keyName && this.db) {
      const dbKey = this.db.getApiKey(keyName);
      if (dbKey) return dbKey.encrypted_value;
    }

    // 2. DB keys by provider (first match)
    if (this.db) {
      const providerKeys = this.db.getApiKeysByProvider(provider);
      if (providerKeys.length > 0) return providerKeys[0]!.encrypted_value;
    }

    // 3. Fall back to environment variables
    const envMap: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      groq: ["GROQ_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      cerebras: ["CEREBRAS_API_KEY"],
      xai: ["XAI_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY"],
      // Media generation. Stability/Runway/Flux/Luma have their own keys; Google
      // Imagen + Veo reuse the google entry above.
      stability: ["STABILITY_API_KEY"],
      runway: ["RUNWAY_API_KEY"],
      flux: ["BFL_API_KEY"],
      luma: ["LUMA_API_KEY"],
      // Self-hosted local runtimes. The key is optional (Ollama is keyless, a
      // bare-metal llama.cpp may omit `--api-key`); when the server requires one
      // it's read from here. Key-optional spawn is enforced separately below.
      llama: [LOCAL_PROVIDERS.llama!.keyEnv],
      ollama: [LOCAL_PROVIDERS.ollama!.keyEnv],
    };

    const vars = envMap[provider] ?? [];
    for (const v of vars) {
      const value = process.env[v];
      if (value) return value;
    }

    return undefined;
  }

  private extractProvider(model: string): string {
    // Strip a remote-Marina "@host" suffix ("marina@https://host/v1" → "marina")
    // before the slash-based parse so the host can't masquerade as a provider.
    const head = model.split("@")[0] ?? model;
    const slash = head.indexOf("/");
    return slash >= 0 ? head.slice(0, slash) : head;
  }

  private hasAnyApiKey(): boolean {
    // Marina open API mode enables room agents without external keys
    if (process.env.MARINA_OPEN_API === "true") return true;
    if (process.env.MODEL_API_KEYS) return true;

    const keyVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "CEREBRAS_API_KEY",
      "XAI_API_KEY",
      "MISTRAL_API_KEY",
      "DEEPSEEK_API_KEY",
    ];
    if (keyVars.some((v) => !!process.env[v])) return true;
    // A local-only operator (no cloud keys) opts in by configuring a self-hosted
    // runtime — either a key or an explicit base URL counts as "LLM available".
    for (const spec of Object.values(LOCAL_PROVIDERS)) {
      if (process.env[spec.keyEnv] || process.env[spec.baseUrlEnv]) return true;
    }
    if (this.db) {
      try {
        if (this.db.getAllApiKeys().length > 0) return true;
      } catch {
        // DB may be closed during shutdown
      }
    }
    return false;
  }
}
