// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project-aware verification for Code Mode (`code verify`).
 *
 * Detection (`project-detection.ts`) names the project's language, test runner
 * and dependency manager. This module turns that into a plan and reads the
 * result back:
 *
 * 1. Preparation by project type. An environment probe (`python -m pytest
 *    --version`, `go version`, `node_modules` present, …) decides whether the
 *    environment already has what the checks need. An install runs only with
 *    the project's own manager, never another language's installer, and only
 *    where it is isolated and persists: the hardened Bun path for a disposable
 *    candidate on the host, or a container runner with `sync:mount` and
 *    network. Every step is a fixed argv from the closed table below.
 * 2. Scope. Tests relevant to the change run first: touched test files, tests
 *    named after touched files, and tests that import them. The full suite runs
 *    when nothing relevant is found, or after the scoped run under a budget.
 * 3. Result states. Each step, and the verification, is `passed`, `failed`
 *    (checks ran and failed), `not_run` (no tests found, an unavailable
 *    runner, or preparation that could not make the environment ready) or
 *    `error` (the infrastructure failed). `not_run` and `error` are never a
 *    pass or a failure.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { parseDuration } from "../engine/commands/format-duration";
import type { CandidatePreparation } from "./candidate-dependencies";
import type { WorkspaceRunResult } from "./local-workspace";
import {
  isTestCommand,
  MANAGER_LANGUAGE,
  PACKAGE_MANAGERS,
  type PackageManager,
  type ProjectLanguage,
  type ProjectRunnerProfile,
  pathLanguage,
} from "./project-detection";

export type VerificationOutcome = "passed" | "failed" | "not_run" | "error";

/** The coding-artifact status a verification outcome is stored under. */
export const OUTCOME_STATUS: Readonly<Record<VerificationOutcome, string>> = {
  passed: "complete",
  failed: "failed",
  not_run: "not_run",
  error: "error",
};

export type VerificationScope = "auto" | "changed" | "full" | "changed+full";
export const VERIFICATION_SCOPES: readonly VerificationScope[] = [
  "auto",
  "changed",
  "full",
  "changed+full",
];
/** `none` skips preparation; `check` probes only; `auto` or a manager may install. */
export type DependencyMode = "none" | "check" | "auto" | PackageManager;
export const DEPENDENCY_MODES: readonly DependencyMode[] = [
  "none",
  "check",
  "auto",
  ...PACKAGE_MANAGERS,
];
export type TypecheckMode = "auto" | "off";

export interface VerificationOptions {
  scope: VerificationScope;
  dependencies: DependencyMode;
  typecheck: TypecheckMode;
  /** Time budget for the full suite (after or instead of the scoped run). */
  fullBudgetMs: number;
}

export const DEFAULT_VERIFY_FULL_BUDGET_MS = 600_000;

/** Reproduce explicit settings in a retry hint without executing anything or
 * accepting command text from artifact metadata. Older receipts keep defaults. */
export function candidateVerificationRetry(options: unknown): string {
  const command = "code verify candidate";
  if (!options || typeof options !== "object") return command;
  const value = options as Partial<VerificationOptions>;
  const modifiers: string[] = [];
  if (value.dependencies && DEPENDENCY_MODES.includes(value.dependencies))
    modifiers.push(`dependencies:${value.dependencies}`);
  if (value.scope && VERIFICATION_SCOPES.includes(value.scope))
    modifiers.push(`scope:${value.scope}`);
  if (value.typecheck === "auto" || value.typecheck === "off")
    modifiers.push(`typecheck:${value.typecheck}`);
  if (Number.isSafeInteger(value.fullBudgetMs) && value.fullBudgetMs! >= 1000)
    modifiers.push(`budget:${value.fullBudgetMs}ms`);
  return [command, ...modifiers].join(" ");
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  const v = value?.trim().toLowerCase().replace(",", "+");
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Options from explicit `code verify` modifiers over the operator's
 * `MARINA_CODE_VERIFY_*` defaults. An invalid explicit value throws (usage
 * error); an invalid environment value falls back to the default.
 */
export function resolveVerificationOptions(
  overrides: { scope?: string; dependencies?: string; typecheck?: string; budget?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): VerificationOptions {
  const pick = <T extends string>(
    name: string,
    explicit: string | undefined,
    fromEnv: string | undefined,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    if (explicit !== undefined) {
      const value = oneOf(explicit, allowed);
      if (!value) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
      return value;
    }
    return oneOf(fromEnv, allowed) ?? fallback;
  };
  let fullBudgetMs =
    parseDuration(env.MARINA_CODE_VERIFY_FULL_BUDGET?.trim()) ?? DEFAULT_VERIFY_FULL_BUDGET_MS;
  if (overrides.budget !== undefined) {
    const parsed = parseDuration(overrides.budget);
    if (!parsed) throw new Error("budget must be a duration such as 90s or 10m");
    fullBudgetMs = parsed;
  }
  return {
    scope: pick(
      "scope",
      overrides.scope,
      env.MARINA_CODE_VERIFY_SCOPE,
      VERIFICATION_SCOPES,
      "auto",
    ),
    dependencies: pick(
      "dependencies",
      overrides.dependencies,
      env.MARINA_CODE_VERIFY_DEPENDENCIES,
      DEPENDENCY_MODES,
      "check",
    ),
    typecheck: pick(
      "typecheck",
      overrides.typecheck,
      env.MARINA_CODE_VERIFY_TYPECHECK,
      ["auto", "off"] as const,
      "auto",
    ),
    fullBudgetMs: Math.max(1_000, fullBudgetMs),
  };
}

// ─── Preparation ─────────────────────────────────────────────────────────────

/** Environment probes: read-only checks that the toolchain and dependencies are present. */
export const PREPARATION_PROBES = {
  python: ["python", "--version"],
  pytest: ["python", "-m", "pytest", "--version"],
  django: ["python", "-c", "import django"],
  nodeModules: ["test", "-d", "node_modules"],
  go: ["go", "version"],
  cargo: ["cargo", "--version"],
  maven: ["mvn", "-v"],
  gradle: ["gradle", "--version"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Lockfile-frozen installs, without lifecycle scripts where the manager
 * supports it. Run only inside a container runner that persists them
 * (`sync:mount`) with network; never on the host (the host has the separate,
 * hardened Bun candidate path).
 */
export const PREPARATION_INSTALLS: Readonly<Partial<Record<PackageManager, readonly string[]>>> = {
  bun: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
  npm: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  pnpm: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
  yarn: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"],
  uv: ["uv", "sync", "--frozen"],
  pip: [
    "python",
    "-m",
    "pip",
    "install",
    "--require-hashes",
    "--only-binary=:all:",
    "--no-compile",
    "--upgrade",
    "--target",
    ".venv/marina-site-packages",
    "-r",
    "requirements.txt",
  ],
};

/** After a `uv sync`, Python checks run in the project environment through this wrapper. */
const UV_WRAPPER = "uv run --frozen --no-sync";
const PIP_WRAPPER = "env PYTHONPATH=.venv/marina-site-packages";

const sameArgv = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/** Whether an argv is one of the fixed preparation steps above, and which kind. */
export function preparationStepKind(argv: readonly string[]): "probe" | "install" | null {
  if (Object.values(PREPARATION_PROBES).some((probe) => sameArgv(probe, argv))) return "probe";
  for (const prefix of [UV_WRAPPER, PIP_WRAPPER])
    if (
      [PREPARATION_PROBES.python, PREPARATION_PROBES.pytest, PREPARATION_PROBES.django].some(
        (probe) => sameArgv([...prefix.split(" "), ...probe], argv),
      )
    )
      return "probe";
  if (Object.values(PREPARATION_INSTALLS).some((install) => install && sameArgv(install, argv)))
    return "install";
  return null;
}

export interface PreparationTarget {
  /** The workspace may install (container runner with mount sync and network). */
  installsPermitted: boolean;
  /** A disposable candidate snapshot on the host (the hardened Bun path applies). */
  hostCandidate: boolean;
  /** Patch-sync container: every command starts from the image again. */
  ephemeral?: boolean;
}

export interface PreparationPlan {
  mode: DependencyMode;
  language: ProjectLanguage | "unknown";
  manager?: PackageManager;
  /** Undefined: there is nothing to check (no recognized project, or nothing declared). */
  probe?: readonly string[];
  /** Run when the probe fails and installation is allowed here. */
  install?: readonly string[];
  /** Use the hardened host Bun candidate installer when the probe fails. */
  hostBun?: boolean;
  /** Why checks cannot run when the probe fails and nothing can be installed. */
  missingReason: string;
  /** Explanation recorded with the result (e.g. a requested installer that does not apply). */
  note?: string;
  /** Prefix for Python test commands after an install into a project environment. */
  wrapTests?: string;
}

function probeFor(profile: ProjectRunnerProfile): readonly string[] | undefined {
  switch (profile.language) {
    case "python":
      if (profile.testCommand?.includes("manage.py")) return PREPARATION_PROBES.django;
      if (profile.testCommand?.includes("pytest")) return PREPARATION_PROBES.pytest;
      // A custom Python runner is not evidence of a Django dependency.
      return PREPARATION_PROBES.python;
    case "javascript":
      // A package without dependencies has nothing to install.
      return profile.declaresDependencies ? PREPARATION_PROBES.nodeModules : undefined;
    case "go":
      return PREPARATION_PROBES.go;
    case "rust":
      return PREPARATION_PROBES.cargo;
    case "java":
      return profile.packageManager === "gradle"
        ? PREPARATION_PROBES.gradle
        : PREPARATION_PROBES.maven;
    default:
      return undefined;
  }
}

function missingReasonFor(profile: ProjectRunnerProfile, target: PreparationTarget): string {
  const where = target.ephemeral
    ? " This patch-sync container starts every command from its image, so the image must already contain the environment."
    : target.installsPermitted
      ? ""
      : " Use an environment that has them: a container runner image (code workspace runner container image:<ref>), or install them first.";
  switch (profile.language) {
    case "python":
      return `The Python test environment is unavailable (${profile.testCommand?.includes("manage.py") ? "django is not importable" : profile.testCommand?.includes("pytest") ? "pytest is not importable" : "python is unavailable"}).${where}`;
    case "javascript":
      return `Dependencies are not installed (no node_modules).${target.hostCandidate ? " Request dependencies:auto for a Bun text lockfile." : ""}${where}`;
    case "go":
      return `The Go toolchain is unavailable in the execution environment.${where}`;
    case "rust":
      return `The Rust toolchain (cargo) is unavailable in the execution environment.${where}`;
    case "java":
      return `The ${profile.packageManager === "gradle" ? "Gradle" : "Maven"} toolchain is unavailable in the execution environment.${where}`;
    default:
      return "No recognized project environment.";
  }
}

/**
 * Plan preparation for the detected project. A requested manager that belongs
 * to another language is never run: the plan checks the project's own
 * environment instead and records why.
 */
export function planPreparation(
  profile: ProjectRunnerProfile,
  requested: DependencyMode,
  target: PreparationTarget,
): PreparationPlan {
  const base = {
    mode: requested,
    language: profile.language,
    missingReason: missingReasonFor(profile, target),
  };
  if (requested === "none" || profile.language === "unknown") return base;
  let mode: DependencyMode = requested;
  let note: string | undefined;
  const manager = profile.packageManager;
  if ((PACKAGE_MANAGERS as readonly string[]).includes(requested)) {
    const requestedManager = requested as PackageManager;
    if (MANAGER_LANGUAGE[requestedManager] !== profile.language) {
      note = `${requestedManager} was requested, but this is a ${profile.language} project; no ${MANAGER_LANGUAGE[requestedManager]} installer runs on it. Checked the ${profile.language} environment instead.`;
      mode = "check";
    } else if (manager && requestedManager !== manager) {
      note = `${requestedManager} was requested; the project's lockfile names ${manager}, which is used.`;
    }
  }
  const plan: PreparationPlan = {
    ...base,
    ...(manager ? { manager } : {}),
    ...(note ? { note } : {}),
  };
  const probe = probeFor(profile);
  if (!probe) return plan;
  const wrapper =
    manager === "uv"
      ? UV_WRAPPER
      : manager === "pip" && profile.declaresDependencies
        ? PIP_WRAPPER
        : undefined;
  plan.probe = wrapper ? [...wrapper.split(" "), ...probe] : probe;
  if (wrapper) plan.wrapTests = wrapper;
  if (mode === "check") return plan;
  if (profile.language === "javascript" && manager === "bun" && target.hostCandidate) {
    plan.hostBun = true;
  } else if (
    target.installsPermitted &&
    manager &&
    PREPARATION_INSTALLS[manager] &&
    (manager !== "pip" || profile.declaresDependencies)
  ) {
    plan.install = PREPARATION_INSTALLS[manager];
    if (manager === "uv") plan.wrapTests = UV_WRAPPER;
  }
  return plan;
}

export type PreparationStatus = "skipped" | "ready" | "installed" | "not_run" | "error";

export interface PreparationResult {
  status: PreparationStatus;
  reason: string;
  /** Probe/install runs worth recording (a failed probe, any install). */
  runs: WorkspaceRunResult[];
  policy?: string;
  lockfileSha256?: string;
  wrapTests?: string;
}

export interface PreparationWorkspace {
  runPreparationStep?(argv: string[], beforeSpawn?: () => void): Promise<WorkspaceRunResult>;
  prepareCandidateDependencies?(beforeSpawn: () => void): Promise<CandidatePreparation>;
}

const ok = (result: WorkspaceRunResult) => result.exitCode === 0 && !result.timedOut;

/**
 * An authority re-check (access, writer lock, gate, transport) stopped the
 * verification before a spawn. It aborts the whole run, as before; it is never
 * recorded as a check outcome.
 */
export class VerificationStopped extends Error {
  constructor(readonly original: unknown) {
    super(errorText(original));
    this.name = "VerificationStopped";
  }
}

/** Wrap a pre-spawn authority check so its refusal is recognizable as a stop. */
export function stopOnRefusal(beforeSpawn?: () => void): (() => void) | undefined {
  if (!beforeSpawn) return undefined;
  return () => {
    try {
      beforeSpawn();
    } catch (error) {
      throw new VerificationStopped(error);
    }
  };
}

/** A stop that must abort verification: an authority refusal or the telnet host-exec fence. */
export function isVerificationStop(error: unknown): boolean {
  return (
    error instanceof VerificationStopped ||
    (error instanceof Error && error.name === "HostExecForbiddenError")
  );
}

/** The error a stop should surface as (the original refusal). */
export function stopCause(error: unknown): unknown {
  return error instanceof VerificationStopped ? error.original : error;
}

/** Execute a preparation plan. Never throws: an infrastructure failure is `error`. */
export async function executePreparation(
  plan: PreparationPlan,
  workspace: PreparationWorkspace,
  beforeSpawn: () => void = () => {},
): Promise<PreparationResult> {
  const note = plan.note ? ` ${plan.note}` : "";
  if (!plan.probe) {
    return {
      status: "skipped",
      reason:
        plan.mode === "none"
          ? "Dependency preparation disabled."
          : `Nothing to prepare.${note}`.trim(),
      runs: [],
    };
  }
  if (!workspace.runPreparationStep)
    return { status: "skipped", reason: "This runtime has no environment probe.", runs: [] };
  let probe: WorkspaceRunResult;
  try {
    probe = await workspace.runPreparationStep([...plan.probe], beforeSpawn);
  } catch (error) {
    if (isVerificationStop(error)) throw error;
    return { status: "error", reason: errorText(error), runs: [] };
  }
  // An available test runner does not prove all locked dependencies are present.
  if (ok(probe) && !plan.install && !plan.hostBun)
    return {
      status: "ready",
      reason: `Environment ready (${plan.probe.join(" ")}).${note}`,
      runs: [],
      ...(plan.wrapTests ? { wrapTests: plan.wrapTests } : {}),
    };
  if (probe.exitCode === 125)
    return { status: "error", reason: firstLine(probe.output) || "runner error", runs: [probe] };
  if (plan.hostBun && workspace.prepareCandidateDependencies) {
    let prepared: CandidatePreparation;
    try {
      prepared = await workspace.prepareCandidateDependencies(beforeSpawn);
    } catch (error) {
      if (isVerificationStop(error)) throw error;
      return { status: "error", reason: errorText(error), runs: [probe] };
    }
    const installed = ok(prepared.result);
    return {
      status: installed ? "installed" : "not_run",
      reason: installed
        ? `Installed locked Bun dependencies; install scripts disabled.${note}`
        : `Dependency preparation failed: ${lastLine(prepared.result.output)}${note}`,
      runs: [prepared.result],
      policy: prepared.policy,
      ...(prepared.lockfileSha256 ? { lockfileSha256: prepared.lockfileSha256 } : {}),
    };
  }
  if (plan.install) {
    let install: WorkspaceRunResult;
    try {
      install = await workspace.runPreparationStep([...plan.install], beforeSpawn);
    } catch (error) {
      if (isVerificationStop(error)) throw error;
      return { status: "error", reason: errorText(error), runs: [probe] };
    }
    return ok(install)
      ? {
          status: "installed",
          reason: `Installed dependencies (${plan.install.join(" ")}).${note}`,
          runs: [install],
          ...(plan.wrapTests ? { wrapTests: plan.wrapTests } : {}),
        }
      : {
          status: "not_run",
          reason: `Dependency installation failed (${plan.install.join(" ")}, exit ${install.exitCode}${install.timedOut ? ", timed out" : ""}).${note}`,
          runs: [probe, install],
        };
  }
  return { status: "not_run", reason: `${plan.missingReason}${note}`, runs: [probe] };
}

// ─── Scope: tests relevant to a change ───────────────────────────────────────

const SKIP_WALK = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const MAX_WALK_ENTRIES = 60_000;
const MAX_IMPORT_SCAN_FILES = 4_000;
const MAX_IMPORT_SCAN_BYTES = 256 * 1024;
export const MAX_SCOPED_TESTS = 25;

function isTestFile(language: ProjectLanguage, path: string): boolean {
  const base = posix.basename(path);
  switch (language) {
    case "python":
      return (
        base.endsWith(".py") &&
        (base.startsWith("test") || base.endsWith("_test.py") || base === "tests.py")
      );
    case "javascript":
      return (
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
        (/\.[cm]?[jt]sx?$/.test(base) && path.split("/").includes("__tests__"))
      );
    case "go":
      return base.endsWith("_test.go");
    case "java":
      return /^(Test[A-Z]\w*|\w+Tests?)\.(java|kt)$/.test(base) && path.includes("src/test/");
    default:
      return false;
  }
}

function walkFiles(root: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  let seen = 0;
  const visit = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (++seen > MAX_WALK_ENTRIES) return;
      if (SKIP_WALK.has(name) || name.startsWith(".")) continue;
      const path = rel ? `${rel}/${name}` : name;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(`${dir}/${name}`);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(`${dir}/${name}`, path);
      else if (stat.isFile() && accept(path)) out.push(path);
    }
  };
  visit(root, "");
  return out;
}

const stemOf = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "");

function namedAlongside(language: ProjectLanguage, source: string, test: string): boolean {
  const stem = stemOf(source);
  const base = posix.basename(test);
  switch (language) {
    case "python":
      return [`test_${stem}.py`, `${stem}_test.py`, `tests_${stem}.py`].includes(base);
    case "javascript":
      return new RegExp(`^${escapeRegex(stem)}\\.(test|spec)\\.[cm]?[jt]sx?$`).test(base);
    case "java":
      return [`${stem}Test`, `${stem}Tests`, `Test${stem}`].includes(stemOf(test));
    default:
      return false;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dotted module names a Python source path may be imported as. */
function pythonModules(path: string): string[] {
  const parts = path.replace(/\.pyi?$/, "").split("/");
  if (parts.at(-1) === "__init__") parts.pop();
  const names = new Set<string>();
  for (let start = 0; start < parts.length; start++) {
    const name = parts.slice(start).join(".");
    if (name) names.add(name);
    // Only strip conventional source roots, not arbitrary leading packages.
    if (!["src", "lib", "python"].includes(parts[start] ?? "")) break;
  }
  return [...names];
}

function importsPython(content: string, module: string): boolean {
  const m = escapeRegex(module);
  if (new RegExp(`^\\s*(from\\s+${m}(\\s|\\.)|import\\s+${m}(\\s|$|,|\\.))`, "m").test(content))
    return true;
  const dot = module.lastIndexOf(".");
  if (dot < 0) return false;
  const parent = escapeRegex(module.slice(0, dot));
  const leaf = escapeRegex(module.slice(dot + 1));
  return new RegExp(`^\\s*from\\s+${parent}\\s+import\\s+[^\\n]*\\b${leaf}\\b`, "m").test(content);
}

function importsJavascript(content: string, testPath: string, source: string): boolean {
  const target = source.replace(/\.[cm]?[jt]sx?$/, "");
  const spec = /(?:from\s+|require\(\s*|import\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of content.matchAll(spec)) {
    const resolved = posix
      .normalize(posix.join(posix.dirname(testPath), match[1]!))
      .replace(/\.[cm]?[jt]sx?$/, "");
    if (resolved === target || `${resolved}/index` === target) return true;
  }
  return false;
}

function importsJava(content: string, source: string): boolean {
  const match = /(?:^|\/)src\/main\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(source);
  if (!match) return false;
  const fqcn = match[1]!.replaceAll("/", ".");
  return new RegExp(`^\\s*import\\s+${escapeRegex(fqcn)}\\s*;?\\s*$`, "m").test(content);
}

export interface RelevantTests {
  /** Test files (relative paths), most relevant first, at most MAX_SCOPED_TESTS. */
  files: string[];
  /** Why each file was chosen, parallel to `files`. */
  reasons: string[];
  /** Go: package directories (`./pkg`) touched by the change. */
  packages: string[];
}

/**
 * Tests relevant to a change: touched test files, tests named after touched
 * files, then tests that import them. Bounded walk and scan; read from the
 * host files the session works on (the runner only executes).
 */
export function findRelevantTests(
  root: string,
  profile: ProjectRunnerProfile,
  touched: readonly string[],
): RelevantTests {
  const language = profile.language;
  const empty: RelevantTests = { files: [], reasons: [], packages: [] };
  if (language === "unknown" || language === "rust") return empty;
  const exists = (path: string) => {
    try {
      return statSync(`${root}/${path}`).isFile();
    } catch {
      return false;
    }
  };
  const changed = touched.filter((path) => pathLanguage(path) === language && exists(path));
  if (language === "go") {
    const packages = [
      ...new Set(
        changed.map((path) => (posix.dirname(path) === "." ? "./." : `./${posix.dirname(path)}`)),
      ),
    ].slice(0, MAX_SCOPED_TESTS);
    return { files: [], reasons: [], packages };
  }
  const chosen = new Map<string, string>();
  const add = (path: string, reason: string) => {
    if (!chosen.has(path) && chosen.size < MAX_SCOPED_TESTS) chosen.set(path, reason);
  };
  const sources = changed.filter((path) => !isTestFile(language, path));
  for (const path of changed) if (isTestFile(language, path)) add(path, "touched test");
  if (sources.length === 0)
    return { ...empty, files: [...chosen.keys()], reasons: [...chosen.values()] };
  const tests = walkFiles(root, (path) => isTestFile(language, path));
  for (const source of sources)
    for (const test of tests)
      if (namedAlongside(language, source, test)) add(test, `named after ${source}`);
  let scanned = 0;
  for (const test of tests) {
    if (chosen.size >= MAX_SCOPED_TESTS || ++scanned > MAX_IMPORT_SCAN_FILES) break;
    if (chosen.has(test)) continue;
    let content: string;
    try {
      const buffer = readFileSync(`${root}/${test}`);
      content = buffer.subarray(0, MAX_IMPORT_SCAN_BYTES).toString("utf8");
    } catch {
      continue;
    }
    const importer = sources.find((source) =>
      language === "python"
        ? pythonModules(source).some((module) => importsPython(content, module))
        : language === "javascript"
          ? importsJavascript(content, test, source)
          : importsJava(content, source),
    );
    if (importer) add(test, `imports ${importer}`);
  }
  return { files: [...chosen.keys()], reasons: [...chosen.values()], packages: [] };
}

/** JavaScript test runners whose CLI takes test file paths. */
const PATH_AWARE_JS_RUNNER = /(^|\s|\/)(jest|vitest|mocha|ava|tap)(\s|$)|bun\s+test|node\s+--test/;

/** The test command restricted to the relevant tests, or null when it cannot be scoped. */
export function scopedTestCommand(
  profile: ProjectRunnerProfile,
  relevant: RelevantTests,
): string | null {
  const command = profile.testCommand;
  if (!command) return null;
  const { files, packages } = relevant;
  switch (profile.language) {
    case "python": {
      if (files.length === 0) return null;
      if (command.includes("runtests.py")) {
        // Django's runner takes dotted labels relative to its tests/ directory.
        const labels = files
          .filter((path) => path.startsWith("tests/"))
          .map((path) => path.slice("tests/".length).replace(/\.py$/, "").replaceAll("/", "."));
        return labels.length ? `${command} ${labels.join(" ")}` : null;
      }
      if (command.includes("manage.py"))
        return `${command} ${files.map((path) => path.replace(/\.py$/, "").replaceAll("/", ".")).join(" ")}`;
      return `${command} ${files.join(" ")}`;
    }
    case "javascript": {
      if (files.length === 0 || !profile.testScript) return null;
      if (!PATH_AWARE_JS_RUNNER.test(profile.testScript)) return null;
      const manager = profile.packageManager ?? "bun";
      if (manager === "bun" && /^bun\s+test(\s|$)/.test(profile.testScript))
        return `bun test ${files.join(" ")}`;
      if (manager === "npm") return `npm run test -- ${files.join(" ")}`;
      return `${manager} run test ${files.join(" ")}`;
    }
    case "go":
      return packages.length ? `go test ${packages.join(" ")}` : null;
    case "java": {
      const classes = [...new Set(files.map(stemOf))];
      if (classes.length === 0) return null;
      return profile.packageManager === "gradle"
        ? `gradle test -q ${classes.map((name) => `--tests ${name}`).join(" ")}`
        : `mvn -B -q test -Dtest=${classes.join(",")}`;
    }
    default:
      return null;
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

export type StepRole = "check" | "typecheck" | "tests" | "full-tests";

export interface VerificationStep {
  command: string;
  role: StepRole;
  /** Per-step timeout (the full-suite budget). */
  timeoutMs?: number;
}

export interface StepPlan {
  steps: VerificationStep[];
  /** The plan meant to run tests; if none ran, the verification is `not_run`. */
  testsPlanned: boolean;
  /** Why the test scope is what it is (recorded with the result). */
  scopeNote: string;
  relevant?: RelevantTests;
}

/** Steps for stored recipe commands: run as written, test commands recognized by shape. */
export function recipeSteps(commands: readonly string[]): StepPlan {
  const steps = commands.map((command) => ({
    command,
    role: (isTestCommand(command) ? "tests" : "check") as StepRole,
  }));
  return {
    steps,
    testsPlanned: steps.some((step) => step.role === "tests"),
    scopeNote: "configured recipe",
  };
}

/** Steps for a detected project: type-check, checks, then scoped and/or full tests. */
export function detectedSteps(input: {
  profile: ProjectRunnerProfile;
  options: VerificationOptions;
  touched: readonly string[];
  relevant: RelevantTests;
  /** Paths that exist in the workspace (deleted files never become arguments). */
  exists: (path: string) => boolean;
}): StepPlan {
  const { profile, options, relevant } = input;
  const steps: VerificationStep[] = [];
  if (options.typecheck === "auto" && profile.typecheck) {
    if (profile.language === "python") {
      const files = input.touched
        .filter((path) => /\.pyi?$/.test(path) && input.exists(path))
        .slice(0, MAX_SCOPED_TESTS);
      if (files.length)
        steps.push({ command: `${profile.typecheck} ${files.join(" ")}`, role: "typecheck" });
    } else {
      steps.push({ command: profile.typecheck, role: "typecheck" });
    }
  }
  const scoped = scopedTestCommand(profile, relevant);
  const count = relevant.files.length || relevant.packages.length;
  let scopeNote = "full suite";
  for (const command of profile.verify) {
    if (command !== profile.testCommand) {
      steps.push({ command, role: "check" });
      continue;
    }
    if (options.scope === "full") {
      steps.push({ command, role: "tests" });
      scopeNote = "full suite (scope:full)";
    } else if (scoped) {
      steps.push({ command: scoped, role: "tests" });
      scopeNote = `${count} relevant test target${count === 1 ? "" : "s"}`;
      if (options.scope === "changed+full") {
        steps.push({ command, role: "full-tests", timeoutMs: options.fullBudgetMs });
        scopeNote += ", then the full suite";
      }
    } else if (options.scope === "changed") {
      scopeNote = "no tests relevant to the change were found (scope:changed)";
    } else {
      steps.push({
        command,
        role: "tests",
        ...(options.scope === "changed+full" ? { timeoutMs: options.fullBudgetMs } : {}),
      });
      scopeNote = count
        ? "full suite (this runner cannot be scoped to files)"
        : "full suite (no tests relevant to the change were found)";
    }
  }
  return { steps, testsPlanned: !!profile.testCommand, scopeNote, relevant };
}

// ─── Reading results ─────────────────────────────────────────────────────────

export interface StepOutcome {
  outcome: VerificationOutcome;
  reason: string;
}

const UNAVAILABLE =
  /command not found|executable file not found|No module named '?(pytest|mypy|django)'?$|not found in \$PATH|Executable not found|ENOENT/i;
const NO_TESTS =
  /No tests? found|No test files found|0 test files matching|No tests to run|No tests found for given includes|^Ran 0 tests/im;

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && line !== "--- stderr ---")
      ?.slice(0, 240) ?? ""
  );
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)
      ?.slice(0, 240) ?? ""
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function goRanNoTests(output: string): boolean {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.some((line) => /no test files/.test(line)) &&
    !lines.some((line) => /^(ok|FAIL|---)\s/.test(line))
  );
}

function cargoRanNoTests(output: string): boolean {
  const counts = [...output.matchAll(/running (\d+) tests?/g)].map((m) => Number(m[1]));
  return counts.length > 0 && counts.every((n) => n === 0);
}

/** Read one step's result. `result` is an Error when the command could not be started. */
export function classifyStep(
  step: VerificationStep,
  result: WorkspaceRunResult | Error,
): StepOutcome {
  if (result instanceof Error) {
    const message = result.message;
    if (UNAVAILABLE.test(message))
      return { outcome: "not_run", reason: `runner unavailable: ${firstLine(message)}` };
    return { outcome: "error", reason: firstLine(message) || "the command could not run" };
  }
  const tests = step.role === "tests" || step.role === "full-tests";
  if (result.timedOut)
    return step.role === "full-tests"
      ? { outcome: "not_run", reason: "the full suite did not finish within its time budget" }
      : { outcome: "failed", reason: `timed out after ${Math.round(result.durationMs / 1000)}s` };
  const output = result.output ?? "";
  if (result.exitCode === 125)
    return {
      outcome: "error",
      reason: firstLine(output.replace(/^--- stderr ---$/m, "")) || "runner error (exit 125)",
    };
  if (result.exitCode === 127 || (result.exitCode !== 0 && UNAVAILABLE.test(firstLine(output))))
    return {
      outcome: "not_run",
      reason: `runner unavailable: ${lastLine(output) || `exit ${result.exitCode}`}`,
    };
  if (tests) {
    if (result.exitCode === 5 && result.command.includes("pytest"))
      return { outcome: "not_run", reason: "no tests were collected" };
    if (NO_TESTS.test(output)) return { outcome: "not_run", reason: "no tests were found" };
    const binary = result.command.find((part) => ["go", "cargo"].includes(part));
    if (result.exitCode === 0 && binary === "go" && goRanNoTests(output))
      return { outcome: "not_run", reason: "no test files in the selected packages" };
    if (result.exitCode === 0 && binary === "cargo" && cargoRanNoTests(output))
      return { outcome: "not_run", reason: "no tests were found" };
  }
  if (result.exitCode === 0) return { outcome: "passed", reason: "passed" };
  return { outcome: "failed", reason: `exit ${result.exitCode}` };
}

export interface VerificationVerdict {
  outcome: VerificationOutcome;
  reason: string;
}

/**
 * The verification's outcome. Preparation that leaves the environment
 * unready, or a plan whose tests never ran, is `not_run`; a failed check is
 * `failed`; an infrastructure failure is `error`. A type-check that cannot run
 * (its tool is missing) is skipped, never a failure.
 */
export function aggregateVerification(input: {
  preparation?: Pick<PreparationResult, "status" | "reason">;
  steps: { step: VerificationStep; outcome: StepOutcome }[];
  testsPlanned: boolean;
  scopeNote?: string;
}): VerificationVerdict {
  const { preparation, steps } = input;
  if (preparation?.status === "not_run") return { outcome: "not_run", reason: preparation.reason };
  if (preparation?.status === "error")
    return { outcome: "error", reason: `preparation: ${preparation.reason}` };
  const failed = steps.find((s) => s.outcome.outcome === "failed");
  if (failed)
    return { outcome: "failed", reason: `${failed.step.command}: ${failed.outcome.reason}` };
  const errored = steps.find((s) => s.outcome.outcome === "error");
  if (errored)
    return { outcome: "error", reason: `${errored.step.command}: ${errored.outcome.reason}` };
  const testSteps = steps.filter((s) => s.step.role === "tests" || s.step.role === "full-tests");
  if (input.testsPlanned && !testSteps.some((s) => s.outcome.outcome === "passed")) {
    const why = testSteps.find((s) => s.outcome.outcome === "not_run");
    return {
      outcome: "not_run",
      reason: why
        ? `${why.step.command}: ${why.outcome.reason}`
        : (input.scopeNote ?? "no tests ran"),
    };
  }
  const blocking = steps.filter(
    (s) => s.step.role !== "typecheck" && s.outcome.outcome === "not_run",
  );
  if (!steps.some((s) => s.outcome.outcome === "passed"))
    return { outcome: "not_run", reason: blocking[0]?.outcome.reason ?? "no checks ran" };
  if (blocking.length && !input.testsPlanned)
    return {
      outcome: "not_run",
      reason: `${blocking[0]!.step.command}: ${blocking[0]!.outcome.reason}`,
    };
  return { outcome: "passed", reason: "passed" };
}
