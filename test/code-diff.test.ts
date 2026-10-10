// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  colorizeDiff,
  diffColorEnabled,
  diffPayloadFor,
  nativeEditDiff,
  readCurrentFile,
  renderDiff,
  truncationNote,
  unifiedFileDiff,
} from "../scripts/code-diff";
import { approvalDiff, NativeTerminal } from "../scripts/code-native";
import { codePerceptionFormat } from "../scripts/code-presentation";
import { CodeTerminal, formatCodePerception, terminalText } from "../scripts/code-terminal";
import { TERMINAL_HISTORY_LIMITS, TerminalViews } from "../scripts/code-views";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { diffAnchors, diffStat, firstHunk, formatDiffStat } from "../src/coding/unified-diff";
import { MarinaDB } from "../src/persistence/database";
import type { AgentAdapter, AgentOptions } from "../src/routing/agent-adapters";
import { RoutingService } from "../src/routing/service";
import type { Perception } from "../src/sdk/client";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

const ESC = "\x1b";
const TWO_FILES = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old line",
  "+new line",
  "+--- added text that looks like a header",
  " tail",
  "@@ -10,2 +11,2 @@",
  " ctx",
  "-x",
  "+y",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-diff-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("unified diff structure", () => {
  it("counts per-file additions and removals, ignoring header-looking hunk lines", () => {
    expect(diffStat(TWO_FILES)).toEqual([
      { path: "src/a.ts", added: 3, removed: 2, binary: false },
      { path: "README.md", added: 1, removed: 0, binary: false },
    ]);
    expect(formatDiffStat(diffStat(TWO_FILES))).toBe(
      ["2 files · +4 −2", "  src/a.ts   +3 −2", "  README.md  +1 −0"].join("\n"),
    );
  });

  it("anchors files and hunks for navigation and previews only the first hunk", () => {
    const lines = TWO_FILES.split("\n");
    const anchors = diffAnchors(lines);
    expect(anchors.files.map((index) => lines[index])).toEqual([
      "diff --git a/src/a.ts b/src/a.ts",
      "diff --git a/README.md b/README.md",
    ]);
    expect(anchors.hunks).toHaveLength(3);
    const preview = firstHunk(TWO_FILES);
    expect(preview.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(preview).toContain("+--- added text");
    expect(preview).not.toContain("@@ -10,2");
  });
});

describe("colouriser", () => {
  it("colours + green, - red, @@ cyan and file headers bold when enabled", () => {
    const coloured = colorizeDiff(TWO_FILES, true);
    expect(coloured).toContain(`${ESC}[1mdiff --git a/src/a.ts b/src/a.ts${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[1m--- a/src/a.ts${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[36m@@ -1,3 +1,4 @@${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[31m-old line${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[32m+new line${ESC}[0m`);
    // A hunk line that only looks like a header is still an addition.
    expect(coloured).toContain(`${ESC}[32m+--- added text that looks like a header${ESC}[0m`);
    expect(coloured).toContain("\n keep\n");
    expect(terminalText(coloured)).toBe(TWO_FILES);
  });

  it("adds nothing when disabled, under NO_COLOR or without a TTY", () => {
    expect(colorizeDiff(TWO_FILES, false)).toBe(TWO_FILES);
    expect(diffColorEnabled({ isTTY: true }, {})).toBe(true);
    expect(diffColorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(diffColorEnabled({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(diffColorEnabled({ isTTY: false }, {})).toBe(false);
    expect(diffColorEnabled(undefined, {})).toBe(false);
  });
});

describe("rendering structured diff perceptions", () => {
  const perception = (
    code: Record<string, unknown>,
    text = "Diff: .\ndiff --git a/src/a.ts b/src/a.ts\n(raw)",
  ): Perception => ({ kind: "message", timestamp: 0, data: { code, text } }) as Perception;

  it("prints the stat before the hunks and never colours or trusts server bytes", () => {
    const hostile = `${TWO_FILES}+${ESC}]52;c;cGF3bmVk${ESC}\\${ESC}[2J\n`;
    const p = perception({ event: "diff_viewed", type: "diff", content: hostile, paths: ["."] });
    expect(codePerceptionFormat(p)).toBe("diff");
    const text = formatCodePerception(p);
    expect(text).not.toContain(ESC);
    expect(text).toContain("[diff · working changes] Diff: .");
    expect(text.indexOf("2 files · +4 −2")).toBeLessThan(text.indexOf("diff --git a/src/a.ts"));
    expect(text).not.toContain("(raw)");
  });

  it("says when the server truncated, with bytes shown versus total and a narrower command", () => {
    const note = truncationNote(64 * 1024, 120 * 1024, "src/a.ts");
    expect(note).toBe(
      "[Diff truncated by the server: showing 64.0 KB of 120.0 KB. Run code diff src/a.ts to read one file in full.]",
    );
    expect(truncationNote(2048)).toContain("showing 2.0 KB (total size not reported)");
    expect(truncationNote(2048)).toContain("code diff <path>");
    const text = formatCodePerception(
      perception({
        event: "diff_viewed",
        type: "diff",
        content: TWO_FILES,
        truncated: true,
        totalBytes: 9000,
        paths: ["."],
      }),
    );
    expect(text).toContain(`showing ${Buffer.byteLength(TWO_FILES)} B of 8.8 KB`);
    expect(text).toContain("code diff <path>");
  });

  it("shows a proposal's stat and first hunk, a shown patch whole, and an apply as its stat", () => {
    const proposal = diffPayloadFor({
      event: "patch_proposed",
      type: "patch",
      content: TWO_FILES,
      artifactId: "a_1",
    })!;
    const preview = renderDiff(proposal);
    expect(preview).toContain("2 files · +4 −2");
    expect(preview).toContain("+new line");
    expect(preview).not.toContain("+hello");
    expect(preview).toContain("First of 3 hunks shown. code show a_1 prints the whole diff.");
    const shown = renderDiff(
      diffPayloadFor({ event: "artifact_shown", type: "patch", content: TWO_FILES })!,
    );
    expect(shown).toContain("+hello");
    const applied = renderDiff(
      diffPayloadFor({ event: "patch_applied", type: "patch", content: TWO_FILES })!,
    );
    expect(applied).toBe(formatDiffStat(diffStat(TWO_FILES)));
    // Other code metadata and empty diffs keep the server's text.
    expect(diffPayloadFor({ event: "diff_viewed", type: "diff", content: "" })).toBeUndefined();
    expect(diffPayloadFor({ event: "patch_rejected", type: "patch" })).toBeUndefined();
    expect(diffPayloadFor({ event: "files", type: "list", content: TWO_FILES })).toBeUndefined();
  });

  it("reports the full size when the server truncates a diff", async () => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: directory });
    git("init", "-q");
    writeFileSync(join(directory, "a.txt"), "a\n");
    git("add", "a.txt");
    writeFileSync(join(directory, "a.txt"), `${"changed line\n".repeat(20)}`);
    const result = await new LocalWorkspace(directory).diff(undefined, 64);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBe(64);
    expect(result.totalBytes).toBeGreaterThan(64);
    const whole = await new LocalWorkspace(directory).diff();
    expect(whole.truncated).toBe(false);
    expect(whole.totalBytes).toBeUndefined();
  });

  it("keeps a 40 KB diff whole while other entries are still clipped at 16 KB", () => {
    const body = Array.from({ length: 1000 }, (_, i) => `+line ${i} ${"x".repeat(30)}`).join("\n");
    const big = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,1000 @@\n${body}`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(40 * 1024);
    const views = new TerminalViews();
    views.append("coding", big, "diff");
    const snapshot = views.snapshot("coding");
    expect(snapshot).toContain("+line 999");
    expect(snapshot).not.toContain("excerpt truncated");
    const other = new TerminalViews();
    other.append("coding", big);
    expect(other.snapshot("coding")).toContain("excerpt truncated");
    expect(TERMINAL_HISTORY_LIMITS.diffEntryBytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("colours diff entries in an interactive terminal only after sanitising", async () => {
    using _env = scopeProcessState({ env: { TERM: "xterm-256color", NO_COLOR: undefined } });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
    let transcript = "";
    output.on("data", (data) => {
      transcript += data.toString();
    });
    const terminal = new CodeTerminal({
      input,
      output,
      views: true,
      line: () => {},
      interrupt: () => {},
      close: () => {},
    });
    try {
      terminal.write(`${TWO_FILES}${ESC}[31mraw`, "coding", false, "diff");
      terminal.write(`+not a diff ${ESC}[32mraw`, "coding");
      await until(() => transcript.includes("not a diff"));
      expect(transcript).toContain(`${ESC}[32m+new line${ESC}[0m`);
      expect(transcript).not.toContain(`${ESC}[31mraw`);
      expect(transcript).not.toContain(`${ESC}[32mraw`);
      expect(transcript).not.toContain(`${ESC}[32m+not a diff`);
    } finally {
      terminal.close();
      input.destroy();
      output.destroy();
    }
  });
});

describe("native edit approvals", () => {
  it("turns Claude Edit, MultiEdit and Write requests into diffs against the current file", () => {
    const file = join(directory, "app.ts");
    writeFileSync(
      file,
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
    );
    const read = (path: string) => readCurrentFile(directory, path);
    const edit = nativeEditDiff(
      { file_path: file, old_string: "two", new_string: "TWO" },
      read,
      directory,
    )!;
    expect(edit).toBe(
      [
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -1,5 +1,5 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        " four",
        " five",
      ].join("\n"),
    );
    const multi = nativeEditDiff(
      {
        file_path: file,
        edits: [
          { old_string: "one", new_string: "ONE" },
          { old_string: "twelve", new_string: "TWELVE" },
        ],
      },
      read,
      directory,
    )!;
    expect(diffStat(multi)).toEqual([{ path: "app.ts", added: 2, removed: 2, binary: false }]);
    expect(diffAnchors(multi.split("\n")).hunks).toHaveLength(2);
    const created = nativeEditDiff({ file_path: "new.ts", content: "a\nb\n" }, read, directory)!;
    expect(created.split("\n").slice(0, 3)).toEqual([
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
    ]);
    // Text that is not in the file is shown as the requested replacement, and says so.
    const missing = nativeEditDiff(
      { file_path: file, old_string: "absent", new_string: "present" },
      read,
      directory,
    )!;
    expect(missing).toContain("could not be compared");
    expect(missing).toContain("-absent\n+present");
  });

  it("shows Codex and pi patch requests and keeps JSON for other tools", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    expect(nativeEditDiff({ patch }, () => undefined)).toBe(patch);
    expect(
      nativeEditDiff(
        { changes: { "x.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b" } } },
        () => undefined,
      ),
    ).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(
      nativeEditDiff(
        { changes: [{ path: "y.ts", kind: { type: "add" }, diff: "hello\n" }] },
        () => null,
      ),
    ).toBe("--- /dev/null\n+++ b/y.ts\n@@ -0,0 +1,1 @@\n+hello");
    expect(nativeEditDiff({ path: "z.ts", oldText: "q", newText: "r" }, () => "q\n")).toContain(
      "-q\n+r",
    );
    expect(nativeEditDiff({ command: "rm -rf /" }, () => undefined)).toBeUndefined();
    expect(nativeEditDiff({ file_path: "a.ts" }, () => "a")).toBeUndefined();
    expect(approvalDiff({ command: "ls" }, { state: { cwd: directory } })).toBeUndefined();
  });

  it("produces diffs git can apply", async () => {
    const before = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const after = `${before.replace("line 3\n", "line three\n").replace("line 30\n", "")}end\n`;
    writeFileSync(join(directory, "f.txt"), before);
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: directory, stderr: "pipe" });
    git("init", "-q");
    const diff = unifiedFileDiff("f.txt", before, after);
    writeFileSync(join(directory, "p.diff"), `${diff}\n`);
    const check = git("apply", "--check", "p.diff");
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
    expect(diffAnchors(diff.split("\n")).hunks).toHaveLength(3);
  });

  it("asks Allow? [y/N] after the diff of a Claude Edit; the answer semantics are unchanged", async () => {
    const file = join(directory, "edit.ts");
    writeFileSync(file, "const a = 1;\n");
    const db = new MarinaDB(join(directory, "world.db"));
    db.createUser({ id: "owner", name: "Owner" });
    const router = new RoutingService(db, "owner");
    const client = new MarinaRoutingClient({
      url: "http://local.test",
      token: "secret",
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body));
        if (path.endsWith("/sessions")) return Response.json(router.join(body));
        if (path.endsWith("/sync")) return Response.json(router.sync(body));
        const id = path.split("/").at(-2)!;
        if (path.endsWith("/control")) return Response.json(router.control(id, body));
        if (path.endsWith("/events"))
          return Response.json({ events: router.publish(id, body.events) });
        throw new Error(`Unexpected request ${path}`);
      }) as typeof fetch,
    });
    let native: AgentOptions | undefined;
    const adapters: AgentAdapter[] = [
      {
        id: "claude",
        label: "claude",
        executable: "fixture",
        async start(options) {
          native = options;
          options.state({ status: "idle", nativeSessionId: "claude-session" });
          return { async prompt() {}, async interrupt() {}, stop() {} };
        },
      },
    ];
    const output: { text: string; format?: string }[] = [];
    const questions: string[] = [];
    const answers = ["y", "n"];
    const runtime = new NativeTerminal({
      url: "http://local.test",
      token: "secret",
      root: directory,
      directory: join(directory, "runner"),
      client,
      adapters,
      write: (text, format) => output.push({ text, format }),
      ask: async (text) => {
        questions.push(text);
        return answers.shift() ?? "";
      },
      intervalMs: 10,
    });
    try {
      await runtime.start();
      await runtime.launch({ version: 1, agent: "claude" }, "claude", "shared");
      await until(() => !!native);
      const edit = { file_path: file, old_string: "1", new_string: "2" };
      expect(await native!.ask({ kind: "permission", title: "Claude: Edit", input: edit })).toEqual(
        { allow: true },
      );
      const shown = output.find((entry) => entry.text.includes("Claude: Edit"))!;
      expect(shown.format).toBe("diff");
      expect(shown.text).toContain("1 file · +1 −1");
      expect(shown.text).toContain("-const a = 1;\n+const a = 2;");
      expect(shown.text).not.toContain("old_string");
      expect(questions.at(-1)).toContain("Allow? [y/N]");
      expect(
        await native!.ask({ kind: "permission", title: "Claude: Bash", input: { command: "ls" } }),
      ).toEqual({ allow: false });
      const bash = output.find((entry) => entry.text.includes("Claude: Bash"))!;
      expect(bash.format).toBeUndefined();
      expect(bash.text).toContain('"command": "ls"');
    } finally {
      await runtime.stop();
      db.close();
    }
  });
});
