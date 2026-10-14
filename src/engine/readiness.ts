// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { intelligenceScale } from "../agent/available-models";
import { listToolProbeResults } from "../agent/tool-call-probe";
import { lastFilingWatch } from "../arena/filing-watch";
import { arenaStatus } from "../arena/service";
import { earnedGateCalibration, loadCalibration } from "../decisions/calibrate";
import { decisionConfigFromEnv } from "../decisions/config";
import {
  classifierEngineModels,
  ensembleMembers,
  harnessGateEnabled,
  listEngines,
  resolveEngine,
} from "../decisions/engines";
import { activeGateQuestions, BASELINE_GATE_QUESTIONS } from "../decisions/gate-questions";
import { decisionHealth } from "../decisions/health";
import { describeDecisionSettings } from "../decisions/settings";
import { competenceMap } from "../forecast/competence";
import { providerSetupHint } from "../net/model/provider-setup";
import { describeRouteHealth } from "../net/model/route-health";
import { localModelApiKey } from "../net/model-api/shared";
import { describeDefaultUpstream, hasProviderKey } from "../net/model-api/upstream";
import { ALERT_AFTER_FAILURES, schedulesMode } from "../schedules/runner";
import { autoRespawnEnabled } from "./auto-respawn";
import { type AutonomyPosture, getAutonomyPosture } from "./autonomy";
import type { Engine } from "./engine";
import { corpusEmbeddingStatus } from "./search-providers/corpus-vectors";
import { searchBackendHealth } from "./search-providers/health";
import { describeSearchReadiness } from "./search-readiness";
import { dailySpend, formatSpendUsd, scopeSpendToday } from "./spend-ledger";
import {
  getTrustProfile,
  isLocalProfile,
  isLocalUngated,
  isOpenApiMode,
  type TrustProfile,
} from "./trust-profile";

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
 * functioning?" at runtime. Backs the `readiness` command (aliases `doctor` /
 * `health`) and `GET /api/readiness`.
 */

export type ReadinessStatus = "ok" | "degraded" | "off";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** Concrete next step when not `ok`. */
  remediation?: string;
  /**
   * An optional extra: the core experience works without it. A non-ok
   * optional check is rendered neutrally, never counted as `off`/`degraded`
   * in summaries, and never a demo blocker. `status` keeps its own meaning.
   */
  optional?: true;
}

/** Summary counts; a non-ok optional check counts only as `optional`. */
export function readinessCounts(checks: readonly ReadinessCheck[]): {
  ok: number;
  degraded: number;
  off: number;
  optional: number;
} {
  const counts = { ok: 0, degraded: 0, off: 0, optional: 0 };
  for (const c of checks) counts[c.status !== "ok" && c.optional ? "optional" : c.status]++;
  return counts;
}

/** Where a missing model provider is reported; dependent checks point here. */
const SEE_PROVIDER = "Configure a model provider first (see LLM provider configuration).";

/** WHO this instance is for, and whether permissions are enforced. */
export interface ReadinessTrustProfile {
  profile: TrustProfile;
  /** True only under `local` without `MARINA_AUTONOMY=guarded` — gates, rank
   *  floors, witnesses and exec prompts are off; audit stays on. */
  ungated: boolean;
  /** Why gates are enforced (absent when ungated). */
  reason?: string;
  autonomy: AutonomyPosture;
}

export function computeTrustProfile(env: NodeJS.ProcessEnv = process.env): ReadinessTrustProfile {
  const profile = getTrustProfile(env);
  const ungated = isLocalUngated(env);
  const autonomy = getAutonomyPosture(env);
  let reason: string | undefined;
  if (!ungated) {
    reason =
      profile === "local"
        ? "MARINA_AUTONOMY=guarded re-enforces every permission check on this local instance"
        : profile === "shared"
          ? "shared instance — gates, ranks and limits enforced; sign-in identifies people"
          : "public instance — everything enforced; passwordless names carry no authority";
  }
  return { profile, ungated, autonomy, ...(reason ? { reason } : {}) };
}

export interface ReadinessReport {
  instanceName: string;
  world: string;
  generatedAt: number;
  trustProfile: ReadinessTrustProfile;
  checks: ReadinessCheck[];
  demo: {
    score: number;
    status: "ready" | "warming" | "degraded";
    warmAgents: number;
    expectedAgents: number;
    recentMeaningfulEvents: number;
    recentPrimitiveActions: number;
    activeParticipants: number;
    activeAgents: number;
    recentCommunications: number;
    marinaToolCalls: number;
    autonomyQualified: boolean;
    medianResponseMs?: number;
  };
}

/**
 * What "autonomy qualified" means, over the last 5 minutes: agents acting on
 * their own, talking to each other and using Marina's tools, fast enough to
 * watch. One source for readiness, `readiness autonomy` and `qualify:autonomy`.
 */
export const AUTONOMY_REQUIREMENTS = {
  activeAgents: 2,
  recentPrimitiveActions: 3,
  recentCommunications: 1,
  marinaToolCalls: 2,
  maximumMedianResponseMs: 30_000,
} as const;

export function computeReadiness(engine: Engine): ReadinessReport {
  const env = process.env;
  const upstream = describeDefaultUpstream(engine);
  const hasKey = upstream !== undefined;
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
          label: "LLM provider configuration",
          status: "ok",
          detail: `upstream ${upstream} is configured; run readiness providers to verify connectivity`,
        }
      : {
          id: "llm-key",
          label: "LLM provider configuration",
          status: "off",
          detail: "no supported provider key or local runtime is configured",
          remediation: `${providerSetupHint()} Admin → Keys also works.`,
        },
  );

  // ── Provider routes — a first-party key's usage limit (not Marina's cap) ──
  const routeLines = describeRouteHealth({
    hasOpenRouterKey: hasProviderKey(engine, "openrouter"),
    env,
  });
  if (routeLines.length > 0) {
    checks.push({
      id: "provider-routes",
      label: "Provider routes",
      status: "degraded",
      detail: routeLines.join(" · "),
      remediation:
        "A provider account limit, not Marina's daily spend cap: wait for the reset (Marina re-probes on its own), raise the limit in the provider console, or add OPENROUTER_API_KEY so the same models are served via OpenRouter meanwhile (MARINA_PROVIDER_FALLBACK=off disables that).",
    });
  }

  // ── Intelligence scale — Marina sizes every feature to what is configured ──
  // A single model is a working (degraded) tier, never an error: verification
  // self-checks, decisions use an uncalibrated classifier on that model,
  // forecasts use one analyst × K runs, routing has one candidate.
  const scale = intelligenceScale(env);
  if (scale.tier !== "none") {
    checks.push({
      id: "intelligence-scale",
      label: "Intelligence scale",
      status: scale.tier === "multi" ? "ok" : "degraded",
      detail: scale.summary,
      ...(scale.tier === "single"
        ? {
            remediation:
              "Optional: add a second provider (any key, or OPENROUTER_API_KEY for many vendors) for cross-vendor analysts, checkers and routing.",
          }
        : {}),
    });
  }

  // ── Tool calling — spawn-time probes of unlisted / OpenRouter models ──────
  const probes = listToolProbeResults();
  if (probes.length > 0) {
    const silent = probes.filter((p) => p.outcome === "no-tool-call");
    checks.push(
      silent.length > 0
        ? {
            id: "tool-calling",
            label: "Model tool calling",
            status: "degraded",
            detail: `no tool call from ${silent.map((p) => `${p.model} (${p.detail})`).join(", ")}`,
            remediation:
              "Agents on these models may stay silent. Choose a model that calls tools; MARINA_TOOL_PROBE=refuse stops such crew leads at spawn.",
          }
        : {
            id: "tool-calling",
            label: "Model tool calling",
            status: "ok",
            detail: `probed models call tools: ${probes.map((p) => p.model).join(", ")}`,
          },
    );
  }

  // ── Agent auto-respawn — whether seeded/saved agents start on boot ────────
  const autoRespawn = autoRespawnEnabled(engine.agentRuntime.isAvailable(), env);
  const autoRespawnExplicit = !!env.AGENT_AUTORESPAWN?.trim();
  checks.push(
    autoRespawn
      ? {
          id: "auto-respawn",
          label: "Agent auto-respawn",
          status: "ok",
          detail: autoRespawnExplicit
            ? "saved agents (e.g. the Chronicler) respawn on boot"
            : "saved agents (e.g. the Chronicler) respawn on boot (local-install default; AGENT_AUTORESPAWN=false turns it off)",
        }
      : !autoRespawnExplicit && isLocalProfile(env) && !engine.agentRuntime.isAvailable()
        ? {
            id: "auto-respawn",
            label: "Agent auto-respawn",
            status: "off",
            detail:
              "off only because no model provider is configured — on by default for this local install once one is",
            remediation: SEE_PROVIDER,
          }
        : {
            id: "auto-respawn",
            label: "Agent auto-respawn",
            status: "off",
            detail: autoRespawnExplicit
              ? "saved agents do NOT auto-spawn on boot (AGENT_AUTORESPAWN)"
              : "saved agents do NOT auto-spawn on boot (default: on only for a local install with a provider)",
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
      remediation: !hasKey
        ? autoRespawnExplicit || !isLocalProfile(env)
          ? `${SEE_PROVIDER} Then AGENT_AUTORESPAWN=true (or: agent spawn Chronicler model marina/default role chronicler).`
          : `${SEE_PROVIDER} It then respawns on the next boot (local default), or now: agent spawn Chronicler model marina/default role chronicler`
        : autoRespawn
          ? "Restart to respawn it, or run: agent spawn Chronicler model marina/default role chronicler"
          : "Set AGENT_AUTORESPAWN=true, or run: agent spawn Chronicler model marina/default role chronicler",
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
          optional: true,
          detail: watcherRole
            ? "watcher role seeded, but no watcher agent running (watch & probe work without it)"
            : "no watcher role in this world (watch & probe work without it)",
          remediation: !hasKey
            ? SEE_PROVIDER
            : watcherRole
              ? "Optional: agent spawn Watcher model marina/default role watcher"
              : "Optional: the markets and showcase worlds seed the watcher role (MARINA_WORLD=markets); here, `role create watcher …` first, then agent spawn Watcher model marina/default role watcher",
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
      remediation: SEE_PROVIDER,
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
          optional: true,
          detail: "TABH2O_API_KEY unset — `market forecast` degrades (LLM reasoning still works)",
          remediation: "Set TABH2O_API_KEY to enable tabular forecasting.",
        },
  );

  // ── Search — backends for `web search` and forecast research, from real calls ─
  const search = describeSearchReadiness(env, searchBackendHealth());
  checks.push({
    id: "search",
    label: "Web search & research retrieval",
    status: search.status,
    detail: search.detail,
    ...(search.remediation ? { remediation: search.remediation } : {}),
  });

  // ── Corpus hybrid search — optional; BM25 serves whenever it does not apply ─
  const corpusEmbeddings = corpusEmbeddingStatus(env);
  checks.push(
    corpusEmbeddings.state === "configured"
      ? {
          id: "corpus-hybrid",
          label: "Corpus hybrid search",
          status: "ok",
          detail: `query embeddings ${corpusEmbeddings.model}; corpora holding vectors from this model rank BM25 + dense (others stay BM25)`,
        }
      : corpusEmbeddings.state === "invalid"
        ? {
            id: "corpus-hybrid",
            label: "Corpus hybrid search",
            status: "degraded",
            detail: `MARINA_CORPUS_EMBEDDINGS is invalid (${corpusEmbeddings.error}); corpora rank with BM25`,
            remediation:
              "Fix the MARINA_CORPUS_EMBEDDING_* settings or unset MARINA_CORPUS_EMBEDDINGS.",
          }
        : {
            id: "corpus-hybrid",
            label: "Corpus hybrid search",
            status: "off",
            optional: true,
            detail: "corpora rank with BM25 (optional: dense vectors fused with BM25)",
            remediation:
              "Optional: set MARINA_CORPUS_EMBEDDINGS (local, ollama or any OpenAI-compatible endpoint) and run `bun run corpus embed <name>`.",
          },
  );

  // ── Daily spend — the world's upstream dollars today vs its cap ────────────
  const spend = dailySpend(env);
  if (spend.capUsd !== undefined) {
    const share = spend.spentUsd / spend.capUsd;
    const source = env.MARINA_DAILY_SPEND_CAP_USD?.trim()
      ? "MARINA_DAILY_SPEND_CAP_USD"
      : "default cap; set MARINA_DAILY_SPEND_CAP_USD to change it";
    checks.push({
      id: "daily-spend",
      label: "Daily spend",
      status: spend.reached ? "off" : share >= 0.8 ? "degraded" : "ok",
      detail: `${formatSpendUsd(spend.spentUsd)} of ${formatSpendUsd(spend.capUsd)} today (UTC, ${source})${spend.reached ? " — model calls, decisions, forecasts and media generation are refused; agents paused" : ""}`,
      ...(spend.reached || share >= 0.8
        ? {
            remediation:
              "Wait for 00:00 UTC, or raise MARINA_DAILY_SPEND_CAP_USD=<usd> (operator env, restart; 0 = no cap) if the spend is intended.",
          }
        : {}),
    });
  } else {
    checks.push({
      id: "daily-spend",
      label: "Daily spend",
      status: "ok",
      detail: `${formatSpendUsd(spend.spentUsd)} today (UTC) — uncapped (MARINA_DAILY_SPEND_CAP_USD=${env.MARINA_DAILY_SPEND_CAP_USD?.trim() ?? "0"})`,
    });
  }

  // ── Schedules — owners' commands run later or on a repeat ─────────────────
  checks.push(schedulesCheck(engine));

  // ── Periodic jobs — a failing tick job is otherwise visible only in logs ───
  checks.push(tickJobsCheck(engine));

  // ── Budget scopes — command-line jobs sharing this world's spend ledger ────
  let scopes: { scope: string; spentUsd: number }[] = [];
  try {
    scopes = engine.db ? scopeSpendToday(engine.db) : [];
  } catch {
    // allow-empty-catch: a database without migration 156 has no scopes to report
  }
  if (spend.invalidScope !== undefined || spend.scope || scopes.length) {
    const own = spend.scope;
    const ownReached = own?.reached || spend.invalidScope !== undefined;
    checks.push({
      id: "spend-scopes",
      label: "Spend scopes",
      status: ownReached ? "off" : "ok",
      detail: [
        ...(spend.invalidScope !== undefined
          ? [
              `MARINA_SPEND_SCOPE=${JSON.stringify(spend.invalidScope)} is invalid — all spend refused`,
            ]
          : []),
        ...(own
          ? [
              `this process: ${own.name} ${formatSpendUsd(own.spentUsd)}${own.capUsd !== undefined ? ` of ${formatSpendUsd(own.capUsd)}` : " (uncapped)"}`,
            ]
          : []),
        ...(scopes.length
          ? [`today: ${scopes.map((s) => `${s.scope} ${formatSpendUsd(s.spentUsd)}`).join(", ")}`]
          : []),
      ].join("; "),
      ...(ownReached
        ? {
            remediation:
              "Wait for 00:00 UTC, raise MARINA_SPEND_SCOPE_CAP_USD=<usd> (0 = no scope cap), or fix MARINA_SPEND_SCOPE.",
          }
        : {}),
    });
  }

  // ── Model API (/v1) — Marina-as-an-LLM for external clients ───────────────
  const apiAuth = !!env.MODEL_API_KEYS || !!localModelApiKey(env) || isOpenApiMode(env);
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
      remediation: `${SEE_PROVIDER} (Or run a model-channel provider agent.)`,
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

  // ── Decisions — cheap per-step judgement calls (src/decisions) ───────────
  const decisions = decisionConfigFromEnv(env);
  const decisionHealthNow = decisionHealth(engine.getEventLog());
  if (!decisions) {
    checks.push({
      id: "decisions",
      label: "Decisions (route / gate / verify)",
      status: "off",
      optional: true,
      detail:
        (env.MARINA_DECISIONS?.trim().toLowerCase() === "off"
          ? "MARINA_DECISIONS=off"
          : `MARINA_DECISIONS=${env.MARINA_DECISIONS?.trim() || "auto"} found no provider to answer with`) +
        (classifierEngineModels(env)
          ? " — no configured backend; Marina's own engines still answer /v1/systemone (see decision-engines)"
          : " — no decision backend; /v1/decisions returns 404"),
      remediation:
        "Configure any model provider (auto then answers through it), turn a backend on at runtime (operator): `admin decisions set backend jev` or Admin → Ops → Decisions; or set MARINA_DECISIONS=decisions-api (Jev family / OpenJev) / chat-classifier (any chat model) in the environment — see config/environment.reference.",
    });
  } else if (!decisions.apiKey && /^https:\/\//.test(decisions.baseUrl)) {
    checks.push({
      id: "decisions",
      label: "Decisions (route / gate / verify)",
      status: "degraded",
      detail: `${decisions.kind} → ${decisions.model} at ${decisions.baseUrl}, but no API key`,
      remediation: "Set MARINA_DECISION_API_KEY (or OPENROUTER_API_KEY for openrouter.ai).",
    });
  } else if (decisionHealthNow.status === "degraded") {
    checks.push({
      id: "decisions",
      label: "Decisions (route / gate / verify)",
      status: "degraded",
      detail:
        `${decisions.kind} → ${decisions.model}: ${decisionHealthNow.errors} of the last ${decisionHealthNow.total} decisions failed in ${Math.round(decisionHealthNow.windowMs / 60_000)} min` +
        (decisionHealthNow.lastError
          ? ` (latest: ${decisionHealthNow.lastError.slice(0, 160)})`
          : "") +
        (harnessGateEnabled(env)
          ? " — the gate fails closed, so mutating agent calls are being blocked"
          : ""),
      remediation:
        "Check the decision backend's reachability and key (MARINA_DECISION_BASE_URL / MARINA_DECISION_API_KEY), or raise MARINA_DECISION_TIMEOUT_MS; Admin → Ops → Decisions shows the failures.",
    });
  } else {
    checks.push({
      id: "decisions",
      label: "Decisions (route / gate / verify)",
      status: "ok",
      detail:
        `${decisions.kind} → ${decisions.model}${decisions.kind === "marina-self" ? " through Marina's own /v1" : ` at ${decisions.baseUrl}`} (MARINA_DECISIONS=${env.MARINA_DECISIONS?.trim() || "auto"}); agent tool gate ${harnessGateEnabled(env) ? "on" : "off"} (MARINA_DECISION_GATE)` +
        (decisions.kind !== "decisions-api"
          ? " — scores are uncalibrated: the gate uses one threshold (0.5) and asks a person; a decisions-api / typesafe backend gives graded probabilities"
          : ""),
    });
  }

  // ── Decision engines — Marina as a Jev-compatible endpoint + its own harness ──
  {
    const engineId = env.MARINA_DECISION_ENGINE?.trim();
    const calibrationPath = env.MARINA_DECISION_CALIBRATION?.trim();
    const problems: string[] = [];
    if (engineId) {
      const r = resolveEngine(engineId, env);
      if ("error" in r) problems.push(`MARINA_DECISION_ENGINE=${engineId}: ${r.error.message}`);
    }
    if (env.MARINA_DECISION_ENSEMBLE?.trim()) {
      const r = ensembleMembers(env) ? resolveEngine("marina/ensemble", env) : undefined;
      if (!r || "error" in r) {
        problems.push(
          `MARINA_DECISION_ENSEMBLE: ${r && "error" in r ? r.error.message : "needs at least two distinct engines"}`,
        );
      }
    }
    const calibration = calibrationPath ? loadCalibration(env) : undefined;
    if (calibrationPath && !calibration) {
      problems.push(
        `MARINA_DECISION_CALIBRATION=${calibrationPath} is unreadable, invalid, or writable by group/others`,
      );
    }
    const questionsPath = env.MARINA_DECISION_GATE_QUESTIONS?.trim();
    const questions = activeGateQuestions(env);
    if (questionsPath && questions === BASELINE_GATE_QUESTIONS) {
      problems.push(
        `MARINA_DECISION_GATE_QUESTIONS=${questionsPath} was refused (unreadable, invalid, not earned, or writable by group/others)`,
      );
    }
    const engines = listEngines(env);
    const runtimeSet = engine.db
      ? describeDecisionSettings(engine.db)
          .filter((v) => v.source === "runtime")
          .map((v) => `${v.name}=${v.value}`)
      : [];
    const runtimeNote = runtimeSet.length
      ? `; set at runtime: ${runtimeSet.join(", ")} (admin decisions history)`
      : "";
    const earned = calibration
      ? Object.keys(calibration.engines).filter((m) => earnedGateCalibration(m, env))
      : [];
    if (problems.length > 0) {
      checks.push({
        id: "decision-engines",
        label: "Decision engines (/v1/systemone, harness)",
        status: "degraded",
        detail: `${problems.join("; ")} — falling back to the configured backend / no calibration`,
        remediation:
          "Fix the engine id (GET /v1/decisions/models lists them), the ensemble members, or regenerate the calibration file with `bun run qualify:decisions -- --calibrate <file>` and chmod 644 it.",
      });
    } else if (engines.length === 0) {
      checks.push({
        id: "decision-engines",
        label: "Decision engines (/v1/systemone, harness)",
        status: "off",
        optional: true,
        detail: `no decision engines — nothing answers /v1/systemone${runtimeNote}`,
        remediation:
          "Set MARINA_DECISIONS (Jev) and/or MARINA_DECISION_ENGINES (any model Marina routes) — see config/environment.reference.",
      });
    } else {
      checks.push({
        id: "decision-engines",
        label: "Decision engines (/v1/systemone, harness)",
        status: "ok",
        detail:
          `serving ${engines.map((e) => e.id).join(", ")}; harness uses ${engineId ?? "the configured backend"}` +
          (calibrationPath
            ? `; gate calibration earned for ${earned.length ? earned.join(", ") : "no model"}`
            : "") +
          (questionsPath ? `; gate questions: ${questions.name} (adopted)` : "") +
          runtimeNote,
      });
    }
  }

  // ── Social Simulation Arena — Marina as a public forecasting entrant ─────
  const arena = arenaStatus(env);
  if (arena.configError || (arena.configured && arena.keyError)) {
    checks.push({
      id: "arena",
      label: "Social Simulation Arena",
      status: "degraded",
      detail: arena.configError ?? `entrant ${arena.entrant}: ${arena.keyError}`,
      remediation:
        "Generate a key with `bun run arena keygen <path>`, chmod 600 it, set MARINA_ARENA_KEY_FILE — see docs/guides/arena.md.",
    });
  } else if (arena.configured) {
    checks.push({
      id: "arena",
      label: "Social Simulation Arena",
      status: "ok",
      detail: `entrant ${arena.entrant} (key ${arena.keyId}); autopilot ${arena.autopilot ? "on" : "off"}`,
    });
  }
  if (arena.configured) checks.push(arenaFilingCheck());
  // Not entered: no check at all — the arena is opt-in, not a missing capability.

  // ── Competence map — what the resolved record says each method is good at ─
  try {
    // Readiness is polled: a bounded read of the newest outcomes is enough for the summary.
    const cells = engine.db ? competenceMap(engine.db, { limit: 2_000 }) : [];
    const live = cells.reduce((n, c) => n + c.live, 0);
    const measure = cells.reduce((n, c) => n + c.measure, 0);
    const families = new Set(cells.map((c) => c.family)).size;
    checks.push({
      id: "competence",
      label: "Competence map",
      status: cells.length ? "ok" : "off",
      optional: true,
      detail: cells.length
        ? `${cells.length} (family, method) cells over ${families} families: ${live} live and ${measure} measured outcomes — \`forecast competence\` for the table`
        : "no resolved outcome is tagged with a family and method yet",
      ...(cells.length
        ? {}
        : {
            remediation:
              "Rows appear as forecasts, arena rounds and benchmark runs resolve; `bun run outcomes:settle` records the backlog.",
          }),
    });
  } catch {
    // allow-empty-catch: an unreadable outcome table only omits this informational line
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
  let recentPrimitiveActions = 0;
  let activeParticipants = 0;
  let activeAgents = 0;
  let recentCommunications = 0;
  let marinaToolCalls = 0;
  let agentToolCalls = 0;
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
  try {
    const usage = engine.db?.getPrimitiveUsageSummary(undefined, 5 / 1440);
    recentPrimitiveActions = usage?.meaningfulActions ?? 0;
    activeParticipants = usage?.activeParticipants ?? 0;
    activeAgents = usage?.activeAgents ?? 0;
    recentCommunications = usage?.communications ?? 0;
    marinaToolCalls = usage?.marinaToolCalls ?? 0;
    agentToolCalls = usage?.toolCalls ?? 0;
  } catch {
    // Primitive evidence is additive and must never break readiness.
  }
  responseDurations.sort((a, b) => a - b);
  const medianResponseMs =
    responseDurations.length > 0
      ? responseDurations[Math.floor(responseDurations.length / 2)]
      : undefined;
  const warmRatio = expectedNames.length > 0 ? warmAgents / expectedNames.length : 0;
  const req = AUTONOMY_REQUIREMENTS;
  const autonomyQualified =
    recentPrimitiveActions >= req.recentPrimitiveActions &&
    activeAgents >= req.activeAgents &&
    recentCommunications >= req.recentCommunications &&
    marinaToolCalls >= req.marinaToolCalls &&
    (medianResponseMs === undefined || medianResponseMs < req.maximumMedianResponseMs);
  const score = Math.round(
    (hasKey ? 20 : 0) +
      (autoRespawnEnabled(engine.agentRuntime.isAvailable(), env) ? 10 : 0) +
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
    recentPrimitiveActions,
    activeParticipants,
    activeAgents,
    recentCommunications,
    marinaToolCalls,
    autonomyQualified,
    ...(medianResponseMs !== undefined ? { medianResponseMs } : {}),
  };
  // "Agents exist" = one runs here, or an agent harness (internal or external)
  // made tool calls in the window. A person typing in the CLI is not one.
  if (agents.length === 0 && agentToolCalls === 0) {
    // Nothing to measure yet: these are activity metrics, not capabilities, and
    // a fresh install must not read as failing them. Ids stay for API callers.
    const notYet = {
      status: "off" as const,
      optional: true as const,
      detail: "no agents yet — measured once agents run",
    };
    checks.push({ id: "demo-pulse", label: "Demo pulse", ...notYet });
    checks.push({ id: "primitive-evidence", label: "Primitive participation", ...notYet });
  } else {
    const pulse: ReadinessCheck = {
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
    };
    const participationReady = autonomyQualified;
    const participation: ReadinessCheck = {
      id: "primitive-evidence",
      label: "Primitive participation",
      status: participationReady ? "ok" : "degraded",
      detail: `${recentPrimitiveActions} meaningful actions · ${activeAgents} active agents (${activeParticipants} total participants) · ${recentCommunications} communications · ${marinaToolCalls} Marina tool calls in 5m`,
      ...(participationReady
        ? {}
        : {
            remediation:
              "Run a multi-agent task with at least two agents, shared primitives, a targeted handoff, and two Marina tool calls; verify with `productivity primitives`.",
          }),
    };
    checks.push(pulse, participation);
  }

  return {
    instanceName: engine.instanceName,
    world: engine.world?.name ?? "unknown",
    generatedAt: Date.now(),
    trustProfile: computeTrustProfile(env),
    checks,
    demo,
  };
}

/** Schedules: off, or how many are failing or waiting on an absent owner. */
export function schedulesCheck(engine: Engine): ReadinessCheck {
  const label = "Schedules";
  if (schedulesMode() === "off")
    return {
      id: "schedules",
      label,
      status: "off",
      detail: "MARINA_SCHEDULES=off — schedules are stored but never run",
      remediation: "Unset MARINA_SCHEDULES (or set it to on) and restart.",
    };
  let rows: ReturnType<NonNullable<Engine["db"]>["listSchedules"]> = [];
  try {
    rows = engine.db ? engine.db.listSchedules(undefined, 1000) : [];
  } catch {
    // allow-empty-catch: a database before migration 165 has no schedules
  }
  const active = rows.filter((r) => r.enabled && r.next_run_at !== null);
  const failing = active.filter(
    (r) => r.consecutive_failures >= ALERT_AFTER_FAILURES || r.last_status === "owner-absent",
  );
  if (!failing.length)
    return {
      id: "schedules",
      label,
      status: "ok",
      detail: `${active.length} active schedule(s)${rows.length > active.length ? `, ${rows.length - active.length} paused or done` : ""}`,
    };
  return {
    id: "schedules",
    label,
    status: "degraded",
    detail: `${failing.length} of ${active.length} active schedule(s) failing: ${failing
      .slice(0, 5)
      .map((r) => `${r.owner_name}/${r.name} (${r.last_status})`)
      .join(", ")}${failing.length > 5 ? ", …" : ""}`,
    remediation:
      "The owner runs `schedule show <name>` to see the errors, then fixes or pauses it.",
  };
}

/** Periodic tick jobs whose last run failed. */
export function tickJobsCheck(engine: Engine): ReadinessCheck {
  const failing = engine.describeTickSchedule().filter((j) => j.lastError);
  if (!failing.length)
    return {
      id: "tick-jobs",
      label: "Periodic jobs",
      status: "ok",
      detail: `${engine.describeTickSchedule().length} periodic job(s), none failing`,
    };
  return {
    id: "tick-jobs",
    label: "Periodic jobs",
    status: "degraded",
    detail: `last run failed: ${failing
      .slice(0, 5)
      .map((j) => `${j.name} (${(j.lastError ?? "").slice(0, 120)})`)
      .join("; ")}`,
    remediation:
      "Check the server log for the job's error; a job clears this on its next good run.",
  };
}

/** The last arena filing-watch pass: rounds locking within 24 h without a sound filing. */
export function arenaFilingCheck(now = Date.now()): ReadinessCheck {
  const label = "Arena filings (rounds locking within 24 h)";
  const last = lastFilingWatch();
  if (!last)
    return {
      id: "arena-filing",
      label,
      status: "ok",
      detail: "not checked yet in this process (the watch runs every ~10 min)",
    };
  const age = Math.round((now - last.checkedAt) / 60_000);
  if (last.error)
    return {
      id: "arena-filing",
      label,
      status: "degraded",
      detail: `could not read the open rounds ${age} min ago: ${last.error.slice(0, 160)}`,
      remediation: "Check network access to the arena data source (MARINA_ARENA_DATA_URL).",
    };
  if (!last.findings.length)
    return {
      id: "arena-filing",
      label,
      status: "ok",
      detail: `${last.watched} round(s) locking within 24 h, all filed and refreshing (checked ${age} min ago)`,
    };
  return {
    id: "arena-filing",
    label,
    status: "degraded",
    detail: last.findings
      .slice(0, 5)
      .map((f) => `${f.roundId}: ${f.problem} — ${f.detail}`)
      .join("; "),
    remediation:
      "Check the operator's arena runner (its timers and build), then refile: bun run arena submit <round> --replace",
  };
}
