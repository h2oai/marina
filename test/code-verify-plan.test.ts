// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project-aware `code verify`: preparation by project type (never another
 * language's installer), tests relevant to the change, four result states,
 * and execution where the session runs (host or its container runner).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRunResult } from "../src/coding/local-workspace";
import { LocalWorkspace, normalizeAllowedCodeCommand } from "../src/coding/local-workspace";
import { detectProjectRunner, isTestCommand } from "../src/coding/project-detection";
import {
  aggregateVerification,
  candidateVerificationRetry,
  classifyStep,
  detectedSteps,
  executePreparation,
  findRelevantTests,
  planPreparation,
  preparationStepKind,
  resolveVerificationOptions,
  scopedTestCommand,
  type VerificationStep,
} from "../src/coding/verification-plan";
import { codeCommand } from "../src/engine/commands/code";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { git, gitInit } from "./git-helpers";
import { cleanupDb, stripAnsi } from "./helpers";

const markers = (...names: string[]) => new Set(names);

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function run(command: string[], exitCode: number, output = "", timedOut = false) {
  return {
    command,
    exitCode,
    output,
    timedOut,
    truncated: false,
    durationMs: 10,
  } satisfies WorkspaceRunResult;
}

describe("detection: managers, Java, type-checks", () => {
  it("prepares workspace links and optional dependencies without root dependencies", () => {
    for (const manifest of [
      { workspaces: ["packages/*"] },
      { workspaces: { packages: ["packages/*"] } },
      { optionalDependencies: { optional: "1.0.0" } },
    ]) {
      const profile = detectProjectRunner({
        markers: markers("package.json", "bun.lock"),
        packageJson: JSON.stringify({ ...manifest, scripts: { test: "bun test" } }),
      });
      expect(profile.declaresDependencies).toBe(true);
      expect(
        planPreparation(profile, "bun", { installsPermitted: false, hostCandidate: true }),
      ).toMatchObject({ probe: ["test", "-d", "node_modules"], hostBun: true });
      expect(
        planPreparation(profile, "check", { installsPermitted: false, hostCandidate: true })
          .hostBun,
      ).toBeUndefined();
    }
  });

  it("names the JavaScript manager by lockfile and runs its scripts with it", () => {
    const pkg = JSON.stringify({ scripts: { test: "jest", lint: "eslint ." } });
    const npm = detectProjectRunner({
      markers: markers("package.json", "package-lock.json"),
      packageJson: pkg,
    });
    expect(npm.packageManager).toBe("npm");
    expect(npm.verify).toEqual(["npm run lint", "npm run test"]);
    expect(npm.testCommand).toBe("npm run test");
    expect(
      detectProjectRunner({ markers: markers("package.json", "pnpm-lock.yaml"), packageJson: pkg })
        .packageManager,
    ).toBe("pnpm");
    expect(
      detectProjectRunner({ markers: markers("package.json", "yarn.lock"), packageJson: pkg })
        .packageManager,
    ).toBe("yarn");
    // Bun (or no lockfile) keeps the bare shorthands.
    expect(
      detectProjectRunner({ markers: markers("package.json", "bun.lock"), packageJson: pkg })
        .verify,
    ).toEqual(["lint", "test"]);
  });

  it("detects Python managers, Java runners and configured type-checks", () => {
    expect(
      detectProjectRunner({ markers: markers("pyproject.toml", "uv.lock") }).packageManager,
    ).toBe("uv");
    expect(
      detectProjectRunner({ markers: markers("pyproject.toml", "poetry.lock") }).packageManager,
    ).toBe("poetry");
    expect(detectProjectRunner({ markers: markers("setup.py") }).packageManager).toBe("pip");
    expect(detectProjectRunner({ markers: markers("pom.xml") }).verify).toEqual(["mvn -B -q test"]);
    expect(detectProjectRunner({ markers: markers("build.gradle.kts") }).verify).toEqual([
      "gradle test -q",
    ]);
    expect(
      detectProjectRunner({
        markers: markers("pyproject.toml"),
        pythonConfig: "[tool.mypy]\nstrict = true\n",
      }).typecheck,
    ).toBe("python -m mypy");
    expect(
      detectProjectRunner({ markers: markers("pyproject.toml", "pyrightconfig.json") }).typecheck,
    ).toBe("pyright");
    const ts = detectProjectRunner({
      markers: markers("package.json", "tsconfig.json"),
      packageJson: JSON.stringify({ scripts: { test: "vitest run" } }),
    });
    expect(ts.typecheck).toBe("npx --no-install tsc --noEmit");
    // A typecheck script already covers it.
    expect(
      detectProjectRunner({
        markers: markers("package.json", "tsconfig.json"),
        packageJson: JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }),
      }).typecheck,
    ).toBeUndefined();
  });

  it("recognizes test commands by shape", () => {
    for (const command of [
      "test",
      "python -m pytest -q a.py",
      "python tests/runtests.py x",
      "go test ./...",
      "cargo test",
      "npm run test -- a.test.ts",
      "bun test a.test.ts",
      "mvn -B -q test",
      "gradle test -q",
      "uv run --frozen --no-sync python -m pytest",
    ])
      expect(isTestCommand(command)).toBe(true);
    for (const command of [
      "lint",
      "typecheck",
      "npm run lint",
      "git diff --check",
      "python -m mypy a.py",
    ])
      expect(isTestCommand(command)).toBe(false);
  });
});

describe("preparation by project type", () => {
  const python = detectProjectRunner({
    markers: markers("pyproject.toml", "package.json"),
    touched: ["pkg/a.py"],
  });
  const host = { installsPermitted: false, hostCandidate: false };

  it("never runs a JavaScript installer on a Python project", () => {
    const plan = planPreparation(python, "bun", { installsPermitted: true, hostCandidate: true });
    expect(plan.probe).toEqual(["python", "-m", "pytest", "--version"]);
    expect(plan.install).toBeUndefined();
    expect(plan.hostBun).toBeUndefined();
    expect(plan.note).toContain("this is a python project");
  });

  it("probes by default and installs only where isolated", () => {
    const js = detectProjectRunner({
      markers: markers("package.json", "package-lock.json"),
      packageJson: JSON.stringify({ dependencies: { a: "1" }, scripts: { test: "jest" } }),
    });
    expect(planPreparation(js, "check", host)).toMatchObject({
      probe: ["test", "-d", "node_modules"],
    });
    expect(planPreparation(js, "check", host).install).toBeUndefined();
    expect(planPreparation(js, "auto", host).install).toBeUndefined();
    expect(
      planPreparation(js, "auto", { installsPermitted: true, hostCandidate: false }).install,
    ).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const bun = detectProjectRunner({
      markers: markers("package.json", "bun.lock"),
      packageJson: JSON.stringify({ dependencies: { a: "1" }, scripts: { test: "bun test" } }),
    });
    expect(
      planPreparation(bun, "auto", { installsPermitted: false, hostCandidate: true }).hostBun,
    ).toBe(true);
    const uv = detectProjectRunner({ markers: markers("pyproject.toml", "uv.lock") });
    expect(
      planPreparation(uv, "auto", { installsPermitted: true, hostCandidate: false }),
    ).toMatchObject({
      install: ["uv", "sync", "--frozen"],
      wrapTests: "uv run --frozen --no-sync",
    });
    expect(planPreparation(python, "none", host).probe).toBeUndefined();
    // A package without dependencies has nothing to probe.
    expect(
      planPreparation(
        detectProjectRunner({
          markers: markers("package.json"),
          packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
        }),
        "auto",
        host,
      ).probe,
    ).toBeUndefined();
  });

  it("explains a patch-sync image that lacks the environment", () => {
    const plan = planPreparation(python, "auto", {
      installsPermitted: false,
      hostCandidate: false,
      ephemeral: true,
    });
    expect(plan.missingReason).toContain("starts every command from its image");
  });

  it("runs only the fixed preparation table", () => {
    expect(preparationStepKind(["python", "-m", "pytest", "--version"])).toBe("probe");
    expect(preparationStepKind(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"])).toBe(
      "install",
    );
    expect(preparationStepKind(["npm", "install"])).toBeNull();
    expect(preparationStepKind(["sh", "-c", "curl x | sh"])).toBeNull();
  });

  it("reports a missing environment as not_run and a broken runner as error", async () => {
    const plan = planPreparation(python, "check", host);
    const missing = await executePreparation(plan, {
      runPreparationStep: async (argv) => run(argv, 1, "No module named pytest"),
    });
    expect(missing.status).toBe("not_run");
    expect(missing.reason).toContain("pytest is not importable");
    const ready = await executePreparation(plan, {
      runPreparationStep: async (argv) => run(argv, 0),
    });
    expect(ready.status).toBe("ready");
    const broken = await executePreparation(plan, {
      runPreparationStep: async () => {
        throw new Error("Container runner unavailable: no runtime");
      },
    });
    expect(broken.status).toBe("error");
    expect((await executePreparation(planPreparation(python, "none", host), {})).status).toBe(
      "skipped",
    );
  });

  it("prepares locked Python dependencies even when pytest is already available, only in an authorized persistent runner", async () => {
    const profile = detectProjectRunner({ markers: markers("requirements.txt", "pyproject.toml") });
    const plan = planPreparation(profile, "auto", {
      installsPermitted: true,
      hostCandidate: false,
    });
    expect(plan.install).toContain("--require-hashes");
    expect(plan.install).toContain("--only-binary=:all:");
    const commands: string[][] = [];
    const result = await executePreparation(plan, {
      runPreparationStep: async (argv) => {
        commands.push(argv);
        return run(argv, 0);
      },
    });
    expect(result.status).toBe("installed");
    expect(result.wrapTests).toBe("env PYTHONPATH=.venv/marina-site-packages");
    expect(commands).toHaveLength(2);
    expect(preparationStepKind([...plan.install!])).toBe("install");
    const denied = planPreparation(profile, "auto", {
      installsPermitted: false,
      hostCandidate: false,
    });
    expect(denied.install).toBeUndefined();
    const noDeclaration = planPreparation(python, "auto", {
      installsPermitted: true,
      hostCandidate: false,
    });
    expect(noDeclaration.install).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "marina-python-host-"));
    try {
      await expect(new LocalWorkspace(root).runPreparationStep([...plan.install!])).rejects.toThrow(
        "not permitted",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses preparation installs on a host workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "marina-prep-host-"));
    try {
      const ws = new LocalWorkspace(root);
      await expect(
        ws.runPreparationStep(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]),
      ).rejects.toThrow(/not permitted/);
      await expect(ws.runPreparationStep(["rm", "-rf", "."])).rejects.toThrow(
        /Not a verification preparation step/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tests relevant to a change", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-scope-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("Python: touched tests, tests named after the change, and importers", () => {
    write(root, {
      "pyproject.toml": "[project]\nname='pkg'\n",
      "src/pkg/__init__.py": "",
      "src/pkg/parser.py": "def parse(): ...\n",
      "src/pkg/other.py": "",
      "tests/test_parser.py": "from pkg.parser import parse\n",
      "tests/test_cli.py": "from pkg import parser\n",
      "tests/test_unrelated.py": "import pkg.other\n",
      "tests/test_touched.py": "",
    });
    const profile = detectProjectRunner({
      markers: markers("pyproject.toml"),
      touched: ["src/pkg/parser.py"],
    });
    const relevant = findRelevantTests(root, profile, [
      "src/pkg/parser.py",
      "tests/test_touched.py",
    ]);
    expect(relevant.files).toEqual([
      "tests/test_touched.py",
      "tests/test_parser.py",
      "tests/test_cli.py",
    ]);
    expect(scopedTestCommand(profile, relevant)).toBe(
      "python -m pytest tests/test_touched.py tests/test_parser.py tests/test_cli.py",
    );
  });

  it("Django's runner takes labels relative to tests/", () => {
    write(root, {
      "tests/runtests.py": "",
      "setup.py": "",
      "django/db/models/query.py": "",
      "tests/queries/tests.py": "from django.db.models.query import QuerySet\n",
    });
    const profile = detectProjectRunner({
      markers: markers("setup.py", "tests/runtests.py"),
      touched: ["django/db/models/query.py"],
    });
    const relevant = findRelevantTests(root, profile, ["django/db/models/query.py"]);
    expect(scopedTestCommand(profile, relevant)).toBe("python tests/runtests.py queries.tests");
  });

  it("JavaScript: named and importing tests, only for a path-aware runner", () => {
    write(root, {
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "package-lock.json": "{}",
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": "import { a } from './a';\n",
      "test/uses-a.spec.ts": "import { a } from '../src/a.js';\n",
      "test/other.test.ts": "import { b } from '../src/b';\n",
    });
    const profile = detectProjectRunner({
      markers: markers("package.json", "package-lock.json"),
      packageJson: JSON.stringify({ scripts: { test: "vitest run" } }),
      touched: ["src/a.ts"],
    });
    const relevant = findRelevantTests(root, profile, ["src/a.ts"]);
    expect(relevant.files).toEqual(["src/a.test.ts", "test/uses-a.spec.ts"]);
    expect(scopedTestCommand(profile, relevant)).toBe(
      "npm run test -- src/a.test.ts test/uses-a.spec.ts",
    );
    // A script that cannot take paths runs the full suite.
    expect(
      scopedTestCommand({ ...profile, testScript: "node scripts/run-tests.js" }, relevant),
    ).toBeNull();
  });

  it("Go: the touched packages", () => {
    write(root, {
      "go.mod": "module x\n",
      "pkg/x.go": "package pkg\n",
      "main.go": "package main\n",
    });
    const profile = detectProjectRunner({
      markers: markers("go.mod"),
      touched: ["pkg/x.go", "main.go"],
    });
    const relevant = findRelevantTests(root, profile, ["pkg/x.go", "main.go"]);
    expect(scopedTestCommand(profile, relevant)).toBe("go test ./pkg ./.");
    expect(normalizeAllowedCodeCommand(root, ["go", "test", "./pkg", "./."])).toEqual([
      "go",
      "test",
      "./pkg",
      "./.",
    ]);
  });

  it("scope modes: auto, changed, full, changed+full", () => {
    const profile = detectProjectRunner({ markers: markers("pyproject.toml"), touched: ["a.py"] });
    const relevant = { files: ["tests/test_a.py"], reasons: ["named"], packages: [] };
    const none = { files: [], reasons: [], packages: [] };
    const steps = (scope: string, r = relevant) =>
      detectedSteps({
        profile,
        options: resolveVerificationOptions({ scope }, {}),
        touched: ["a.py"],
        relevant: r,
        exists: () => true,
      });
    expect(steps("auto").steps.map((s) => s.command)).toEqual(["python -m pytest tests/test_a.py"]);
    expect(steps("auto", none).steps.map((s) => s.command)).toEqual(["python -m pytest"]);
    expect(steps("changed", none).steps).toEqual([]);
    expect(steps("changed", none).scopeNote).toContain("no tests relevant");
    expect(steps("full").steps.map((s) => s.command)).toEqual(["python -m pytest"]);
    const both = steps("changed+full").steps;
    expect(both.map((s) => [s.command, s.role])).toEqual([
      ["python -m pytest tests/test_a.py", "tests"],
      ["python -m pytest", "full-tests"],
    ]);
    expect(both[1]!.timeoutMs).toBe(600_000);
    expect(resolveVerificationOptions({ scope: "changed,full", budget: "90s" }, {})).toMatchObject({
      scope: "changed+full",
      fullBudgetMs: 90_000,
    });
    expect(() => resolveVerificationOptions({ scope: "sideways" }, {})).toThrow(/scope must be/);
    // Junk in the environment never breaks verification.
    expect(resolveVerificationOptions({}, { MARINA_CODE_VERIFY_SCOPE: "junk" }).scope).toBe("auto");
    expect(resolveVerificationOptions({}, { MARINA_CODE_VERIFY_SCOPE: "full" }).scope).toBe("full");
  });
});

describe("result states", () => {
  const tests: VerificationStep = { command: "python -m pytest", role: "tests" };
  const pytest = ["python", "-m", "pytest"];

  it("classifies passed, failed, not_run and error", () => {
    expect(classifyStep(tests, run(pytest, 0, "3 passed")).outcome).toBe("passed");
    expect(classifyStep(tests, run(pytest, 1, "1 failed")).outcome).toBe("failed");
    expect(classifyStep(tests, run(pytest, 5, "no tests ran"))).toMatchObject({
      outcome: "not_run",
      reason: "no tests were collected",
    });
    expect(
      classifyStep(tests, run(pytest, 1, "/usr/bin/python: No module named pytest")).outcome,
    ).toBe("not_run");
    expect(classifyStep(tests, run(pytest, 127, "Executable not found in $PATH")).outcome).toBe(
      "not_run",
    );
    expect(
      classifyStep(tests, run(pytest, 125, "marina: pending diff did not apply inside the image"))
        .outcome,
    ).toBe("error");
    expect(classifyStep(tests, new Error("Container runner unavailable: no runtime")).outcome).toBe(
      "error",
    );
    expect(
      classifyStep(
        { command: "go test ./pkg", role: "tests" },
        run(["go", "test", "./pkg"], 0, "?   \tx/pkg\t[no test files]"),
      ).outcome,
    ).toBe("not_run");
    expect(
      classifyStep(
        { command: "cargo test", role: "tests" },
        run(["cargo", "test"], 0, "running 0 tests\n"),
      ).outcome,
    ).toBe("not_run");
    expect(
      classifyStep(
        { command: "python tests/runtests.py x", role: "tests" },
        run(["python"], 0, "Ran 0 tests in 0.000s\n"),
      ).outcome,
    ).toBe("not_run");
    expect(
      classifyStep({ command: "python -m pytest", role: "full-tests" }, run(pytest, -1, "", true))
        .outcome,
    ).toBe("not_run");
    expect(classifyStep(tests, run(pytest, -1, "", true)).outcome).toBe("failed");
  });

  it("aggregates: not_run and error are never a pass or a failure", () => {
    const pass = { outcome: "passed" as const, reason: "passed" };
    const notRun = { outcome: "not_run" as const, reason: "no tests were collected" };
    expect(
      aggregateVerification({
        preparation: { status: "not_run", reason: "no env" },
        steps: [],
        testsPlanned: true,
      }),
    ).toEqual({ outcome: "not_run", reason: "no env" });
    expect(
      aggregateVerification({
        preparation: { status: "error", reason: "boom" },
        steps: [],
        testsPlanned: true,
      }).outcome,
    ).toBe("error");
    expect(
      aggregateVerification({
        steps: [
          { step: { command: "lint", role: "check" }, outcome: pass },
          { step: tests, outcome: notRun },
        ],
        testsPlanned: true,
      }).outcome,
    ).toBe("not_run");
    expect(
      aggregateVerification({ steps: [{ step: tests, outcome: pass }], testsPlanned: true })
        .outcome,
    ).toBe("passed");
    expect(
      aggregateVerification({
        steps: [{ step: tests, outcome: { outcome: "failed", reason: "exit 1" } }],
        testsPlanned: true,
      }).outcome,
    ).toBe("failed");
    // An unavailable optional type-check does not block a pass.
    expect(
      aggregateVerification({
        steps: [
          { step: { command: "pyright a.py", role: "typecheck" }, outcome: notRun },
          { step: tests, outcome: pass },
        ],
        testsPlanned: true,
      }).outcome,
    ).toBe("passed");
    expect(
      aggregateVerification({
        steps: [],
        testsPlanned: true,
        scopeNote: "no tests relevant to the change were found",
      }),
    ).toMatchObject({ outcome: "not_run" });
  });
});

// ─── Command level: host and container runners ──────────────────────────────

/** A stand-in `python` that answers like pytest, steered by files in the workspace. */
const FAKE_PYTHON = `#!/bin/sh
echo "FAKEPY $*"
if [ -n "$MARINA_FAKE_CONTAINER" ]; then echo "INSIDE_CONTAINER"; fi
if [ "$3" = "--version" ]; then
  if [ -f .no-pytest ]; then echo "No module named pytest" >&2; exit 1; fi
  echo "pytest 8.0.0"; exit 0
fi
if [ -f .pytest-exit ]; then exit "$(cat .pytest-exit)"; fi
exit 0
`;

/** A stand-in container runtime that runs the command in the mounted directory. */
const FAKE_PODMAN = `#!/bin/sh
src=""
while [ $# -gt 0 ]; do
  case "$1" in
    -v) src="\${2%%:*}"; shift 2 ;;
    fake.local/img:1) shift; break ;;
    *) shift ;;
  esac
done
cd "$src" || exit 125
MARINA_FAKE_CONTAINER=1 exec "$@"
`;

const IMAGE = "fake.local/img:1";

describe("code verify (command level)", () => {
  const DB = "test_code_verify_plan.db";
  let db: MarinaDB;
  let root: string;
  let bin: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    db = new MarinaDB(DB);
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-verify-py-")));
    bin = mkdtempSync(join(tmpdir(), "marina-verify-bin-"));
    for (const [name, body] of [
      ["python", FAKE_PYTHON],
      ["podman", FAKE_PODMAN],
    ] as const) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    gitInit(root);
    write(root, {
      "pyproject.toml": "[project]\nname='pkg'\n",
      // A tooling package.json must never pull in a JavaScript installer.
      "package.json": JSON.stringify({
        dependencies: { prettier: "3.0.0" },
        scripts: { test: "jest" },
      }),
      "pkg/__init__.py": "",
      "pkg/mod.py": "x = 1\n",
      "tests/test_mod.py": "from pkg.mod import x\n",
      "tests/test_other.py": "",
      ".gitignore": ".no-pytest\n.pytest-exit\n",
    });
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    writeFileSync(join(root, "pkg/mod.py"), "x = 2\n");
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    db.close();
    cleanupDb(DB);
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const who: Entity = {
    id: "e_verify" as EntityId,
    name: "Verifier",
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: "Verifier",
    long: "",
    inventory: [],
    properties: {},
  };
  const input = (raw: string): CommandInput => {
    const args = raw.slice(raw.indexOf(" ") + 1);
    return {
      raw,
      verb: "code",
      args,
      tokens: args.split(/\s+/),
      entity: who.id,
      room: roomId("test/start"),
    };
  };
  async function setup() {
    db.saveEntity(who);
    grant(db, who.id, "code.exec");
    // Choosing a session image (no operator image) needs the runner override gate.
    grant(db, who.id, "code.exec.unrestricted");
    const command = codeCommand({
      db,
      getEntity: (id) => (id === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const sent: string[] = [];
    const ctx = {
      send: (_t: EntityId, m: string) => sent.push(stripAnsi(m)),
    } as unknown as RoomContext;
    await command.handler(ctx, input("code start Verify python"));
    return { send: (raw: string) => command.handler(ctx, input(raw)), sent };
  }
  const latest = (kind: string) =>
    db
      .listCodingArtifacts(who.properties.coding_session_id as string, 200)
      .find((a) => a.kind === kind)!;
  const commandsRan = () => {
    const session = who.properties.coding_session_id as string;
    return db
      .listCodingArtifacts(session, 200)
      .filter(
        (a) =>
          a.kind === "command_output" &&
          JSON.parse(a.metadata_json).phase !== "dependency-preparation",
      )
      .map((a) => (JSON.parse(a.metadata_json).command as string[]).join(" "));
  };

  it("passed: runs the tests relevant to the change with the Python runner, never bun", async () => {
    const { send } = await setup();
    await send("code verify dependencies:bun");
    const verification = latest("verification");
    const meta = JSON.parse(verification.metadata_json);
    expect(verification.status).toBe("complete");
    expect(meta.outcome).toBe("passed");
    expect(meta.relevantTests).toEqual(["tests/test_mod.py"]);
    expect(meta.preparation.reason).toContain("this is a python project");
    expect(commandsRan()).toEqual(["python -m pytest tests/test_mod.py"]);
    expect(commandsRan().some((c) => c.includes("bun"))).toBe(false);
  });

  it("failed: the relevant tests ran and failed", async () => {
    writeFileSync(join(root, ".pytest-exit"), "1");
    const { send } = await setup();
    await send("code verify");
    expect(latest("verification").status).toBe("failed");
    expect(JSON.parse(latest("verification").metadata_json).outcome).toBe("failed");
  });

  it("not_run: no tests collected, or the environment lacks the runner", async () => {
    writeFileSync(join(root, ".pytest-exit"), "5");
    const { send, sent } = await setup();
    await send("code verify");
    let verification = latest("verification");
    expect(verification.status).toBe("not_run");
    expect(JSON.parse(verification.metadata_json).outcomeReason).toContain(
      "no tests were collected",
    );
    rmSync(join(root, ".pytest-exit"));
    writeFileSync(join(root, ".no-pytest"), "");
    await send("code verify");
    verification = latest("verification");
    expect(verification.status).toBe("not_run");
    expect(JSON.parse(verification.metadata_json).preparation.outcome).toBe("not_run");
    expect(sent.join("\n")).toContain("Verification not run");
    expect(sent.join("\n")).toContain("Checks were not run");
  });

  it("error: a container runner that cannot start never falls back to the host", async () => {
    const { send } = await setup();
    await send(`code workspace runner container image:${IMAGE} runtime:podman`);
    // The runtime itself fails (podman's own errors exit 125); nothing runs on the host.
    writeFileSync(
      join(bin, "podman"),
      '#!/bin/sh\necho "Error: fake.local/img:1: image not known" >&2\nexit 125\n',
    );
    await send("code verify");
    const verification = latest("verification");
    expect(verification.status).toBe("error");
    expect(JSON.parse(verification.metadata_json).outcomeReason).toContain("image not known");
    expect(commandsRan()).toEqual([]);
  });

  it("runs verify and code test inside the session's container runner", async () => {
    const { send } = await setup();
    await send(`code workspace runner container image:${IMAGE} runtime:podman`);
    await send("code verify scope:full");
    const verification = latest("verification");
    const meta = JSON.parse(verification.metadata_json);
    expect(meta.outcome).toBe("passed");
    expect(meta.runner).toMatchObject({ kind: "container", image: IMAGE });
    const output = latest("command_output");
    expect(output.content_text).toContain("INSIDE_CONTAINER");
    expect(output.content_text).toContain("FAKEPY -m pytest");
    await send("code test");
    expect(latest("command_output").content_text).toContain("INSIDE_CONTAINER");
  });
});

describe.skipIf(!Bun.which("go"))("code verify (Go fixture, real toolchain)", () => {
  const DB = "test_code_verify_go.db";
  let db: MarinaDB;
  let root: string;
  beforeEach(() => {
    db = new MarinaDB(DB);
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-verify-go-")));
    gitInit(root);
    write(root, {
      "go.mod": "module example.com/fixture\n\ngo 1.21\n",
      "calc/calc.go": "package calc\n\nfunc Add(a, b int) int { return a + b }\n",
      "calc/calc_test.go":
        'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(2, 2) != 4 { t.Fatal("bad") } }\n',
      "other/other.go": "package other\n",
      "other/other_test.go":
        'package other\n\nimport "testing"\n\nfunc TestBroken(t *testing.T) { t.Fatal("unrelated failure") }\n',
    });
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
    rmSync(root, { recursive: true, force: true });
  });

  it("scopes to the touched package, and the full suite sees the unrelated failure", async () => {
    const who: Entity = {
      id: "e_go" as EntityId,
      name: "Gopher",
      kind: "agent",
      room: roomId("test/start"),
      createdAt: Date.now(),
      short: "Gopher",
      long: "",
      inventory: [],
      properties: {},
    };
    db.saveEntity(who);
    grant(db, who.id, "code.exec");
    const command = codeCommand({
      db,
      getEntity: (id) => (id === who.id ? who : undefined),
      workspace: new LocalWorkspace(root),
    });
    const ctx = { send: () => {} } as unknown as RoomContext;
    const send = (raw: string) => {
      const args = raw.slice(raw.indexOf(" ") + 1);
      return command.handler(ctx, {
        raw,
        verb: "code",
        args,
        tokens: args.split(/\s+/),
        entity: who.id,
        room: roomId("test/start"),
      });
    };
    await send("code start Go");
    writeFileSync(
      join(root, "calc/calc.go"),
      "package calc\n\n// Add adds.\nfunc Add(a, b int) int { return a + b }\n",
    );
    const session = who.properties.coding_session_id as string;
    const verification = () =>
      db.listCodingArtifacts(session, 50).find((a) => a.kind === "verification")!;
    await send("code verify");
    expect(JSON.parse(verification().metadata_json)).toMatchObject({
      outcome: "passed",
      relevantTests: ["./calc"],
    });
    await send("code verify scope:full");
    expect(JSON.parse(verification().metadata_json).outcome).toBe("failed");
  }, 120_000);
});

it("candidate retry hints preserve resolved verification options and reject injected command text", () => {
  const options = resolveVerificationOptions(
    { dependencies: "none", scope: "changed", typecheck: "off", budget: "2m" },
    {},
  );
  expect(candidateVerificationRetry(options)).toBe(
    "code verify candidate dependencies:none scope:changed typecheck:off budget:120000ms",
  );
  expect(candidateVerificationRetry(undefined)).toBe("code verify candidate");
  expect(
    candidateVerificationRetry({
      dependencies: "none; rm",
      scope: "full\nquit",
      typecheck: "off --extra",
      fullBudgetMs: -1,
    }),
  ).toBe("code verify candidate");
});
