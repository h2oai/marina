// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model tiers — the ONE place a model is chosen for work that names none.
 *
 * Two tiers:
 *  - `cheap`  (`MARINA_MODEL_TIER_CHEAP`): residents, room agents, boot-seeded
 *    crews and memory helpers. Unset, it is the operator's explicit default
 *    model (runtime `default_model`, else `MARINA_DEFAULT_MODEL`) when one is
 *    set, else the cheapest adequate tool-capable model this installation has a
 *    key for (`BUILTIN_CHEAP_MODELS`), else `marina/default`.
 *  - `strong` (`MARINA_MODEL_TIER_STRONG`): work that grades or overrules —
 *    the benchmark judge, outcome and lesson judges, decisions, the Arbiter.
 *    Unset, it is `marina/default` exactly as before (the explicit default,
 *    else the first-party fallback order), so judging never becomes cheap by
 *    accident.
 *
 * `marina/cheap` and `marina/strong` are live aliases on this instance's
 * `/v1` (resolved per request by `resolveTierAlias`), so an agent config saved
 * as `marina/cheap` follows the tier when the operator changes it. A role is
 * moved off its tier with one entry in `MARINA_AGENT_MODELS`:
 * `role:<role>=<model>`. Every specific knob that existed before
 * (`MARINA_CREW_MODEL`, `MARINA_BENCHMARK_JUDGE_MODEL`, …) still wins.
 *
 * Between a role's env settings and its tier sits ONE earned layer: the
 * promoted slot `role-model:<role>` (`resolveDefault`), filled only by a
 * live-evidence promotion a person approved (`src/engine/live-promotion.ts`).
 * A promoted model this installation cannot call is skipped (traced) and the
 * tier answers. With nothing promoted the slot is never resolved, so the
 * choice, and its trace, is exactly what it was before.
 *
 * Pure apart from that ledger read: env plus optional runtime lookups; no network.
 */

import { availableModels, providerEnvKeys } from "../agent/available-models";
import { type DefaultSlotReader, resolveDefault } from "../engine/default-resolution";
import { Logger } from "../engine/logger";

const logger = new Logger();

export type ModelTier = "cheap" | "strong";

export type ModelRole =
  | "resident"
  | "room"
  | "crew"
  | "helper"
  | "judge"
  | "outcome-judge"
  | "lessons-judge"
  | "decisions"
  | "arbiter";

export interface ModelRoleInfo {
  tier: ModelTier;
  /** What the role covers, for the readout. */
  covers: string;
  /** Pre-existing role-specific knobs, in precedence order (first set wins). */
  knobs: readonly string[];
  /** The default when no knob, override or tier applies (else the tier). */
  defaultLabel?: string;
}

export const MODEL_ROLES: Readonly<Record<ModelRole, ModelRoleInfo>> = {
  resident: {
    tier: "cheap",
    covers: "agents spawned without a model (agent spawn, MCP, SDK)",
    knobs: [],
  },
  room: { tier: "cheap", covers: "room agents (spawned on room entry)", knobs: [] },
  crew: {
    tier: "cheap",
    covers: "boot-seeded agents: the Workbench, answerer and orchestration crews, the Chronicler",
    knobs: ["MARINA_WORKBENCH_MODEL", "MARINA_CREW_MODEL"],
  },
  helper: {
    tier: "cheap",
    covers: "memory helpers: assistance/reflector agents, relevance gate, ingest notes",
    knobs: ["MARINA_MEMORY_RELEVANCE_GATE_MODEL", "MARINA_MEMORY_INGEST_NOTES_MODEL"],
  },
  judge: {
    tier: "strong",
    covers: "benchmark judge (judge:<model> per run still wins)",
    knobs: ["MARINA_BENCHMARK_JUDGE_MODEL"],
  },
  "outcome-judge": {
    tier: "strong",
    covers: "outcome resolution extractor",
    knobs: ["MARINA_OUTCOME_JUDGE_MODEL", "MARINA_FORECAST_ANALYSTS"],
  },
  "lessons-judge": {
    tier: "strong",
    covers: "lesson writer and lesson judge (when no decision backend answers)",
    knobs: ["MARINA_LESSONS_JUDGE_MODEL", "MARINA_LESSONS_WRITER"],
  },
  decisions: {
    tier: "strong",
    covers: "decision classifier on this /v1 (MARINA_DECISIONS=auto)",
    knobs: ["MARINA_DECISION_MODEL"],
  },
  arbiter: {
    tier: "strong",
    covers: "the forecast Arbiter (contested forecasts only)",
    knobs: ["MARINA_FORECAST_ARBITER_MODEL"],
    defaultLabel: "the forecast critic",
  },
};

export const TIER_ENV: Readonly<Record<ModelTier, string>> = {
  cheap: "MARINA_MODEL_TIER_CHEAP",
  strong: "MARINA_MODEL_TIER_STRONG",
};

/** The `/v1` aliases that follow a tier at request time. */
export const TIER_ALIAS: Readonly<Record<ModelTier, string>> = {
  cheap: "marina/cheap",
  strong: "marina/strong",
};

/**
 * The cheap tier's built-in pick, first provider with a key wins. Every id is
 * a cheap, tool-capable chat model (checked 2026-10-26: OpenRouter's catalog
 * entry for deepseek-v4.1-flash-1017, the 2026-10-17 snapshot — $0.15/$0.60
 * per M list, tools and reasoning; the others from the bundled pi-ai
 * catalog). A dated snapshot, never the earlier one the bare id still serves:
 * the bare id is a fixed 2026-09-10 snapshot, not an alias. OpenRouter first: the
 * cheapest adequate model and the widest fallback. Providers not listed
 * (xai, …) fall through to `marina/default`.
 */
export const BUILTIN_CHEAP_MODELS: ReadonlyArray<{ provider: string; model: string }> = [
  { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017" },
  { provider: "deepseek", model: "deepseek-flash" },
  { provider: "anthropic", model: "claude-haiku-5-5" },
  { provider: "openai", model: "gpt-6-luna" },
  { provider: "google", model: "gemini-3.1-flash-lite" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "cerebras", model: "gpt-oss-120b" },
  { provider: "huggingface", model: "zai-org/GLM-5.3-Flash" },
  { provider: "mistral", model: "mistral-small-latest" },
];

type Env = Record<string, string | undefined>;

export interface ModelChoice {
  model: string;
  /** Where it came from: `role:<r>`, `env:<NAME>`, `runtime default`, `built-in …`, `tier:<t>`. */
  source: string;
}

export interface TierContext {
  env?: Env;
  /**
   * The promotion ledger the `role-model:<role>` slot is read from. Absent:
   * the reader registered with `setRoleModelSlots` (the server's world DB),
   * else none (env and tier only).
   */
  slots?: RoleModelSlotReader;
  /** The runtime `default_model` setting (dashboard / admin), when set. */
  runtimeDefault?: string;
  /** Whether a provider has a key (env or Admin → Keys). Default: env keys only. */
  hasKey?: (provider: string) => boolean;
}

function envValue(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/**
 * The cheap tier's default output cap (`MARINA_MODEL_TIER_CHEAP_MAX_OUTPUT_TOKENS`).
 * Measured on the 2026-10-20 proof run (1,132 single-call deepseek-v4.1-flash
 * answers, FRAMES + SimpleQA): p95 6.3k, p99 13.1k output tokens; correct
 * answers p99 7.1k. The 9 replies past 16k (0.8 %) averaged score 0.29 and were
 * 33 % of the arms' model cost — reasoning loops that ran to the provider's
 * ~98k limit. 16,384 cuts that tail and no normal answer.
 */
export const CHEAP_OUTPUT_CAP_ENV = "MARINA_MODEL_TIER_CHEAP_MAX_OUTPUT_TOKENS";
export const DEFAULT_CHEAP_OUTPUT_CAP_TOKENS = 16_384;
/** The share of the cap a hidden-reasoning budget may take, leaving room for the answer. */
export const CHEAP_REASONING_SHARE = 0.75;
/** Below this a reasoning budget is not sent (providers' minimum budgets sit near 1k). */
const MIN_REASONING_BUDGET_TOKENS = 1024;

/** The output cap a tier applies to a request that sets none. */
export interface TierOutputCap {
  /** `max_tokens` sent when the caller sent no output limit. */
  maxTokens: number;
  /** OpenRouter `reasoning.max_tokens` sent with it, when the caller sent no reasoning directive. */
  reasoningMaxTokens?: number;
  /** `default` or `env:<NAME>`. */
  source: string;
}

/**
 * The cheap tier's output cap, or `undefined` when it is off (`0` / `off`).
 * Unset or unparsable: {@link DEFAULT_CHEAP_OUTPUT_CAP_TOKENS}.
 */
export function cheapTierOutputCap(env: Env = process.env): TierOutputCap | undefined {
  const raw = envValue(env, CHEAP_OUTPUT_CAP_ENV)?.toLowerCase();
  if (raw && ["0", "off", "none", "false", "no"].includes(raw)) return undefined;
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const set = Number.isSafeInteger(n) && n > 0;
  const maxTokens = set ? n : DEFAULT_CHEAP_OUTPUT_CAP_TOKENS;
  const reasoning = Math.floor(maxTokens * CHEAP_REASONING_SHARE);
  return {
    maxTokens,
    ...(reasoning >= MIN_REASONING_BUDGET_TOKENS ? { reasoningMaxTokens: reasoning } : {}),
    source: set ? `env:${CHEAP_OUTPUT_CAP_ENV}` : "default",
  };
}

/** The output cap for a request whose model id is `model`: the cheap tier's for `marina/cheap`, else none. */
export function tierOutputCapFor(
  model: unknown,
  env: Env = process.env,
): TierOutputCap | undefined {
  return tierAliasOf(model) === "cheap" ? cheapTierOutputCap(env) : undefined;
}

/** One readout line for the cheap tier's output cap. */
export function describeCheapOutputCap(env: Env = process.env): string {
  const cap = cheapTierOutputCap(env);
  if (!cap) return `  cheap output cap off  [env:${CHEAP_OUTPUT_CAP_ENV}]`;
  const reasoning = cap.reasoningMaxTokens
    ? `, OpenRouter reasoning ≤ ${cap.reasoningMaxTokens}`
    : "";
  return `  cheap output cap ${cap.maxTokens} tokens${reasoning}  [${cap.source}; set ${CHEAP_OUTPUT_CAP_ENV}, 0/off disables] — only when the caller sends no max_tokens`;
}

/** The tier a model id names when it is a tier alias (`marina/cheap`, `marina:cheap`, `cheap`). */
export function tierAliasOf(model: unknown): ModelTier | undefined {
  if (typeof model !== "string") return undefined;
  const m = model.trim().toLowerCase();
  for (const tier of ["cheap", "strong"] as const) {
    if (m === tier || m === `marina/${tier}` || m === `marina:${tier}`) return tier;
  }
  return undefined;
}

/** True for a `marina/*` loopback alias of the default model (not a tier). */
function isDefaultAlias(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "marina" || m === "default" || m === "marina/default" || m === "marina:default";
}

/** `role:<role>=<model>` entries of `MARINA_AGENT_MODELS`, by role (lower-cased). */
export function roleModelOverrides(env: Env = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (env.MARINA_AGENT_MODELS ?? "").split(",")) {
    const text = entry.trim();
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    const name = text.slice(0, eq).trim();
    const model = text.slice(eq + 1).trim();
    if (!isRoleKey(name) || !model) continue;
    out.set(name.slice("role:".length).trim().toLowerCase(), model);
  }
  return out;
}

/** A `MARINA_AGENT_MODELS` key that names a model role (`role:<name>`), not an agent. */
export function isRoleKey(name: string): boolean {
  return name.trim().toLowerCase().startsWith("role:");
}

/** `role:` entries naming no known role — logged at boot so a typo is never silent. */
export function roleOverrideProblems(env: Env = process.env): string[] {
  const known = new Set(Object.keys(MODEL_ROLES));
  return [...roleModelOverrides(env).keys()]
    .filter((r) => !known.has(r))
    .map((r) => `"role:${r}" names no model role (known: ${[...known].join(", ")})`);
}

/** The operator's explicit default model: runtime setting, else `MARINA_DEFAULT_MODEL`. */
export function explicitDefaultModel(ctx: TierContext = {}): ModelChoice | undefined {
  const runtime = ctx.runtimeDefault?.trim();
  if (runtime) return { model: runtime, source: "runtime default (admin / dashboard)" };
  const env = envValue(ctx.env ?? process.env, "MARINA_DEFAULT_MODEL");
  if (env) return { model: env, source: "env:MARINA_DEFAULT_MODEL" };
  return undefined;
}

function envHasKey(env: Env): (provider: string) => boolean {
  return (provider) => providerEnvKeys(provider).some((k) => !!env[k]?.trim());
}

/** The cheap tier's built-in pick for this installation's keys. */
export function builtinCheapModel(ctx: TierContext = {}): ModelChoice {
  const env = ctx.env ?? process.env;
  // A self-hosted runtime the operator opted into is already `marina/default`'s
  // first choice, and costs nothing per token.
  if (availableModels(env as NodeJS.ProcessEnv).some((m) => m.local)) {
    return { model: "marina/default", source: "built-in (local runtime)" };
  }
  const hasKey = ctx.hasKey ?? envHasKey(env);
  for (const { provider, model } of BUILTIN_CHEAP_MODELS) {
    if (hasKey(provider))
      return { model: `${provider}/${model}`, source: `built-in (${provider})` };
  }
  return { model: "marina/default", source: "built-in (no cheap model for these keys)" };
}

/** The model a tier is set to (may be `marina/default`). */
export function tierModel(tier: ModelTier, ctx: TierContext = {}): ModelChoice {
  const env = ctx.env ?? process.env;
  const set = envValue(env, TIER_ENV[tier]);
  if (set) return { model: set, source: `env:${TIER_ENV[tier]}` };
  if (tier === "cheap") {
    const explicit = explicitDefaultModel(ctx);
    // A default set to `marina/cheap` itself means "the cheap tier", not a loop.
    return explicit && tierAliasOf(explicit.model) !== "cheap" ? explicit : builtinCheapModel(ctx);
  }
  return { model: "marina/default", source: "built-in (marina/default)" };
}

/**
 * What a tier alias stands for right now: the tier's model, followed through
 * one more alias (a tier set to the other tier's alias). `undefined` when
 * `model` is not a tier alias. A result of `marina/default` means "the
 * default route" — the caller serves it exactly as it serves `marina/default`.
 */
export function resolveTierAlias(model: unknown, ctx: TierContext = {}): ModelChoice | undefined {
  const tier = tierAliasOf(model);
  if (!tier) return undefined;
  const first = tierModel(tier, ctx);
  const next = tierAliasOf(first.model);
  if (!next || next === tier) {
    return next === tier ? { model: "marina/default", source: first.source } : first;
  }
  const second = tierModel(next, ctx);
  const model2 = tierAliasOf(second.model) ? "marina/default" : second.model;
  return { model: model2, source: `${first.source} → ${second.source}` };
}

/**
 * The model for a role that names none. Precedence: the role's pre-existing
 * knob (`knob`, given by the caller that owns it) → `role:<role>=` in
 * `MARINA_AGENT_MODELS` → (residents only) the explicit default → a promoted
 * `role-model:<role>` slot (earned on live work, person-approved) → the tier:
 * `marina/cheap` for a cheap role (a live alias), `MARINA_MODEL_TIER_STRONG`
 * or else `marina/default` for a strong one.
 */
export function roleModel(
  role: ModelRole,
  ctx: TierContext & {
    knob?: { name: string; value: string | undefined };
    /** For `resident`: the agent's work role, whose `role-model:<role>` slot is read first. */
    workRole?: string;
  } = {},
): ModelChoice {
  const env = ctx.env ?? process.env;
  const knob = ctx.knob?.value?.trim();
  if (knob && ctx.knob) return { model: knob, source: `env:${ctx.knob.name}` };
  const override = roleModelOverrides(env).get(role);
  if (override) return { model: override, source: `MARINA_AGENT_MODELS role:${role}` };
  const info = MODEL_ROLES[role];
  if (role === "resident") {
    // The runtime / env default was always "the model for agents spawned
    // without one" — an operator who set it keeps exactly that.
    const explicit = explicitDefaultModel(ctx);
    if (explicit) return explicit;
  }
  // The earned layer: a promoted `role-model:<role>` (for a resident, the
  // work role it was spawned for first).
  const promoted = promotedRoleModel(
    role === "resident" && ctx.workRole ? [ctx.workRole, role] : [role],
    ctx,
  );
  if (promoted) return promoted;
  if (info.tier === "cheap") return { model: TIER_ALIAS.cheap, source: "tier:cheap" };
  const strong = envValue(env, TIER_ENV.strong);
  if (strong) return { model: strong, source: `tier:strong (env:${TIER_ENV.strong})` };
  return { model: "marina/default", source: "tier:strong (marina/default)" };
}

/** Env-only shorthand for the call sites that read a role's model from `env`. */
export function roleModelFromEnv(role: ModelRole, env: Env = process.env): string {
  return roleModel(role, { env }).model;
}

/** One readout line per tier and role: effective model and where it came from. */
export function describeModelTiers(
  ctx: TierContext & {
    /** What `marina/default` routes to right now, when known. */
    defaultRoute?: string;
  } = {},
): string[] {
  const env = ctx.env ?? process.env;
  const concrete = (model: string): string => {
    const viaAlias = resolveTierAlias(model, ctx)?.model ?? model;
    if (isDefaultAlias(viaAlias) && ctx.defaultRoute) return `${viaAlias} → ${ctx.defaultRoute}`;
    return viaAlias === model ? model : `${model} → ${viaAlias}`;
  };
  const lines: string[] = ["Model tiers (cheap by default; one knob per tier):"];
  for (const tier of ["cheap", "strong"] as const) {
    const t = tierModel(tier, ctx);
    lines.push(`  ${tier.padEnd(6)} ${concrete(t.model)}  [${t.source}; set ${TIER_ENV[tier]}]`);
    if (tier === "cheap") lines.push(describeCheapOutputCap(env));
  }
  const def = explicitDefaultModel(ctx);
  lines.push(
    `  default ${def ? `${def.model}  [${def.source}]` : "unset (MARINA_DEFAULT_MODEL / admin default)"}`,
  );
  lines.push("Roles (override one with MARINA_AGENT_MODELS=role:<role>=<model>):");
  for (const [role, info] of Object.entries(MODEL_ROLES) as [ModelRole, ModelRoleInfo][]) {
    const knobName = info.knobs.find((k) => envValue(env, k));
    const choice = knobName
      ? { model: envValue(env, knobName)!, source: `env:${knobName}` }
      : roleModelOverrides(env).has(role)
        ? roleModel(role, ctx)
        : info.defaultLabel
          ? envValue(env, TIER_ENV.strong)
            ? {
                model: envValue(env, TIER_ENV.strong)!,
                source: `tier:strong (env:${TIER_ENV.strong})`,
              }
            : { model: info.defaultLabel, source: `default; tier ${info.tier}` }
          : roleModel(role, ctx);
    lines.push(
      `  ${role.padEnd(14)} ${info.defaultLabel && choice.model === info.defaultLabel ? choice.model : concrete(choice.model)}  [${choice.source}] — ${info.covers}`,
    );
  }
  for (const p of roleOverrideProblems(env)) lines.push(`  warning: ${p}`);
  return lines;
}

/**
 * The model an agent spawned without one runs on: `role:resident=` override,
 * else the runtime default (`db`), else `MARINA_DEFAULT_MODEL`, else a
 * promoted `role-model:<workRole>` / `role-model:resident`, else `marina/cheap`.
 */
export function residentDefaultModel(
  db?: ({ getSetting?: (key: string) => string | undefined } & Partial<RoleModelSlotReader>) | null,
  env: Env = process.env,
  /** The agent's work role: a promoted `role-model:<workRole>` answers before `role-model:resident`. */
  workRole?: string,
): string {
  const runtimeDefault = db?.getSetting?.("default_model");
  const slots =
    db && typeof db.getBenchmarkDefault === "function" ? (db as RoleModelSlotReader) : undefined;
  return roleModel("resident", {
    env,
    ...(runtimeDefault ? { runtimeDefault } : {}),
    ...(slots ? { slots } : {}),
    ...(workRole ? { workRole } : {}),
  }).model;
}

/** A boot-seeded crew's model: `MARINA_CREW_MODEL`, else `role:crew=`, else `marina/cheap`. */
export function crewModelFromEnv(env: Env = process.env): string {
  return roleModel("crew", {
    env,
    knob: { name: "MARINA_CREW_MODEL", value: env.MARINA_CREW_MODEL },
  }).model;
}

/**
 * For a strong role whose built-in default is a pipeline model (the Arbiter's
 * is the forecast critic / the verify checker): `role:<role>=`, else
 * `MARINA_MODEL_TIER_STRONG`, else undefined (keep the built-in).
 */
export function strongRoleOverride(role: ModelRole, env: Env = process.env): string | undefined {
  return roleModelOverrides(env).get(role) ?? envValue(env, TIER_ENV.strong);
}

// ─── The earned layer: promoted `role-model:<role>` slots ───────────────────

/** The slot base a live-evidence promotion fills: `role-model:<role>`. */
export const ROLE_MODEL_SLOT = "role-model";

/** The ledger reads the promoted layer needs (any `MarinaDB`). */
export type RoleModelSlotReader = DefaultSlotReader;

let registeredSlots: RoleModelSlotReader | undefined;

/**
 * Register (or clear, with undefined) the ledger every `roleModel` call reads
 * promoted slots from when its context names none; the server registers its
 * world DB at boot. Returns the previous reader.
 */
export function setRoleModelSlots(
  reader: RoleModelSlotReader | undefined,
): RoleModelSlotReader | undefined {
  const prev = registeredSlots;
  registeredSlots = reader;
  return prev;
}

/** The slot key for a role: `role-model:<role>` (slot-safe, lower-case). */
export function roleModelSlotKey(role: string): string {
  const slug = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${ROLE_MODEL_SLOT}:${slug}`;
}

/**
 * Whether this installation can call `model`: a `marina/*` alias, a model of a
 * provider with a key (env, or `ctx.hasKey`) or a configured local runtime, or
 * any `vendor/model` id while OpenRouter (which serves them) has a key.
 */
export function modelCallable(model: string, ctx: TierContext = {}): boolean {
  const m = model.trim();
  if (!m) return false;
  const lower = m.toLowerCase();
  if (tierAliasOf(lower) || isDefaultAlias(lower) || lower.startsWith("marina/")) return true;
  const env = ctx.env ?? process.env;
  const slash = m.indexOf("/");
  const provider = slash > 0 ? lower.slice(0, slash) : "";
  if (!provider) return false;
  const available = availableModels(env as NodeJS.ProcessEnv);
  if (available.some((a) => a.provider === provider)) return true;
  if (ctx.hasKey?.(provider)) return true;
  return available.some((a) => a.provider === "openrouter") || ctx.hasKey?.("openrouter") === true;
}

const warnedUncallable = new Set<string>();

/**
 * The first promoted `role-model:<role>` among `roles`, read through
 * `resolveDefault`, or undefined. A slot with nothing in it (no promotion, no
 * upstream seed) is not resolved at all, so a world with no promotion traces
 * nothing new. A promoted model this installation cannot call reads as
 * unusable: `resolveDefault` traces it and the next layer answers.
 */
function promotedRoleModel(roles: readonly string[], ctx: TierContext): ModelChoice | undefined {
  const reader = ctx.slots ?? registeredSlots;
  if (!reader) return undefined;
  for (const role of roles) {
    const key = roleModelSlotKey(role);
    let present = false;
    try {
      present = !!reader.getBenchmarkDefault(key) || !!reader.latestUpstreamDefaultSeed?.(key);
    } catch {
      // allow-empty-catch: a closed or unmigrated ledger has no promoted defaults
      present = false;
    }
    if (!present) continue;
    let uncallable: string | undefined;
    const r = resolveDefault<string | null>({
      slot: key,
      surface: "role-model",
      db: reader,
      read: (v) => {
        if (typeof v !== "string" || !v.trim()) return undefined;
        if (!modelCallable(v, ctx)) {
          uncallable = v;
          return undefined;
        }
        return v.trim();
      },
      builtIn: null,
      builtInLabel: "tier",
    });
    if (uncallable && !warnedUncallable.has(`${key}\u0000${uncallable}`)) {
      warnedUncallable.add(`${key}\u0000${uncallable}`);
      logger.warn(
        "defaults",
        `${key} is promoted to ${uncallable}, which this installation cannot call; the next layer answers (${r.reason})`,
      );
    }
    if (r.value) return { model: r.value, source: `promoted ${r.key}` };
  }
  return undefined;
}
