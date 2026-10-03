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
export type ProjectLanguage = "javascript" | "python" | "rust" | "go";

export interface ProjectRunnerProfile {
  /** The language the verification commands target. */
  language: ProjectLanguage | "unknown";
  /** Verification commands, in order (each a `code run` command line). */
  verify: string[];
  /** Why this runner was chosen, for `code doctor` and recipe listings. */
  reason: string;
}

/** What detection reads: marker files present at the workspace root and the touched paths. */
export interface ProjectSnapshot {
  /** Root-level marker files that exist (any of PROJECT_MARKERS). */
  markers: ReadonlySet<string>;
  /** `package.json` contents, when present. */
  packageJson?: string | null;
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
] as const;

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
};

/** The language most of the touched files are written in, if any. */
export function touchedLanguage(touched: readonly string[] | undefined): ProjectLanguage | null {
  if (!touched || touched.length === 0) return null;
  const counts = new Map<ProjectLanguage, number>();
  for (const path of touched) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const language = EXTENSION_LANGUAGE[ext];
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

function runnerFor(language: ProjectLanguage, snapshot: ProjectSnapshot): string[] | null {
  const { markers } = snapshot;
  switch (language) {
    case "javascript": {
      if (!markers.has("package.json")) return null;
      const verify = recommendedVerify(detectPackageScripts(snapshot.packageJson ?? ""));
      return verify.length > 0 ? verify : null;
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
  }
}

function languagesPresent(markers: ReadonlySet<string>): ProjectLanguage[] {
  const out: ProjectLanguage[] = [];
  if (hasPython(markers) || markers.has("tests/runtests.py")) out.push("python");
  if (markers.has("Cargo.toml")) out.push("rust");
  if (markers.has("go.mod")) out.push("go");
  if (markers.has("package.json")) out.push("javascript");
  return out;
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
    if (verify) return { language: preferred, verify, reason: `touched ${preferred} files` };
  }
  for (const language of languagesPresent(snapshot.markers)) {
    const verify = runnerFor(language, snapshot);
    if (verify) return { language, verify, reason: `${language} project markers` };
  }
  return { language: "unknown", verify: [], reason: "no recognized project markers" };
}

/** The subset of a workspace detection reads; never spawns beyond `diff`. */
export interface DetectableWorkspace {
  read(input: string, maxBytes?: number): Promise<{ content: string }>;
  diff(input?: string, maxBytes?: number): Promise<{ content: string }>;
}

/** Detect the runner for a workspace from its root markers and working-tree changes. */
export async function detectWorkspaceRunner(
  workspace: DetectableWorkspace,
): Promise<ProjectRunnerProfile> {
  const markers = new Set<string>();
  let packageJson: string | null = null;
  for (const marker of PROJECT_MARKERS) {
    const file = await workspace.read(marker, 64 * 1024).catch(() => null);
    if (!file) continue;
    markers.add(marker);
    if (marker === "package.json") packageJson = file.content;
  }
  const diff = await workspace.diff(undefined, 256 * 1024).catch(() => null);
  return detectProjectRunner({
    markers,
    packageJson,
    touched: diff ? diffTouchedPaths(diff.content) : [],
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
