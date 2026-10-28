// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MarinaClient } from "../../src/sdk/client";

export interface VisibleCheck {
  id: string;
  argv: string[];
  timeout_seconds: number;
}

const FILE_LIMIT = 131072;

export function requestFailureStatus(error: unknown, deadline: number, now = Date.now()): string {
  const name = error instanceof Error ? error.name : "";
  if (now >= deadline) return "deadline";
  return name === "TimeoutError" ? "request-timeout" : "error";
}

export function parseToolArguments(text: string, finishReason: unknown): Record<string, unknown> {
  if (finishReason === "length")
    throw Error(
      "Output limit truncated this tool turn; no tools from this turn were executed. Use one small write per turn, append_file for chunks, or edit_file for targeted changes. Do not repeat the complete large file.",
    );
  if (finishReason !== "stop" && finishReason !== "tool_calls")
    throw Error(`Unfinished tool turn (${String(finishReason)}); no tools were executed`);
  const args: unknown = JSON.parse(text);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Error("Tool arguments must be a JSON object");
  return args as Record<string, unknown>;
}

/** A no-tool turn is an attempted submission only when the model ended normally with text. */
export function terminalTurnStatus(finishReason: unknown, content: unknown): string {
  if (finishReason === "length") return "output-limit";
  if (finishReason !== "stop") return "unexpected-finish";
  return typeof content === "string" && content.trim() ? "submitted" : "empty-response";
}

export function workspacePath(root: string, name: string): string {
  if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw Error("Workspace paths only");
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) throw Error("Workspace paths only");
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error("Symlinks refused");
  }
  return path;
}

export function fileHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error("Symlinks refused");
      if (entry.isDirectory()) walk(path);
      else
        hashes[relative(root, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(root);
  return hashes;
}

const commandRules: Record<string, RegExp> = {
  brief: /^(?:|full|social)$/,
  note: /./s,
  recall: /./s,
  memory:
    /^(?:guide|service|usage|remember|retrieve|show|query|source|sources|start|resume|tasks|finish|kv)\b/,
  task: /^(?:list|info|create|goal|claim|progress|heartbeat|submit|children|bundle|recover)\b/,
  project: /^(?:list|create|info)\b|^\S+ (?:status|tasks|memory|propose|budget|usage)\b/,
};

export function allowedWorldCommand(input: string): boolean {
  if (/[\r\n;]/.test(input)) return false;
  const [name, ...args] = input.trim().split(/\s+/);
  return !!name && !!commandRules[name]?.test(args.join(" "));
}

export function toolDefinitions(marina: boolean, checks: VisibleCheck[]) {
  const tool = (name: string, description: string, properties: object, required: string[]) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  });
  return [
    tool(
      "list_files",
      "List all workspace files. Previous inputs and JOURNAL.md persist across phases.",
      {},
      [],
    ),
    tool(
      "read_file",
      "Read a UTF-8 workspace file, up to 65536 characters.",
      { path: { type: "string" } },
      ["path"],
    ),
    tool(
      "write_file",
      "Replace a UTF-8 file. If a complete file would exceed the response budget, use append_file for chunks or edit_file for targeted revisions. Inputs and supplied checks cannot be changed.",
      { path: { type: "string" }, content: { type: "string", maxLength: FILE_LIMIT } },
      ["path", "content"],
    ),
    tool(
      "append_file",
      "Append a UTF-8 string chunk to an existing file. expected_bytes must equal the file size returned by the previous write; a stale offset fails without writing. Keep each chunk within the response budget.",
      {
        path: { type: "string" },
        content: { type: "string", maxLength: FILE_LIMIT },
        expected_bytes: { type: "integer", minimum: 0 },
      },
      ["path", "content", "expected_bytes"],
    ),
    tool(
      "edit_file",
      "Replace one exact, unique old_text occurrence with new_text in an existing UTF-8 file. Use small edits instead of rewriting a large file. Ambiguous or missing matches fail without writing.",
      {
        path: { type: "string" },
        old_text: { type: "string", minLength: 1, maxLength: FILE_LIMIT },
        new_text: { type: "string", maxLength: FILE_LIMIT },
      },
      ["path", "old_text", "new_text"],
    ),
    tool(
      "run_checks",
      "Run one supplied visible check in an isolated, offline Python container. Workspace is read-only during execution.",
      { check: { type: "string", enum: checks.map((c) => c.id) } },
      ["check"],
    ),
    ...(marina
      ? [
          tool(
            "marina_command",
            "Use durable Marina notes, retrieval, memory, tasks and projects. Examples: note <fact>; recall <query>; note correct <id> <fact>; memory remember <text>; memory retrieve <task>; task create <title> | <description>; task list; project create <name> | <description>; brief full. All state is private to this run and survives server restart. Files remain separately available.",
            { command: { type: "string" } },
            ["command"],
          ),
        ]
      : []),
  ];
}

export async function executeTool(
  options: {
    workspace: string;
    protectedFiles: Set<string>;
    image: string;
    checks: VisibleCheck[];
    client?: MarinaClient;
    deadline?: number;
  },
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { workspace } = options;
  const remaining = () => {
    const ms = (options.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
    if (ms <= 0) throw Error("Phase deadline reached");
    return ms;
  };
  remaining();
  if (name === "list_files") return Object.keys(fileHashes(workspace));
  if (name === "read_file")
    return readFileSync(workspacePath(workspace, String(args.path)), "utf8").slice(0, 65536);
  if (name === "write_file" || name === "append_file" || name === "edit_file") {
    if (typeof args.path !== "string" || !args.path)
      throw Error("File path must be a nonempty string");
    const path = workspacePath(workspace, args.path);
    const rel = relative(workspace, path);
    if (options.protectedFiles.has(rel) || rel.startsWith("inputs/") || rel.startsWith("tests/"))
      throw Error("Supplied inputs and checks are immutable");
    let content: string;
    if (name === "edit_file") {
      if (
        typeof args.old_text !== "string" ||
        !args.old_text ||
        typeof args.new_text !== "string" ||
        args.old_text.length > FILE_LIMIT ||
        args.new_text.length > FILE_LIMIT
      )
        throw Error(
          "Supply nonempty old_text and string new_text within the 131072-character file bound",
        );
      const previous = readFileSync(path, "utf8");
      const index = previous.indexOf(args.old_text);
      if (index < 0 || previous.indexOf(args.old_text, index + 1) >= 0)
        throw Error(
          "old_text must match exactly once; read the file and choose a unique small edit",
        );
      content =
        previous.slice(0, index) + args.new_text + previous.slice(index + args.old_text.length);
    } else {
      if (typeof args.content !== "string")
        throw Error(
          "Missing string content: supply the file text as a JSON string, not an object or omitted field",
        );
      if (args.content.length > FILE_LIMIT) throw Error("File content exceeds 131072 characters");
      content = args.content;
      if (name === "append_file") {
        const previous = readFileSync(path, "utf8");
        if (
          !Number.isInteger(args.expected_bytes) ||
          args.expected_bytes !== Buffer.byteLength(previous)
        )
          throw Error("Stale or missing expected_bytes; append refused without changing the file");
        content = previous + content;
      }
    }
    if (content.length > FILE_LIMIT) throw Error("File exceeds 131072 characters");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { written: rel, bytes: Buffer.byteLength(content) };
  }
  if (name === "marina_command") {
    if (!options.client || typeof args.command !== "string" || !allowedWorldCommand(args.command))
      throw Error("Command outside evaluation tool scope");
    const reply = await options.client.command(
      args.command,
      AbortSignal.timeout(Math.max(1, Math.min(120000, remaining()))),
    );
    return reply
      .map((p) => p.data.text ?? p.data)
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join("\n")
      .slice(0, 20000);
  }
  if (name === "run_checks") {
    const check = options.checks.find((c) => c.id === args.check);
    if (!check?.argv.length) throw Error("Unknown visible check");
    const containerName = `marina-eval-${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        "podman",
        "run",
        "--rm",
        "--pull=never",
        "--name",
        containerName,
        "--network=none",
        "--read-only",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=64",
        "--userns=keep-id",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=32m",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-v",
        `${workspace}:/work:ro`,
        "-w",
        "/work",
        options.image,
        ...check.argv,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(
      () => {
        Bun.spawn(["podman", "kill", containerName], { stdout: "ignore", stderr: "ignore" });
        child.kill("SIGKILL");
      },
      Math.max(1, Math.min(60000, check.timeout_seconds * 1000, remaining())),
    );
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        check: check.id,
        argv: check.argv,
        exit,
        stdout: stdout.slice(-16000),
        stderr: stderr.slice(-8000),
        isolated: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw Error(`Unknown tool: ${name}`);
}
