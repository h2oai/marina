// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../.github/workflows/deploy-ec2.yml", import.meta.url), "utf8"),
) as {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string; steps: Step[] }>;
};
const sha = "a".repeat(40);
const later = "b".repeat(40);
const repo = "example/marina";
const successful = {
  head_sha: sha,
  head_branch: "main",
  head_repository: { full_name: repo },
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  run_number: 1,
  run_attempt: 1,
};
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marina-deployment-gate-"));
  // Execute the workflow's actual shell gate with deterministic GitHub replies.
  // The fixture applies the actual --jq selector, including run ordering.
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  repos/*/actions/workflows/ci.yml/runs\\?*) jq "$4" "$FIXTURE_RUNS" ;;
  repos/*/git/ref/heads/main) echo "$FIXTURE_MAIN" ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function gate(
  runs: Record<string, unknown>[] = [successful],
  env: Record<string, string> = {},
  recheck = false,
) {
  const output = join(dir, "output");
  const fixtures = join(dir, "runs.json");
  writeFileSync(fixtures, JSON.stringify({ workflow_runs: runs }));
  writeFileSync(output, "");
  const step = workflow.jobs[recheck ? "deploy" : "qualify"]!.steps.find(
    (s) => s.id === (recheck ? "current" : "target"),
  )!;
  const result = Bun.spawnSync(["bash", "-c", step.run!], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      GITHUB_REPOSITORY: repo,
      GITHUB_SHA: later, // workflow_run's default-branch SHA is NOT the CI SHA.
      GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: output,
      CI_SHA: sha,
      TARGET_SHA: sha,
      EVENT_NAME: "workflow_run",
      ROLLBACK_SHA: "",
      ROLLBACK: "false",
      FIXTURE_MAIN: sha,
      FIXTURE_RUNS: fixtures,
      ...env,
    },
  });
  return { code: result.exitCode, output: readFileSync(output, "utf8") };
}

describe("production deployment qualification", () => {
  it("pins checkout to successful CI rather than workflow_run's default-branch SHA", () => {
    expect(gate()).toEqual({ code: 0, output: `sha=${sha}\nrollback=false\n` });
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.jobs.deploy!.needs).toBe("qualify");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(workflow.jobs.deploy!.steps[0]!.with?.ref).toBe("${{ needs.qualify.outputs.sha }}");
  });

  it.each([
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { head_sha: later },
    { head_branch: "feature" },
    { head_repository: { full_name: "fork/marina" } },
    { event: "pull_request" },
    { path: ".github/workflows/unrelated.yml" },
  ])("rejects an unqualified run: %j", (change) => {
    const result = gate([{ ...successful, ...change }]);
    expect(result.code).not.toBe(0);
    expect(result.output).toBe("");
  });

  it("rejects missing CI and a failed rerun after an earlier success", () => {
    expect(gate([]).code).not.toBe(0);
    expect(
      gate([successful, { ...successful, run_attempt: 2, conclusion: "failure" }]).code,
    ).not.toBe(0);
  });

  it("requires successful CI for manual deployments and rollbacks too", () => {
    const env = { EVENT_NAME: "workflow_dispatch", GITHUB_SHA: sha };
    expect(gate([], env).code).not.toBe(0);
    expect(gate([successful], env).output).toContain(`sha=${sha}`);
    const rollback = { ...env, ROLLBACK_SHA: sha, FIXTURE_MAIN: later };
    expect(gate([], rollback).code).not.toBe(0);
    expect(gate([successful], rollback)).toEqual({
      code: 0,
      output: `sha=${sha}\nrollback=true\n`,
    });
    expect(gate([successful], { ...env, ROLLBACK_SHA: "main; exit 0" }).code).not.toBe(0);
  });

  it("skips superseded revisions both before building and before production changes", () => {
    expect(gate([successful], { FIXTURE_MAIN: later })).toEqual({ code: 0, output: "" });
    expect(gate([successful], { FIXTURE_MAIN: later }, true)).toEqual({
      code: 0,
      output: "",
    });
    expect(gate([successful], {}, true)).toEqual({ code: 0, output: "deploy=true\n" });
    expect(gate([successful], { FIXTURE_MAIN: later, ROLLBACK: "true" }, true).output).toBe(
      "deploy=true\n",
    );
  });
});
