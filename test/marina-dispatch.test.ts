// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  execApprovalRequest,
  projectSlug,
  pushTailLines,
  resolveExecMode,
  terminalCodeLifecycle,
} from "../scripts/code";
import { parseDispatch, USAGE } from "../scripts/marina";
import type { Perception } from "../src/sdk/client";

describe("marina dispatcher routing", () => {
  it("routes bare invocation to the coding flow with no dir", () => {
    expect(parseDispatch([])).toEqual({ kind: "code", dir: undefined });
  });

  it("routes a path argument to the coding flow", () => {
    expect(parseDispatch(["/some/project"])).toEqual({ kind: "code", dir: "/some/project" });
    expect(parseDispatch(["."])).toEqual({ kind: "code", dir: "." });
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

  it("rejects -p without a task (or with a flag-shaped follow-up)", () => {
    expect(parseDispatch(["-p"])).toEqual({ kind: "usage-error", arg: "-p" });
    expect(parseDispatch(["-p", "--fresh"])).toEqual({ kind: "usage-error", arg: "-p" });
    expect(parseDispatch(["--print"])).toEqual({ kind: "usage-error", arg: "--print" });
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
    ).toEqual({ phase: "failed", sessionId: "code_abc", summary: undefined });
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
