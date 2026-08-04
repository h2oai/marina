import type { Engine } from "./engine";

/**
 * Operator-facing capability readiness.
 *
 * Marina's abilities fall into three tiers, and only the third needs operator
 * action — but nothing else surfaces which tier a feature is in or whether it's
 * actually live:
 *   1. Always-on   — read commands + engine auto-emit (chronicle `event` rows,
 *                    feed, standing). No agent, no keys.
 *   2. Seeded      — role/trait definitions + persistent agent configs that a
 *                    world's seed() registers. A config is not a running agent.
 *   3. Agent-driven — narrative/digest synthesis, watch loops, room agents,
 *                    crews. Needs an LLM provider key AND the agent spawned.
 *
 * `computeReadiness` inspects the LIVE instance and reports each capability as
 * ok / degraded / off with a remediation hint, so an operator can answer "is it
 * functioning?" at runtime. Backs the `status` command and `GET /api/readiness`.
 */

export type ReadinessStatus = "ok" | "degraded" | "off";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** Concrete next step when not `ok`. */
  remediation?: string;
}

export interface ReadinessReport {
  instanceName: string;
  world: string;
  generatedAt: number;
  checks: ReadinessCheck[];
  demo: {
    score: number;
    status: "ready" | "warming" | "degraded";
    warmAgents: number;
    expectedAgents: number;
    recentMeaningfulEvents: number;
    medianResponseMs?: number;
  };
}

/** Upstream LLM provider env vars (NOT MODEL_API_KEYS — that's caller auth). */
const PROVIDER_ENV = [
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

export function computeReadiness(engine: Engine): ReadinessReport {
  const env = process.env;
  // True "can agents call a model?" signal. agentRuntime.isAvailable() conflates
  // this with MODEL_API_KEYS (the caller token) and MARINA_OPEN_API, so it
  // over-reports — an agent could spawn yet 503 on its first turn. Check for an
  // actual upstream provider key (env or DB) instead.
  let dbKeyCount = 0;
  try {
    dbKeyCount = engine.db?.getAllApiKeys().length ?? 0;
  } catch {
    /* db may be closed */
  }
  const hasKey = PROVIDER_ENV.some((v) => !!env[v]) || dbKeyCount > 0;
  const agents = engine.agentRuntime.list();
  const activeAgent = (name: string) =>
    agents.find((agent) => agent.name === name && agent.state !== "stopped");
  const runningRole = (role: string) =>
    agents.some((a) => a.role === role && a.state !== "stopped");

  const checks: ReadinessCheck[] = [];

  // ── LLM provider key — gates ALL agent spawning ──────────────────────────
  checks.push(
    hasKey
      ? {
          id: "llm-key",
          label: "LLM provider key",
          status: "ok",
          detail: "a provider key is configured — agents can run",
        }
      : {
          id: "llm-key",
          label: "LLM provider key",
          status: "off",
          detail: "no provider key — agents cannot be spawned",
          remediation:
            "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GEMINI_API_KEY / …), or add a key in Admin → Keys.",
        },
  );

  // ── Agent auto-respawn — whether seeded/saved agents start on boot ────────
  checks.push(
    env.AGENT_AUTORESPAWN === "true"
      ? {
          id: "auto-respawn",
          label: "Agent auto-respawn",
          status: "ok",
          detail: "saved agents (e.g. the Chronicler) respawn on boot",
        }
      : {
          id: "auto-respawn",
          label: "Agent auto-respawn",
          status: "off",
          detail: "saved agents do NOT auto-spawn on boot",
          remediation:
            "Set AGENT_AUTORESPAWN=true to auto-spawn seeded/saved agents, or spawn them manually with `agent spawn`.",
        },
  );

  // ── Chronicler — reads + auto `event` rows always work; this is synthesis ─
  const chroniclerConfig = engine.db?.getAgentConfig("Chronicler");
  const chronicler = activeAgent("Chronicler");
  const chroniclerDegraded =
    chronicler !== undefined && (chronicler.state === "error" || chronicler.silentTurns >= 3);
  if (chronicler && chroniclerDegraded) {
    checks.push({
      id: "chronicler",
      label: "Chronicler",
      status: "degraded",
      detail:
        chronicler.errorReason ??
        `running but non-participating — ${chronicler.silentTurns} consecutive silent turns`,
      remediation:
        "Check the configured model/provider and the agent error log before relying on synthesis.",
    });
  } else if (chronicler) {
    checks.push({
      id: "chronicler",
      label: "Chronicler",
      status: "ok",
      detail:
        chronicler.toolCalls > 0
          ? "running and participating — narrative/digest synthesis is available"
          : "running and warming up — no successful world action recorded yet",
    });
  } else if (chroniclerConfig) {
    checks.push({
      id: "chronicler",
      label: "Chronicler",
      status: "degraded",
      detail:
        "seeded but not running — only auto `event` rows are recorded; no narrative/digest synthesis",
      remediation: hasKey
        ? "Set AGENT_AUTORESPAWN=true, or run: agent spawn Chronicler model marina/default role chronicler"
        : "Configure an LLM provider key first, then AGENT_AUTORESPAWN=true (or: agent spawn Chronicler model marina/default role chronicler).",
    });
  } else {
    checks.push({
      id: "chronicler",
      label: "Chronicler",
      status: "off",
      detail: "no Chronicler agent config seeded in this world",
      remediation:
        "Use a world that seeds it (e.g. default), or run: agent spawn Chronicler model marina/default role chronicler",
    });
  }

  // ── Watcher — watch/probe commands work standalone; this is the loop ──────
  const watcherRole = engine.db?.getRole("watcher");
  checks.push(
    runningRole("watcher")
      ? {
          id: "watcher",
          label: "Watcher",
          status: "ok",
          detail:
            "a watcher agent is running — observation loop active (watch & probe commands always work)",
        }
      : {
          id: "watcher",
          label: "Watcher",
          status: "off",
          detail: watcherRole
            ? "watcher role seeded, but no watcher agent running"
            : "no watcher role seeded in this world",
          remediation:
            "Spawn one: agent spawn Watcher model marina/default role watcher (watch & probe still work without it).",
        },
  );

  // ── Room agents — lazy-spawn on room entry ───────────────────────────────
  if (env.MARINA_ROOM_AGENTS === "false") {
    checks.push({
      id: "room-agents",
      label: "Room agents",
      status: "off",
      detail: "disabled via MARINA_ROOM_AGENTS=false",
      remediation: "Unset MARINA_ROOM_AGENTS to let rooms spawn their agents on first entry.",
    });
  } else if (!hasKey) {
    checks.push({
      id: "room-agents",
      label: "Room agents",
      status: "degraded",
      detail: "enabled but no LLM key — rooms fall back to static entities",
      remediation: "Configure an LLM provider key.",
    });
  } else {
    checks.push({
      id: "room-agents",
      label: "Room agents",
      status: "ok",
      detail: "enabled — rooms spawn their agents (guide, market-oracle, …) on first entry",
    });
  }

  // ── TabH2O forecasting — optional tabular model for `market forecast` ─────
  checks.push(
    env.TABH2O_API_KEY
      ? {
          id: "tabh2o",
          label: "TabH2O forecasting",
          status: "ok",
          detail: "TABH2O_API_KEY set — `market forecast` can call the tabular model",
        }
      : {
          id: "tabh2o",
          label: "TabH2O forecasting",
          status: "off",
          detail: "TABH2O_API_KEY unset — `market forecast` degrades (LLM reasoning still works)",
          remediation: "Set TABH2O_API_KEY to enable tabular forecasting.",
        },
  );

  // ── Model API (/v1) — Marina-as-an-LLM for external clients ───────────────
  const apiAuth = !!env.MODEL_API_KEYS || env.MARINA_OPEN_API === "true";
  if (apiAuth && hasKey) {
    checks.push({
      id: "model-api",
      label: "Model API (/v1)",
      status: "ok",
      detail:
        "caller auth and an upstream key are configured — use a model probe to verify live reachability",
    });
  } else if (apiAuth) {
    checks.push({
      id: "model-api",
      label: "Model API (/v1)",
      status: "degraded",
      detail:
        "auth set but no upstream provider — /v1 returns 503 until a key or model agent exists",
      remediation: "Configure an LLM provider key (or run a model-channel provider agent).",
    });
  } else {
    checks.push({
      id: "model-api",
      label: "Model API (/v1)",
      status: "off",
      detail: "no caller auth — /v1 rejects external clients",
      remediation: "Set MODEL_API_KEYS=<token> (or MARINA_OPEN_API=true for local dev).",
    });
  }

  // ── Demo pulse — measured participation, activity, and request latency ───
  const demoNames = ["Host", "Builder", "Critic", "Chronicler"].filter((name) =>
    engine.db?.getAgentConfig(name),
  );
  const expectedNames = demoNames.length > 0 ? demoNames : agents.map((agent) => agent.name);
  const warmAgents = expectedNames.filter((name) => {
    const agent = activeAgent(name);
    return (
      agent?.state === "autonomous" &&
      !agent.errorReason &&
      agent.silentTurns < 3 &&
      (agent.toolCalls > 0 || agent.lastTurnMs > 0)
    );
  }).length;
  let recentMeaningfulEvents = 0;
  const responseDurations: number[] = [];
  try {
    const recent = engine.db?.queryFeedEvents({ since: Date.now() - 5 * 60_000, limit: 200 }) ?? [];
    const durableEvents = recent.filter(
      (event) =>
        event.kind !== "channel_message" &&
        !event.kind.endsWith("_received") &&
        !event.kind.endsWith("_routed") &&
        event.kind !== "agent_turn_start" &&
        event.kind !== "agent_turn_end",
    ).length;
    // Conversation demonstrates presence, but a lively loop is not equivalent
    // to durable progress. At most two chat events contribute to the pulse.
    recentMeaningfulEvents =
      durableEvents + Math.min(2, recent.filter((e) => e.kind === "channel_message").length);
    for (const event of recent) {
      if (event.kind !== "model_request_completed" || !event.payload) continue;
      const duration = (JSON.parse(event.payload) as { durationMs?: unknown }).durationMs;
      if (typeof duration === "number" && Number.isFinite(duration))
        responseDurations.push(duration);
    }
  } catch {
    // A closed/new database should degrade the score, never readiness itself.
  }
  responseDurations.sort((a, b) => a - b);
  const medianResponseMs =
    responseDurations.length > 0
      ? responseDurations[Math.floor(responseDurations.length / 2)]
      : undefined;
  const warmRatio = expectedNames.length > 0 ? warmAgents / expectedNames.length : 0;
  const score = Math.round(
    (hasKey ? 20 : 0) +
      (env.AGENT_AUTORESPAWN === "true" ? 10 : 0) +
      warmRatio * 30 +
      Math.min(20, recentMeaningfulEvents * 4) +
      (medianResponseMs === undefined
        ? 5
        : medianResponseMs < 5000
          ? 20
          : medianResponseMs < 20_000
            ? 15
            : 8),
  );
  const demo = {
    score,
    status:
      score >= 70 ? ("ready" as const) : score >= 40 ? ("warming" as const) : ("degraded" as const),
    warmAgents,
    expectedAgents: expectedNames.length,
    recentMeaningfulEvents,
    ...(medianResponseMs !== undefined ? { medianResponseMs } : {}),
  };
  checks.push({
    id: "demo-pulse",
    label: "Demo pulse",
    status: demo.status === "ready" ? "ok" : "degraded",
    detail: `${demo.score}/100 — ${warmAgents}/${expectedNames.length} agents warm, ${recentMeaningfulEvents} meaningful events in 5m${medianResponseMs === undefined ? "" : `, ${medianResponseMs}ms median response`}`,
    ...(demo.status === "ready"
      ? {}
      : {
          remediation:
            "Enable AGENT_AUTORESPAWN, wait for seeded agents to warm, then run one demo scenario or model probe.",
        }),
  });

  return {
    instanceName: engine.instanceName,
    world: engine.world?.name ?? "unknown",
    generatedAt: Date.now(),
    checks,
    demo,
  };
}
