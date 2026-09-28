// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime decision settings — the operator can turn decisions on, pick the
 * backend model, the engines, the gate and the rest from a RUNNING Marina:
 * the dashboard (Admin → Ops → Decisions), the console and the `marina` CLI
 * (`admin decisions …`), without a restart.
 *
 *   Operator only    writes need rank 5 + the `admin.destructive` gate (the
 *                    `admin` command; `authorizePrivileged` on the dashboard —
 *                    a gate `MARINA_AUTONOMY=open` never auto-passes), and are
 *                    REFUSED for any agent-driven entity (internal/workload
 *                    connection, or a spawned agent with an agent config): an
 *                    agent never reconfigures its own supervision.
 *   Environment wins a variable set in the environment at boot LOCKS that
 *                    setting: it is shown as locked and cannot be changed at
 *                    runtime, so a deployment's pinned config survives even a
 *                    compromised admin session.
 *   Never runtime    base URLs, paths and API keys (`MARINA_DECISION_BASE_URL`,
 *                    `_PATH`, `_API_KEY`, vendor keys) stay env / Admin → Keys:
 *                    a runtime base URL would let whoever sets it receive every
 *                    agent's tool calls.
 *   Audited          every change is logged (durable structured log) and kept
 *                    in a bounded history with who, when, old and new value.
 *
 * A setting is applied by writing the variable into `process.env` — every
 * decision reader already reads it per call, so a change takes effect on the
 * next decision. Stored settings are re-applied at boot (`applyStoredDecisionSettings`).
 */

import { isAbsolute } from "node:path";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";

const logger = new Logger();

type Parse = (raw: string) => string;

const oneOf =
  (values: readonly string[]): Parse =>
  (raw) => {
    const v = raw.trim().toLowerCase();
    if (!values.includes(v)) throw new Error(`one of: ${values.join(", ")}`);
    return v;
  };

const MODEL_ID = /^[A-Za-z0-9._~:/@+-]{1,200}$/;
const modelId: Parse = (raw) => {
  const v = raw.trim();
  if (!MODEL_ID.test(v)) throw new Error("a model id like typesafe/jev-1.13");
  return v;
};

const list =
  (item: Parse, allowStar: boolean): Parse =>
  (raw) => {
    const v = raw.trim();
    if (["off", "none"].includes(v.toLowerCase())) return "off";
    const items = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0 || items.length > 32) throw new Error("a comma list of 1–32 ids");
    return items.map((s) => (allowStar && s === "*" ? s : item(s))).join(",");
  };

const int =
  (min: number, max: number): Parse =>
  (raw) => {
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`an integer ${min}–${max}`);
    return String(n);
  };

const jsonFile: Parse = (raw) => {
  const v = raw.trim();
  if (!isAbsolute(v) || !v.endsWith(".json") || v.includes("\0")) {
    throw new Error("an absolute path to a .json file");
  }
  return v;
};

export interface DecisionSettingSpec {
  /** Short name used by `admin decisions set <name>` (the env name works too). */
  name: string;
  env: string;
  describe: string;
  parse: Parse;
  /** The allowed values, for settings that are a fixed choice (dashboard dropdowns). */
  options?: readonly string[];
}

const choice = (values: readonly string[]) => ({ parse: oneOf(values), options: values });

/** Every decision setting an operator may change at runtime. Nothing else. */
export const DECISION_SETTINGS: readonly DecisionSettingSpec[] = [
  {
    name: "backend",
    env: "MARINA_DECISIONS",
    describe: "decision backend: off | decisions-api (jev) | typesafe | chat-classifier",
    ...choice(["off", "decisions-api", "jev", "typesafe", "chat-classifier", "classifier", "llm"]),
  },
  { name: "model", env: "MARINA_DECISION_MODEL", describe: "backend model id", parse: modelId },
  {
    name: "timeout",
    env: "MARINA_DECISION_TIMEOUT_MS",
    describe: "per-call timeout, ms",
    parse: int(100, 120_000),
  },
  {
    name: "gate",
    env: "MARINA_DECISION_GATE",
    describe: "score mutating agent tool calls: on | off",
    ...choice(["on", "off"]),
  },
  {
    name: "gate-context",
    env: "MARINA_DECISION_GATE_CONTEXT",
    describe: "send the agent's intent + trust labels with gate calls: on | off",
    ...choice(["on", "off"]),
  },
  {
    name: "approval-timeout",
    env: "MARINA_DECISION_APPROVAL_TIMEOUT_MS",
    describe: "how long a held call waits for its owner, ms",
    parse: int(1_000, 3_600_000),
  },
  {
    name: "verify",
    env: "MARINA_DECISION_VERIFY",
    describe: "task-submission verifier: off | on | observe",
    ...choice(["off", "on", "observe"]),
  },
  {
    name: "engines",
    env: "MARINA_DECISION_ENGINES",
    describe: "chat models served as marina/classifier:<m> (comma list, * for any, off)",
    parse: list(modelId, true),
  },
  {
    name: "method",
    env: "MARINA_DECISION_METHOD",
    describe: "how chat classifiers get probabilities: auto | logprobs | sampled | verbalized",
    ...choice(["auto", "logprobs", "sampled", "verbalized"]),
  },
  {
    name: "samples",
    env: "MARINA_DECISION_SAMPLES",
    describe: "calls per decision for `sampled`",
    parse: int(2, 15),
  },
  {
    name: "ensemble",
    env: "MARINA_DECISION_ENSEMBLE",
    describe: "engines combined by marina/ensemble (comma list)",
    parse: list(modelId, false),
  },
  {
    name: "engine",
    env: "MARINA_DECISION_ENGINE",
    describe: "engine Marina's own harness uses (e.g. marina/auto)",
    parse: modelId,
  },
  {
    name: "calibration",
    env: "MARINA_DECISION_CALIBRATION",
    describe: "earned gate calibration file (absolute .json path)",
    parse: jsonFile,
  },
  {
    name: "gate-questions",
    env: "MARINA_DECISION_GATE_QUESTIONS",
    describe: "adopted gate-question file (absolute .json path)",
    parse: jsonFile,
  },
];

export function findDecisionSetting(nameOrEnv: string): DecisionSettingSpec | undefined {
  const k = nameOrEnv.trim();
  return DECISION_SETTINGS.find((s) => s.name === k.toLowerCase() || s.env === k.toUpperCase());
}

// ─── Environment lock ────────────────────────────────────────────────────────

/** Variables that came from the real environment (captured once, before any runtime value). */
let bootEnv: Set<string> | undefined;

function lockedByEnvironment(env: string): boolean {
  bootEnv ??= new Set(
    DECISION_SETTINGS.map((s) => s.env).filter((k) => (process.env[k] ?? "").trim() !== ""),
  );
  return bootEnv.has(env);
}

/** Test seam: forget the boot snapshot (and optionally take a new one now). */
export function resetDecisionSettingsForTests(): void {
  bootEnv = undefined;
}

// ─── Storage and history ─────────────────────────────────────────────────────

const SETTING_PREFIX = "decision_setting:";
const HISTORY_KEY = "decision_settings_history";
const HISTORY_LIMIT = 100;

export interface DecisionSettingChange {
  at: string;
  by: string;
  setting: string;
  env: string;
  from: string | null;
  to: string | null;
}

type SettingsStore = Pick<MarinaDB, "getSetting" | "setSetting" | "deleteSetting">;

export function decisionSettingsHistory(db: SettingsStore): DecisionSettingChange[] {
  try {
    const raw = JSON.parse(db.getSetting(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as DecisionSettingChange[]) : [];
  } catch {
    return [];
  }
}

function recordChange(db: SettingsStore, change: DecisionSettingChange): void {
  const history = [change, ...decisionSettingsHistory(db)].slice(0, HISTORY_LIMIT);
  db.setSetting(HISTORY_KEY, JSON.stringify(history));
  logger.info("decisions", `decision setting ${change.setting} changed by ${change.by}`, {
    env: change.env,
    from: change.from,
    to: change.to,
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface DecisionSettingView {
  name: string;
  env: string;
  describe: string;
  /** The value in effect now (undefined ⇒ unset: the built-in default applies). */
  value?: string;
  source: "environment" | "runtime" | "default";
  /** Set in the environment at boot: cannot be changed at runtime. */
  locked: boolean;
  options?: readonly string[];
}

export function describeDecisionSettings(db?: SettingsStore): DecisionSettingView[] {
  return DECISION_SETTINGS.map((s) => {
    const locked = lockedByEnvironment(s.env);
    const stored = db?.getSetting(`${SETTING_PREFIX}${s.env}`);
    const value = (process.env[s.env] ?? "").trim() || undefined;
    const source = locked ? "environment" : stored !== undefined && value ? "runtime" : "default";
    return {
      name: s.name,
      env: s.env,
      describe: s.describe,
      ...(value ? { value } : {}),
      source,
      locked,
      ...(s.options ? { options: s.options } : {}),
    };
  });
}

// ─── Writing ─────────────────────────────────────────────────────────────────

export class DecisionSettingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
    this.name = "DecisionSettingError";
  }
}

/**
 * Set (value) or clear (null) one setting. The caller has already passed the
 * operator check (`admin.destructive`) and the never-an-agent check.
 */
export function changeDecisionSetting(
  db: SettingsStore,
  nameOrEnv: string,
  value: string | null,
  by: string,
): DecisionSettingView {
  const spec = findDecisionSetting(nameOrEnv);
  if (!spec) {
    throw new DecisionSettingError(
      `Unknown decision setting "${nameOrEnv}". Settable: ${DECISION_SETTINGS.map((s) => s.name).join(", ")}. ` +
        "Base URLs, paths and API keys are never set at runtime.",
    );
  }
  if (lockedByEnvironment(spec.env)) {
    throw new DecisionSettingError(
      `${spec.env} is set in the environment, which wins: change it there and restart.`,
      409,
    );
  }
  let parsed: string | null = null;
  if (value !== null) {
    try {
      parsed = spec.parse(value);
    } catch (err) {
      throw new DecisionSettingError(`${spec.name} must be ${(err as Error).message}.`);
    }
  }
  const key = `${SETTING_PREFIX}${spec.env}`;
  const from = db.getSetting(key) ?? null;
  if (parsed === null) {
    db.deleteSetting(key);
    delete process.env[spec.env];
  } else {
    db.setSetting(key, parsed);
    process.env[spec.env] = parsed;
  }
  recordChange(db, {
    at: new Date().toISOString(),
    by,
    setting: spec.name,
    env: spec.env,
    from,
    to: parsed,
  });
  return describeDecisionSettings(db).find((v) => v.env === spec.env)!;
}

/**
 * Re-apply stored settings at boot. The environment wins: a stored value for a
 * variable the environment sets is skipped (and reported). A stored value that
 * no longer parses is skipped with a warning, never applied.
 */
export function applyStoredDecisionSettings(db: SettingsStore): {
  applied: string[];
  shadowed: string[];
} {
  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const spec of DECISION_SETTINGS) {
    const stored = db.getSetting(`${SETTING_PREFIX}${spec.env}`);
    if (stored === undefined) continue;
    if (lockedByEnvironment(spec.env)) {
      shadowed.push(spec.env);
      continue;
    }
    try {
      process.env[spec.env] = spec.parse(stored);
      applied.push(spec.env);
    } catch (err) {
      logger.warn("decisions", "stored decision setting no longer valid; skipped", {
        env: spec.env,
        error: (err as Error).message,
      });
    }
  }
  if (applied.length || shadowed.length) {
    logger.info("decisions", "runtime decision settings applied", { applied, shadowed });
  }
  return { applied, shadowed };
}

// ─── Who may write ───────────────────────────────────────────────────────────

/**
 * Agent-driven entities may never change decision settings: an agent must not
 * reconfigure the gate or backend that supervises it. An entity is
 * agent-driven when its connection is internal (room / crew / runtime agents,
 * workload credentials) or it has an agent config (spawned agents). An
 * external client using a person's own credentials acts as that person.
 */
export function isAgentDriven(opts: {
  internalConnection?: boolean;
  hasAgentConfig?: boolean;
}): boolean {
  return !!opts.internalConnection || !!opts.hasAgentConfig;
}
