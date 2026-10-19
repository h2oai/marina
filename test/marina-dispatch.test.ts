// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  diffFileStats,
  execApprovalRequest,
  oneShotBudgetMs,
  PRINT_EXIT,
  printOutcome,
  printResultJson,
  printVerification,
  projectSlug,
  pushTailLines,
  resolveExecMode,
  terminalCodeLifecycle,
} from "../scripts/code";
import {
  formatStatus,
  httpBaseFromUrl,
  looksLikeDirectory,
  parseDispatch,
  readPackageVersion,
  statusServerUrl,
  USAGE,
} from "../scripts/marina";
import type { Perception } from "../src/sdk/client";
import { BUILTIN_WORLD_SLUGS, BUILTIN_WORLD_SUMMARIES } from "../worlds";

describe("marina dispatcher routing", () => {
  it("routes bare invocation to the coding flow with no dir", () => {
    expect(parseDispatch([])).toEqual({ kind: "code", dir: undefined });
  });

  it("routes a path argument to the coding flow", () => {
    expect(parseDispatch(["/some/project"])).toEqual({ kind: "code", dir: "/some/project" });
    expect(parseDispatch(["."])).toEqual({ kind: "code", dir: "." });
    expect(parseDispatch([".."])).toEqual({ kind: "code", dir: ".." });
    expect(parseDispatch(["./rel"])).toEqual({ kind: "code", dir: "./rel" });
    expect(parseDispatch(["../up"])).toEqual({ kind: "code", dir: "../up" });
  });

  it("routes a bare word to the coding flow only when it is an existing directory", () => {
    const isDir = (p: string) => p === "existing";
    expect(parseDispatch(["existing"], isDir)).toEqual({ kind: "code", dir: "existing" });
    expect(parseDispatch(["myname"], isDir)).toEqual({ kind: "unknown-target", arg: "myname" });
    // A mistyped subcommand must not open Code Mode in a folder of that name.
    expect(parseDispatch(["innit"], isDir)).toEqual({ kind: "unknown-target", arg: "innit" });
    // Flags after a bare word do not rescue it.
    expect(parseDispatch(["myname", "--fresh"], isDir)).toEqual({
      kind: "unknown-target",
      arg: "myname",
    });
  });

  it("looksLikeDirectory accepts path shapes without touching the disk", () => {
    const never = () => false;
    for (const p of [".", "..", "/x", "./x", "../x"])
      expect(looksLikeDirectory(p, never)).toBe(true);
    expect(looksLikeDirectory("word", never)).toBe(false);
    expect(looksLikeDirectory("word", () => true)).toBe(true);
  });

  it("routes the explicit subcommands", () => {
    expect(parseDispatch(["init"])).toEqual({ kind: "init" });
    expect(parseDispatch(["status"])).toEqual({ kind: "status" });
    expect(parseDispatch(["status", "--port", "3420"])).toEqual({
      kind: "status",
      url: "ws://localhost:3420",
    });
    expect(parseDispatch(["status", "--url", "ws://h:9/ws"])).toEqual({
      kind: "status",
      url: "ws://h:9/ws",
    });
    expect(parseDispatch(["status", "--port", "x"]).kind).toBe("usage-error");
    expect(parseDispatch(["status", "--bogus"]).kind).toBe("usage-error");
    expect(parseDispatch(["version"])).toEqual({ kind: "version" });
    expect(parseDispatch(["--version"])).toEqual({ kind: "version" });
    expect(parseDispatch(["-v"])).toEqual({ kind: "version" });
  });

  it("resolves the status server like connect: flag, MARINA_URL, WS_PORT, default", () => {
    expect(statusServerUrl("ws://h:9/ws", { MARINA_URL: "ws://m:1" })).toBe("ws://h:9");
    expect(statusServerUrl(undefined, { MARINA_URL: "ws://m:1", WS_PORT: "3420" })).toBe(
      "ws://m:1",
    );
    expect(statusServerUrl(undefined, { WS_PORT: "3420" })).toBe("ws://localhost:3420");
    expect(statusServerUrl(undefined, {})).toBe("ws://localhost:3300");
  });

  it("reads the package version from package.json", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(readPackageVersion("/nonexistent/root")).toBe("unknown");
  });

  it("routes connect with its remaining arguments", () => {
    expect(parseDispatch(["connect", "Ada", "-c", "look"])).toEqual({
      kind: "connect",
      rest: ["Ada", "-c", "look"],
    });
  });

  it("routes start to the full server", () => {
    expect(parseDispatch(["start"])).toEqual({ kind: "start" });
  });

  it("recognizes help in all spellings", () => {
    expect(parseDispatch(["--help"])).toEqual({ kind: "help" });
    expect(parseDispatch(["-h"])).toEqual({ kind: "help" });
    expect(parseDispatch(["help"])).toEqual({ kind: "help" });
  });

  it("flags unknown options instead of treating them as directories", () => {
    expect(parseDispatch(["--bogus"])).toEqual({ kind: "usage-error", arg: "--bogus" });
    expect(parseDispatch(["/dir", "--bogus"])).toEqual({ kind: "usage-error", arg: "--bogus" });
  });

  it("parses --fresh with and without a dir", () => {
    expect(parseDispatch(["--fresh"])).toEqual({ kind: "code", dir: undefined, fresh: true });
    expect(parseDispatch(["/dir", "--fresh"])).toEqual({ kind: "code", dir: "/dir", fresh: true });
    expect(parseDispatch(["--fresh", "/dir"])).toEqual({ kind: "code", dir: "/dir", fresh: true });
  });

  it("parses -p/--print one-shot tasks in any position", () => {
    expect(parseDispatch(["-p", "fix the bug"])).toEqual({
      kind: "code",
      dir: undefined,
      print: "fix the bug",
    });
    expect(parseDispatch(["--print", "fix the bug", "/dir"])).toEqual({
      kind: "code",
      dir: "/dir",
      print: "fix the bug",
    });
    expect(parseDispatch(["/dir", "-p", "fix the bug"])).toEqual({
      kind: "code",
      dir: "/dir",
      print: "fix the bug",
    });
  });

  it("combines -p with --fresh", () => {
    expect(parseDispatch(["--fresh", "-p", "fix it", "/dir"])).toEqual({
      kind: "code",
      dir: "/dir",
      fresh: true,
      print: "fix it",
    });
  });

  it("accepts -p without an inline task as one task from stdin", () => {
    expect(parseDispatch(["-p"])).toEqual({ kind: "code", dir: undefined, taskFromStdin: true });
    expect(parseDispatch(["-p", "--fresh"])).toEqual({
      kind: "code",
      dir: undefined,
      fresh: true,
      taskFromStdin: true,
    });
    expect(parseDispatch(["--print"])).toEqual({
      kind: "code",
      dir: undefined,
      taskFromStdin: true,
    });
    expect(parseDispatch(["-p", "--json"])).toEqual({
      kind: "code",
      dir: undefined,
      json: true,
      taskFromStdin: true,
    });
  });

  it("parses the one-shot result flags, and only with -p", () => {
    expect(parseDispatch(["-p", "fix it", "--json", "--allow-unverified"])).toMatchObject({
      kind: "code",
      print: "fix it",
      json: true,
      allowUnverified: true,
    });
    expect(parseDispatch(["--json"])).toEqual({ kind: "usage-error", arg: "--json" });
    expect(parseDispatch([".", "--allow-unverified"])).toEqual({
      kind: "usage-error",
      arg: "--allow-unverified",
    });
  });

  it("parses the coder's thinking level", () => {
    expect(parseDispatch(["-p", "fix it", "--thinking", "high"])).toMatchObject({
      kind: "code",
      thinking: "high",
    });
    expect(parseDispatch(["-p", "fix it", "--thinking", "loud"])).toMatchObject({
      kind: "usage-error",
      arg: "--thinking",
    });
  });

  it("parses a one-shot driver and gives the coder a budget inside the timeout", () => {
    expect(parseDispatch(["-p", "fix it", "--driver", "crew"])).toMatchObject({
      kind: "code",
      driver: "crew",
    });
    expect(parseDispatch(["-p", "fix it", "--driver", "swarm"])).toMatchObject({
      kind: "usage-error",
      arg: "--driver",
    });
    expect(parseDispatch(["--driver", "crew"])).toMatchObject({
      kind: "usage-error",
      arg: "--driver",
    });
    expect(oneShotBudgetMs(600_000)).toBe(590_000);
    expect(oneShotBudgetMs(60_000)).toBe(58_800);
  });

  it("defaults a one-shot to delivery verification unless told otherwise", () => {
    expect(printVerification(undefined, {})).toBe("delivery");
    expect(printVerification(undefined, { MARINA_CODE_VERIFICATION: "checks" })).toBe("checks");
    expect(printVerification("candidate", { MARINA_CODE_VERIFICATION: "checks" })).toBe(
      "candidate",
    );
    expect(printVerification(undefined, { MARINA_CODE_VERIFICATION: "junk" })).toBe("delivery");
  });

  it("parses the one-shot verification requirement, and only with -p", () => {
    expect(parseDispatch(["-p", "fix it", "--verification", "delivery"])).toMatchObject({
      kind: "code",
      print: "fix it",
      verification: "delivery",
    });
    expect(parseDispatch(["-p", "fix it"])).not.toHaveProperty("verification");
    expect(parseDispatch(["-p", "fix it", "--verification", "all"])).toMatchObject({
      kind: "usage-error",
      arg: "--verification",
    });
    expect(parseDispatch(["-p", "fix it", "--verification"])).toMatchObject({
      kind: "usage-error",
      arg: "--verification",
    });
    expect(parseDispatch([".", "--verification", "checks"])).toEqual({
      kind: "usage-error",
      arg: "--verification",
    });
  });

  it("rejects a second positional directory", () => {
    expect(parseDispatch(["/a", "/b"])).toEqual({ kind: "usage-error", arg: "/b" });
  });

  it("parses --allow-exec and --dangerously-allow-all in any position", () => {
    expect(parseDispatch(["--allow-exec"])).toEqual({
      kind: "code",
      dir: undefined,
      allowExec: true,
    });
    expect(parseDispatch(["--dangerously-allow-all"])).toEqual({
      kind: "code",
      dir: undefined,
      dangerouslyAllowAll: true,
    });
    expect(parseDispatch(["/dir", "--allow-exec"])).toEqual({
      kind: "code",
      dir: "/dir",
      allowExec: true,
    });
    expect(parseDispatch(["--dangerously-allow-all", "/dir"])).toEqual({
      kind: "code",
      dir: "/dir",
      dangerouslyAllowAll: true,
    });
  });

  it("combines the exec flags with -p and a dir", () => {
    expect(parseDispatch(["-p", "fix it", "/dir", "--allow-exec"])).toEqual({
      kind: "code",
      dir: "/dir",
      print: "fix it",
      allowExec: true,
    });
    expect(parseDispatch(["--dangerously-allow-all", "--fresh", "-p", "go", "/dir"])).toEqual({
      kind: "code",
      dir: "/dir",
      fresh: true,
      print: "go",
      dangerouslyAllowAll: true,
    });
  });

  it("usage covers every flow, the new flags, and the exit codes", () => {
    for (const word of [
      "connect",
      "start",
      "status",
      "init",
      "version",
      "marina connect <name>",
      "--help",
      "[dir]",
      "-p",
      "--fresh",
      "--allow-exec",
      "--dangerously-allow-all",
    ]) {
      expect(USAGE).toContain(word);
    }
    expect(USAGE).toContain("Exit codes");
    expect(USAGE).toContain("MARINA_CODE_TASK_TIMEOUT_MS");
    expect(USAGE).toContain("~/.marina/projects/<slug>/marina.db");
    expect(USAGE).toContain("allowlist-only");
  });
});

describe("marina status helpers", () => {
  it("maps the MARINA_URL ws scheme onto http", () => {
    expect(httpBaseFromUrl("ws://localhost:3300")).toBe("http://localhost:3300");
    expect(httpBaseFromUrl("wss://marina.example/")).toBe("https://marina.example");
    expect(httpBaseFromUrl("http://localhost:3300")).toBe("http://localhost:3300");
  });

  it("renders a compact table with readiness checks and remediation", () => {
    const text = formatStatus(
      "ws://localhost:3300",
      { status: "ok", uptime: 125_000, connections: 2, rooms: 4, entities: 3, agents: 1 },
      {
        instanceName: "Marina",
        world: "Workbench",
        trustProfile: { profile: "local", autonomy: "guarded" },
        checks: [
          {
            id: "llm",
            label: "LLM provider",
            status: "off",
            detail: "no key",
            remediation: "set ANTHROPIC_API_KEY",
          },
          { id: "ws", label: "WebSocket", status: "ok", detail: "listening" },
        ],
      },
    );
    expect(text).toContain("Marina at ws://localhost:3300: ok");
    expect(text).toContain("Marina (Workbench)");
    expect(text).toContain("2m 5s");
    expect(text).toContain("2 connections");
    expect(text).toContain("trust      local · autonomy guarded");
    expect(text).toMatch(/off\s+LLM provider\s+no key/);
    expect(text).toContain("→ set ANTHROPIC_API_KEY");
    expect(text).toMatch(/ok\s+WebSocket\s+listening/);
  });

  it("names an ungated profile, marks optional extras, and drops a duplicate world name", () => {
    const text = formatStatus(
      "ws://localhost:3300",
      { status: "ok" },
      {
        instanceName: "Workbench",
        world: "Workbench",
        trustProfile: { profile: "local", autonomy: "guarded", ungated: true },
        checks: [{ id: "tabh2o", label: "TabH2O", status: "off", detail: "unset", optional: true }],
      },
    );
    expect(text).toContain("instance   Workbench\n");
    expect(text).toContain("local · ungated (gates off");
    expect(text).not.toContain("autonomy guarded");
    expect(text).toMatch(/optional\s+TabH2O/);
  });

  it("reports a readiness error inline instead of failing the whole status", () => {
    const text = formatStatus(
      "ws://localhost:3300",
      { status: "ok" },
      { error: "needs a session" },
    );
    expect(text).toContain("readiness  needs a session");
    expect(text).not.toContain("capability");
  });
});

describe("resolveExecMode (host-exec approval posture)", () => {
  it("is off when neither flag is set, regardless of TTY", () => {
    expect(resolveExecMode({}, true)).toEqual({ mode: "off" });
    expect(resolveExecMode({}, false)).toEqual({ mode: "off" });
  });

  it("maps --allow-exec to prompt and --dangerously-allow-all to auto on a TTY", () => {
    expect(resolveExecMode({ allowExec: true }, true)).toEqual({ mode: "prompt" });
    expect(resolveExecMode({ dangerouslyAllowAll: true }, true)).toEqual({ mode: "auto" });
  });

  it("lets auto (--dangerously-allow-all) win when both flags are set", () => {
    expect(resolveExecMode({ allowExec: true, dangerouslyAllowAll: true }, true)).toEqual({
      mode: "auto",
    });
  });

  it("refuses either flag without a TTY and stays allowlist-only", () => {
    const auto = resolveExecMode({ dangerouslyAllowAll: true }, false);
    expect(auto.mode).toBe("off");
    expect(auto.refusal).toContain("--dangerously-allow-all");
    expect(auto.refusal).toContain("TTY");

    const prompt = resolveExecMode({ allowExec: true }, false);
    expect(prompt.mode).toBe("off");
    expect(prompt.refusal).toContain("--allow-exec");
  });
});

describe("execApprovalRequest (server exec-approval payload)", () => {
  const perception = (execApproval: unknown): Perception =>
    ({
      kind: "message",
      timestamp: 0,
      data: { text: "approval please", execApproval },
    }) as unknown as Perception;

  it("extracts a well-formed request", () => {
    expect(
      execApprovalRequest(
        perception({
          token: "tok_1",
          argv: ["ls", "-la"],
          cwd: "/work",
          rendered: "ls -la",
        }),
      ),
    ).toEqual({ token: "tok_1", argv: ["ls", "-la"], cwd: "/work", rendered: "ls -la" });
  });

  it("ignores perceptions without a valid token+rendered payload", () => {
    expect(execApprovalRequest(perception(undefined))).toBeUndefined();
    expect(execApprovalRequest(perception({ token: "t" }))).toBeUndefined();
    expect(execApprovalRequest(perception({ rendered: "ls" }))).toBeUndefined();
    expect(
      execApprovalRequest({
        kind: "message",
        timestamp: 0,
        data: { text: "no payload" },
      } as unknown as Perception),
    ).toBeUndefined();
  });
});

describe("projectSlug (per-folder DB identity)", () => {
  it("is stable for the same absolute path", () => {
    expect(projectSlug("/home/me/projects/acme")).toBe(projectSlug("/home/me/projects/acme"));
  });

  it("distinguishes same-named folders at different paths", () => {
    const a = projectSlug("/home/me/projects/acme");
    const b = projectSlug("/tmp/checkouts/acme");
    expect(a).not.toBe(b);
    // Both keep the human-readable basename prefix.
    expect(a.startsWith("acme-")).toBe(true);
    expect(b.startsWith("acme-")).toBe(true);
  });

  it("is filesystem-safe: <sanitized-basename>-<8 hex>", () => {
    expect(projectSlug("/home/me/projects/acme")).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}$/);
    expect(projectSlug("/x/My Wild Folder!! (v2)")).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}$/);
    expect(projectSlug("/x/My Wild Folder!! (v2)")).not.toContain(" ");
    expect(projectSlug("/x/My Wild Folder!! (v2)")).not.toContain("/");
  });

  it("falls back to a usable name for degenerate basenames", () => {
    expect(projectSlug("/")).toMatch(/^project-[0-9a-f]{8}$/);
  });
});

describe("terminalCodeLifecycle (one-shot completion predicate)", () => {
  const lifecycle = (
    phase: string,
    metadata: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ): Perception =>
    ({
      kind: "message",
      timestamp: 0,
      tag: "code",
      data: {
        text: "detail",
        code: { event: "code_lifecycle", phase, sessionId: "code_abc", metadata, ...extra },
      },
    }) as unknown as Perception;

  it("matches completed and extracts the summary", () => {
    const result = terminalCodeLifecycle(
      lifecycle("completed", { terminal: true, summary: "changed a.ts; tests pass" }),
    );
    expect(result).toEqual({
      phase: "completed",
      sessionId: "code_abc",
      summary: "changed a.ts; tests pass",
    });
  });

  it("matches failed only when flagged terminal (agent death / stop-interrupt)", () => {
    expect(
      terminalCodeLifecycle(lifecycle("failed", { reason: "agent_died", terminal: true })),
    ).toEqual({ phase: "failed", sessionId: "code_abc", reason: "agent_died" });
    // A recoverable mid-run tool error also streams as "failed" — never terminal.
    expect(terminalCodeLifecycle(lifecycle("failed", { tool: "marina_code" }))).toBeUndefined();
  });

  it("ignores non-terminal phases and non-lifecycle perceptions", () => {
    expect(terminalCodeLifecycle(lifecycle("inspecting"))).toBeUndefined();
    expect(
      terminalCodeLifecycle({
        kind: "message",
        timestamp: 0,
        data: { text: "plain chatter" },
      } as unknown as Perception),
    ).toBeUndefined();
    expect(
      terminalCodeLifecycle({ kind: "system", timestamp: 0, data: {} } as unknown as Perception),
    ).toBeUndefined();
  });
});

describe("code launcher stderr tail", () => {
  it("keeps only the last max lines", () => {
    const tail: string[] = [];
    pushTailLines(tail, ["a", "b"], 3);
    pushTailLines(tail, ["c", "d"], 3);
    expect(tail).toEqual(["b", "c", "d"]);
  });

  it("skips blank lines", () => {
    const tail: string[] = [];
    pushTailLines(tail, ["", "  ", "boom: EADDRINUSE"], 5);
    expect(tail).toEqual(["boom: EADDRINUSE"]);
  });
});

describe("one-shot exits say whether the work was verified", () => {
  const completed = (verification?: string, verificationReason?: string) => ({
    phase: "completed" as const,
    ...(verification ? { verification } : {}),
    ...(verificationReason ? { verificationReason } : {}),
  });

  it("is 0 only for verified work; 3 for every other completion; 1 failed; 2 timed out", () => {
    expect(printOutcome(completed("passed"))).toEqual({ status: "verified", exitCode: 0 });
    for (const v of ["missing", "not_run", "error", "failed", "stale", "unbound", "unavailable"]) {
      const o = printOutcome(completed(v, "why"));
      expect(o).toMatchObject({ status: "unverified", exitCode: PRINT_EXIT.unverified });
      expect(o.notice).toBe(`Completed but not verified: ${v} — why`);
    }
    expect(printOutcome(completed()).notice).toBe("Completed but not verified: unknown");
    expect(printOutcome({ phase: "failed" })).toEqual({ status: "failed", exitCode: 1 });
    expect(printOutcome(undefined)).toEqual({ status: "failed", exitCode: 1 });
    expect(printOutcome("timeout")).toEqual({ status: "timeout", exitCode: 2 });
  });

  /** The completion signal exactly as `marina -p` receives it from the server. */
  const signal = (metadata: Record<string, unknown>) =>
    terminalCodeLifecycle({
      kind: "message",
      text: "",
      data: { code: { event: "code_lifecycle", phase: "completed", sessionId: "s", metadata } },
    } as unknown as Perception);
  const forced = { reason: "deadline", used: 590_000, cap: 600_000 };
  const coverage = (over: Record<string, unknown> = {}) => ({
    listed: true,
    verified: ["writes results.json"],
    unverified: [],
    notCheckable: [],
    ...over,
  });

  it("maps the recorded verification to the documented exit codes, --json agreeing", () => {
    const cases: Array<[Record<string, unknown>, string, number]> = [
      [{ verification: "passed" }, "verified", 0],
      [{ verification: "passed", requirements: coverage() }, "verified", 0],
      // A prohibition no check can observe does not unverify an observed delivery.
      [
        {
          verification: "passed",
          requirements: coverage({
            notCheckable: [{ text: "do not read /tests", reason: "not a file property" }],
          }),
        },
        "verified",
        0,
      ],
      [{ verification: "passed", budgetForced: forced }, "verified", 0],
      [{ verification: "missing", verificationReason: "no checks" }, "unverified", 3],
      [{ verification: "failed", verificationReason: "test failed" }, "unverified", 3],
      [{ verification: "failed", budgetForced: forced }, "unverified", 3],
      [{ verification: "stale", budgetForced: forced }, "unverified", 3],
      [
        { verification: "passed", requirements: coverage({ unverified: ["keeps order"] }) },
        "unverified",
        3,
      ],
      [
        { verification: "passed", requirements: coverage({ listed: false, verified: [] }) },
        "unverified",
        3,
      ],
      [
        {
          verification: "passed",
          requirements: coverage({
            verified: [],
            notCheckable: [{ text: "reads well", reason: "judgement" }],
          }),
        },
        "unverified",
        3,
      ],
    ];
    for (const [metadata, status, exitCode] of cases) {
      const end = signal(metadata);
      const outcome = printOutcome(end);
      expect({ metadata, status: outcome.status, exitCode: outcome.exitCode }).toEqual({
        metadata,
        status: status as typeof outcome.status,
        exitCode,
      });
      const json = JSON.parse(JSON.stringify(printResultJson(outcome, end, [], 1)));
      expect(json).toMatchObject({
        status,
        exitCode,
        verification: metadata.verification,
        budgetForced: metadata.budgetForced ?? null,
        requirements: metadata.requirements ?? null,
      });
    }
  });

  it("names declared not-machine-checkable requirements on a verified run, never as verified", () => {
    const end = signal({
      verification: "passed",
      requirements: coverage({
        notCheckable: [{ text: "do not read /tests", reason: "not a file property" }],
      }),
    });
    const outcome = printOutcome(end);
    expect(outcome.notice).toBe(
      "Verified. Declared not machine-checkable (recorded, not observed by a check): do not read /tests (not machine-checkable: not a file property)",
    );
    expect(end?.requirements?.verified).toEqual(["writes results.json"]);
  });

  it("reports failed and timed-out runs in --json with the process exit code", () => {
    const failed = { phase: "failed" as const, reason: "blocked", detail: "Blocked: no input" };
    expect(printResultJson(printOutcome(failed), failed, [], 1)).toMatchObject({
      status: "failed",
      exitCode: 1,
      reason: "Blocked: no input",
    });
    expect(printResultJson(printOutcome("timeout"), undefined, [], 1)).toMatchObject({
      status: "timeout",
      exitCode: 2,
      verification: null,
    });
  });

  it("--allow-unverified turns 3 into 0 and still reports it", () => {
    const o = printOutcome(completed("missing"), true);
    expect(o).toMatchObject({ status: "unverified", exitCode: 0 });
    expect(o.notice).toContain("not verified");
  });

  it("reads the run's verification from the completion signal", () => {
    const end = terminalCodeLifecycle({
      kind: "message",
      text: "",
      data: {
        code: {
          event: "code_lifecycle",
          phase: "completed",
          sessionId: "s1",
          metadata: {
            summary: "done",
            verification: "stale",
            verificationReason: "source changed",
            taskId: 7,
            runId: "r1",
          },
        },
      },
    } as unknown as Perception);
    expect(end).toEqual({
      phase: "completed",
      sessionId: "s1",
      summary: "done",
      verification: "stale",
      verificationReason: "source changed",
      taskId: 7,
      runId: "r1",
    });
  });

  it("counts added and removed lines per file of a unified diff", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+more",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(diffFileStats(diff)).toEqual([
      { path: "src/a.ts", added: 2, removed: 1 },
      { path: "b.md", added: 1, removed: 1 },
    ]);
  });
});

describe("embedding subcommands (SRV-8, SRV-11)", () => {
  it("routes acp, mcp-stdio, memory-mcp, worlds and endpoint", () => {
    expect(parseDispatch(["acp", "Ada"])).toEqual({ kind: "acp", rest: ["Ada"] });
    expect(parseDispatch(["mcp-stdio", "--data-dir", "/d"])).toEqual({
      kind: "mcp-stdio",
      rest: ["--data-dir", "/d"],
    });
    expect(parseDispatch(["memory-mcp", "--space", "s"])).toEqual({
      kind: "memory-mcp",
      rest: ["--space", "s"],
    });
    expect(parseDispatch(["worlds"])).toEqual({ kind: "worlds", json: false });
    expect(parseDispatch(["worlds", "--json"])).toEqual({ kind: "worlds", json: true });
    expect(parseDispatch(["endpoint"])).toEqual({ kind: "endpoint", showKey: false });
    expect(parseDispatch(["endpoint", "--data-dir", "/d", "--show-key"])).toEqual({
      kind: "endpoint",
      dataDir: "/d",
      showKey: true,
    });
    expect(parseDispatch(["endpoint", "--data-dir"]).kind).toBe("usage-error");
    expect(parseDispatch(["endpoint", "--bogus"]).kind).toBe("usage-error");
  });

  it("--help lists every embedding subcommand", () => {
    for (const sub of ["worlds", "endpoint", "acp", "mcp-stdio", "memory-mcp"])
      expect(USAGE).toContain(`  marina ${sub} `);
  });

  it("every builtin world has a one-line summary", () => {
    for (const slug of BUILTIN_WORLD_SLUGS)
      expect(BUILTIN_WORLD_SUMMARIES[slug]?.length).toBeGreaterThan(10);
    expect(Object.keys(BUILTIN_WORLD_SUMMARIES).sort()).toEqual([...BUILTIN_WORLD_SLUGS].sort());
  });
});
