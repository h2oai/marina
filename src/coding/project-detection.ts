// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export function detectPackageScripts(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function recommendedVerify(scripts: string[]): string[] {
  return ["typecheck", "lint", "test", "build"].filter((script) => scripts.includes(script));
}

/** A project language whose test runner Code Mode can run. */
export type ProjectLanguage = "javascript" | "python" | "rust" | "go" | "java";

/** The dependency manager a project's lockfile or manifest names. */
export type PackageManager =
  | "bun"
  | "npm"
  | "pnpm"
  | "yarn"
  | "pip"
  | "uv"
  | "poetry"
  | "go"
  | "cargo"
  | "maven"
  | "gradle";

/** The language each dependency manager serves. */
export const MANAGER_LANGUAGE: Readonly<Record<PackageManager, ProjectLanguage>> = {
  bun: "javascript",
  npm: "javascript",
  pnpm: "javascript",
  yarn: "javascript",
  pip: "python",
  uv: "python",
  poetry: "python",
  go: "go",
  cargo: "rust",
  maven: "java",
  gradle: "java",
};

export const PACKAGE_MANAGERS = Object.keys(MANAGER_LANGUAGE) as readonly PackageManager[];

export interface ProjectRunnerProfile {
  /** The language the verification commands target. */
  language: ProjectLanguage | "unknown";
  /** Verification commands, in order (each a `code run` command line). */
  verify: string[];
  /** Why this runner was chosen, for `code doctor` and recipe listings. */
  reason: string;
  /** The dependency manager detected for `language`, from its lockfile or manifest. */
  packageManager?: PackageManager;
  /** The entry of `verify` that runs the project's tests, when there is one. */
  testCommand?: string;
  /**
   * A type-check the project configures but `verify` does not already run:
   * `tsc --noEmit` for a tsconfig.json without a typecheck script, mypy or
   * pyright for a Python project that configures them (touched files are
   * appended at plan time).
   */
  typecheck?: string;
  /** JavaScript: declared dependencies or workspace links require preparation. */
  declaresDependencies?: boolean;
  /** JavaScript: the `test` script's command line, to know whether it accepts file paths. */
  testScript?: string;
}

/** What detection reads: marker files present at the workspace root and the touched paths. */
export interface ProjectSnapshot {
  /** Root-level marker files that exist (any of PROJECT_MARKERS). */
  markers: ReadonlySet<string>;
  /** `package.json` contents, when present. */
  packageJson?: string | null;
  /** `pyproject.toml` / `setup.cfg` contents, when present (type-checker configuration). */
  pythonConfig?: string | null;
  /** Paths changed in the working tree (relative), used to prefer a language. */
  touched?: readonly string[];
}

/** Root-level files whose presence identifies a project's language and test runner. */
export const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
  "manage.py",
  "tests/runtests.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  // Lockfiles name the dependency manager; configuration files enable a type-check.
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "tsconfig.json",
  "mypy.ini",
  ".mypy.ini",
  "pyrightconfig.json",
] as const;

/** Markers whose contents detection reads; the rest only need to exist. */
const CONTENT_MARKERS = new Set(["package.json", "pyproject.toml", "setup.cfg"]);

const EXTENSION_LANGUAGE: Record<string, ProjectLanguage> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  mts: "javascript",
  ts: "javascript",
  tsx: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "java",
};

/** The language a path's extension names, if any. */
export function pathLanguage(path: string): ProjectLanguage | null {
  return EXTENSION_LANGUAGE[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** The language most of the touched files are written in, if any. */
export function touchedLanguage(touched: readonly string[] | undefined): ProjectLanguage | null {
  if (!touched || touched.length === 0) return null;
  const counts = new Map<ProjectLanguage, number>();
  for (const path of touched) {
    const language = pathLanguage(path);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  let best: ProjectLanguage | null = null;
  let bestCount = 0;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

function hasPython(markers: ReadonlySet<string>): boolean {
  return ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "manage.py"].some(
    (marker) => markers.has(marker),
  );
}

/** The JavaScript package manager a lockfile names; Bun when there is none. */
export function javascriptManager(markers: ReadonlySet<string>): PackageManager {
  if (markers.has("bun.lock") || markers.has("bun.lockb")) return "bun";
  if (markers.has("pnpm-lock.yaml")) return "pnpm";
  if (markers.has("yarn.lock")) return "yarn";
  if (markers.has("package-lock.json") || markers.has("npm-shrinkwrap.json")) return "npm";
  return "bun";
}

function managerFor(language: ProjectLanguage, markers: ReadonlySet<string>): PackageManager {
  switch (language) {
    case "javascript":
      return javascriptManager(markers);
    case "python":
      return markers.has("uv.lock") ? "uv" : markers.has("poetry.lock") ? "poetry" : "pip";
    case "go":
      return "go";
    case "rust":
      return "cargo";
    case "java":
      return markers.has("pom.xml") ? "maven" : "gradle";
  }
}

function packageInfo(packageJson: string | null | undefined): {
  testScript?: string;
  declaresDependencies: boolean;
} {
  try {
    const parsed = JSON.parse(packageJson ?? "") as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      workspaces?: unknown;
    };
    const test = parsed.scripts?.test;
    const declared =
      Object.keys(parsed.dependencies ?? {}).length +
      Object.keys(parsed.devDependencies ?? {}).length +
      Object.keys(parsed.optionalDependencies ?? {}).length;
    // A root can have no dependencies of its own while its children need
    // installed packages and workspace links. Do not skip their preparation.
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : (parsed.workspaces as { packages?: unknown } | null)?.packages;
    const hasWorkspaces =
      Array.isArray(workspaces) &&
      workspaces.some((entry) => typeof entry === "string" && entry.trim().length > 0);
    return {
      ...(typeof test === "string" ? { testScript: test } : {}),
      declaresDependencies: declared > 0 || hasWorkspaces,
    };
  } catch {
    return { declaresDependencies: false };
  }
}

/** A type-check the project configures that `verify` does not already run. */
function typecheckFor(
  language: ProjectLanguage,
  snapshot: ProjectSnapshot,
  verify: readonly string[],
): string | undefined {
  const { markers } = snapshot;
  if (language === "javascript") {
    if (!markers.has("tsconfig.json")) return undefined;
    if (verify.some((command) => /(^|\s)typecheck$/.test(command))) return undefined;
    return "npx --no-install tsc --noEmit";
  }
  if (language === "python") {
    const config = snapshot.pythonConfig ?? "";
    if (markers.has("mypy.ini") || markers.has(".mypy.ini") || /^\[(tool\.)?mypy\]/m.test(config))
      return "python -m mypy";
    if (markers.has("pyrightconfig.json") || /^\[tool\.pyright\]/m.test(config)) return "pyright";
  }
  return undefined;
}

function runnerFor(language: ProjectLanguage, snapshot: ProjectSnapshot): string[] | null {
  const { markers } = snapshot;
  switch (language) {
    case "javascript": {
      if (!markers.has("package.json")) return null;
      const verify = recommendedVerify(detectPackageScripts(snapshot.packageJson ?? ""));
      if (verify.length === 0) return null;
      // Bun keeps the bare `code run` shorthands; another lockfile runs its own manager.
      const manager = javascriptManager(markers);
      return manager === "bun" ? verify : verify.map((script) => `${manager} run ${script}`);
    }
    case "python": {
      // Django's own repository ships its runner; a Django project uses manage.py.
      if (markers.has("tests/runtests.py")) return ["python tests/runtests.py"];
      if (markers.has("manage.py")) return ["python manage.py test"];
      return hasPython(markers) ? ["python -m pytest"] : null;
    }
    case "rust":
      return markers.has("Cargo.toml") ? ["cargo test"] : null;
    case "go":
      return markers.has("go.mod") ? ["go test ./..."] : null;
    case "java":
      if (markers.has("pom.xml")) return ["mvn -B -q test"];
      return markers.has("build.gradle") || markers.has("build.gradle.kts")
        ? ["gradle test -q"]
        : null;
  }
}

function languagesPresent(markers: ReadonlySet<string>): ProjectLanguage[] {
  const out: ProjectLanguage[] = [];
  if (hasPython(markers) || markers.has("tests/runtests.py")) out.push("python");
  if (markers.has("Cargo.toml")) out.push("rust");
  if (markers.has("go.mod")) out.push("go");
  if (markers.has("pom.xml") || markers.has("build.gradle") || markers.has("build.gradle.kts"))
    out.push("java");
  if (markers.has("package.json")) out.push("javascript");
  return out;
}

/** Whether a verification command runs a test suite (not lint, build or a type-check). */
export function isTestCommand(command: string): boolean {
  let argv = command.trim().split(/\s+/).filter(Boolean);
  // Environment wrappers (`uv run --frozen --no-sync …`) run the wrapped command.
  if (argv[0] === "uv" && argv[1] === "run") {
    argv = argv.slice(2);
    while (argv[0]?.startsWith("-")) argv = argv.slice(1);
  }
  const [binary, ...rest] = argv;
  if (!binary) return false;
  if (rest.length === 0) return binary === "test";
  if (binary === "python" || binary === "python3")
    return (
      (rest[0] === "-m" && rest[1] === "pytest") ||
      (rest[0] === "manage.py" && rest[1] === "test") ||
      /(^|\/)runtests\.py$/.test(rest[0] ?? "")
    );
  if (binary === "cargo" || binary === "go" || binary === "gradle") return rest[0] === "test";
  if (binary === "mvn") return rest.includes("test");
  if (["bun", "npm", "pnpm", "yarn"].includes(binary))
    return rest[0] === "test" || (rest[0] === "run" && rest[1] === "test");
  return false;
}

function profileFor(
  language: ProjectLanguage,
  verify: string[],
  reason: string,
  snapshot: ProjectSnapshot,
): ProjectRunnerProfile {
  const typecheck = typecheckFor(language, snapshot, verify);
  const testCommand = verify.find(isTestCommand);
  return {
    language,
    verify,
    reason,
    packageManager: managerFor(language, snapshot.markers),
    ...(testCommand ? { testCommand } : {}),
    ...(typecheck ? { typecheck } : {}),
    ...(language === "javascript" ? packageInfo(snapshot.packageJson) : {}),
    ...(language === "python"
      ? { declaresDependencies: snapshot.markers.has("requirements.txt") }
      : {}),
  };
}

/**
 * Choose verification commands from the project's markers, preferring the
 * language of the touched files. A repository that carries a `package.json`
 * for tooling but whose changes are Python gets its Python runner, not
 * `bun run test`. A stored `default` recipe still overrides this.
 */
export function detectProjectRunner(snapshot: ProjectSnapshot): ProjectRunnerProfile {
  const preferred = touchedLanguage(snapshot.touched);
  if (preferred) {
    const verify = runnerFor(preferred, snapshot);
    if (verify) return profileFor(preferred, verify, `touched ${preferred} files`, snapshot);
  }
  for (const language of languagesPresent(snapshot.markers)) {
    const verify = runnerFor(language, snapshot);
    if (verify) return profileFor(language, verify, `${language} project markers`, snapshot);
  }
  return { language: "unknown", verify: [], reason: "no recognized project markers" };
}

/** The subset of a workspace detection reads; never spawns beyond `diff` / `changedPaths`. */
export interface DetectableWorkspace {
  read(input: string, maxBytes?: number): Promise<{ content: string }>;
  diff(input?: string, maxBytes?: number): Promise<{ content: string }>;
  /** Paths changed against HEAD, including staged and untracked files (when supported). */
  changedPaths?(): Promise<string[]>;
}

async function readMarkers(
  workspace: DetectableWorkspace,
): Promise<Pick<ProjectSnapshot, "markers" | "packageJson" | "pythonConfig">> {
  const markers = new Set<string>();
  let packageJson: string | null = null;
  let pythonConfig = "";
  for (const marker of PROJECT_MARKERS) {
    // Lockfiles can be large; presence is all detection needs from them.
    const file = await workspace
      .read(marker, CONTENT_MARKERS.has(marker) ? 64 * 1024 : 1)
      .catch(() => null);
    if (!file) continue;
    markers.add(marker);
    if (marker === "package.json") packageJson = file.content;
    if (marker === "pyproject.toml" || marker === "setup.cfg") pythonConfig += `${file.content}\n`;
  }
  return { markers, packageJson, pythonConfig };
}

/** The workspace's changed paths: `changedPaths()` when available, else the unstaged diff. */
export async function workspaceTouchedPaths(workspace: DetectableWorkspace): Promise<string[]> {
  if (workspace.changedPaths) {
    const changed = await workspace.changedPaths().catch(() => null);
    if (changed) return changed;
  }
  const diff = await workspace.diff(undefined, 256 * 1024).catch(() => null);
  return diff ? diffTouchedPaths(diff.content) : [];
}

/** Detect the runner for a workspace from its root markers and working-tree changes. */
export async function detectWorkspaceRunner(
  workspace: DetectableWorkspace,
  touched?: readonly string[],
): Promise<ProjectRunnerProfile> {
  const snapshot = await readMarkers(workspace);
  return detectProjectRunner({
    ...snapshot,
    touched: touched ?? (await workspaceTouchedPaths(workspace)),
  });
}

/** Paths named in a unified diff's `diff --git a/<path> b/<path>` headers. */
export function diffTouchedPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (match?.[2]) out.add(match[2]);
  }
  return [...out];
}
