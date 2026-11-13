// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeTool, createTypedCodeTools } from "../src/agent/tools/code";
import type { ToolContext } from "../src/agent/tools/shared";
import {
  ContainerWorkspace,
  resolveContainerRunner,
  UnavailableContainerWorkspace,
} from "../src/coding/container-workspace";
import {
  type FileReadOptions,
  fileReadContinuation,
  MAX_READ_LINES,
  MAX_READ_PAGE_BYTES,
} from "../src/coding/file-read";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { describeCommand } from "../src/engine/command-manifest";
import { codeCommand } from "../src/engine/commands/code";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

let directory: string;
let root: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-code-read-"));
  root = join(directory, "workspace");
  mkdirSync(root);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("workspace file read pages", () => {
  it("reads a file beyond the old 64 KiB boundary and reconstructs every page", async () => {
    const source = Array.from(
      { length: 6001 },
      (_, i) => `${i + 1} ${"source ".repeat(12)}\n`,
    ).join("");
    writeFileSync(join(root, "large.ts"), source);
    const workspace = new LocalWorkspace(root);
    let options: FileReadOptions = {};
    let actual = "";
    let pages = 0;
    do {
      const result = await workspace.read("large.ts", options);
      actual += result.content;
      const page = result.page!;
      expect(Buffer.byteLength(page.numberedContent)).toBeLessThanOrEqual(MAX_READ_PAGE_BYTES);
      expect(page.endLine - page.offset + 1).toBeLessThanOrEqual(MAX_READ_LINES);
      pages++;
      if (!page.next) break;
      expect(fileReadContinuation(result.path, page)).toContain(`offset:${page.next.offset}`);
      options = page.next;
      expect(pages).toBeLessThan(100);
    } while (pages < 100);
    expect(pages).toBeGreaterThan(2);
    expect(actual).toBe(source);
    // Internal byte-limit callers (project detection etc.) keep their raw form.
    expect(await workspace.read("large.ts", 3)).toMatchObject({ content: "1 s", truncated: true });
    expect((await workspace.read("large.ts")).page).toBeUndefined();
  });

  it("caps requested line counts and only offers a continuation when another line exists", async () => {
    writeFileSync(join(root, "lines.txt"), "x\n".repeat(4000));
    const workspace = new LocalWorkspace(root);
    const first = await workspace.read("lines.txt", { limit: 9999 });
    expect(first.content).toBe("x\n".repeat(2000));
    expect(first.page).toMatchObject({
      offset: 1,
      endLine: 2000,
      limit: 2000,
      next: { offset: 2001, column: 1 },
    });
    const last = await workspace.read("lines.txt", { offset: 2001 });
    expect(last.content).toBe(first.content);
    expect(last.truncated).toBe(false);
    expect(last.page?.next).toBeUndefined();
  });

  it("continues oversized Unicode lines without losing characters or exceeding the byte cap", async () => {
    const source = `${"🌊é".repeat(26000)}\nlast line`;
    writeFileSync(join(root, "unicode.txt"), source);
    const workspace = new LocalWorkspace(root);
    let options: FileReadOptions = { limit: 1 };
    let actual = "";
    let pages = 0;
    while (true) {
      const result = await workspace.read("unicode.txt", options);
      const page = result.page!;
      expect(Buffer.byteLength(page.numberedContent)).toBeLessThanOrEqual(MAX_READ_PAGE_BYTES);
      expect(result.content).not.toContain("�");
      actual += result.content;
      pages++;
      if (!page.next) break;
      if (page.next.offset === 1) {
        expect(page.next.column).toBe([...actual].length + 1);
        expect(fileReadContinuation(result.path, page)).toContain(`column:${page.next.column}`);
      }
      options = { ...page.next, limit: 1 };
      expect(pages).toBeLessThan(10);
    }
    expect(actual).toBe(source);
    expect(pages).toBeGreaterThan(3);
  });

  it("preserves CRLF, blank lines and final lines without inventing a trailing line", async () => {
    writeFileSync(join(root, "crlf.txt"), "first\r\n\r\nthird");
    const workspace = new LocalWorkspace(root);
    const result = await workspace.read("crlf.txt", { offset: 2, limit: 2 });
    expect(result.content).toBe("\r\nthird");
    expect(result.page?.numberedContent).toBe("2: \r\n3: third");
    expect(result.truncated).toBe(false);
    writeFileSync(join(root, "crlf.txt"), "one\n");
    expect((await workspace.read("crlf.txt", { offset: 2 })).content).toBe("");
  });

  it("returns empty pages for empty files and offsets past EOF", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "short.txt"), "a\nb");
    const workspace = new LocalWorkspace(root);
    for (const [path, offset] of [
      ["empty.txt", 1],
      ["short.txt", 20],
    ] as const) {
      const result = await workspace.read(path, { offset });
      expect(result.content).toBe("");
      expect(result.truncated).toBe(false);
      expect(result.page?.next).toBeUndefined();
    }
  });

  it("validates ranges and keeps path confinement for paged reads", async () => {
    writeFileSync(join(root, "safe.txt"), "safe");
    writeFileSync(join(directory, "secret.txt"), "outside");
    symlinkSync(join(directory, "secret.txt"), join(root, "escape.txt"));
    const workspace = new LocalWorkspace(root);
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const key of ["offset", "limit", "column"]) {
        await expect(workspace.read("safe.txt", { [key]: value })).rejects.toThrow(
          "positive safe integer",
        );
      }
    }
    await expect(workspace.read("../secret.txt", { offset: 1 })).rejects.toThrow("escapes");
    await expect(workspace.read("escape.txt", { offset: 1 })).rejects.toThrow("escapes");
    await expect(workspace.read(".", {})).rejects.toThrow("not a file");
  });

  it("uses the same read surface for containers, unavailable containers, worktrees and granted inputs", async () => {
    writeFileSync(join(root, "file.txt"), "first\nsecond\nthird\n");
    const runner = resolveContainerRunner(
      { image: "test:latest", runtime: "podman" },
      {},
      () => "/unused/podman",
    );
    const inputs = join(directory, "inputs");
    mkdirSync(inputs);
    const registry = new WorkspaceRegistry({ roots: [root], inputRoots: [inputs] });
    writeFileSync(join(inputs, "data.txt"), "first\nsecond\nthird\n");
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "file.txt"), "first\nsecond\nthird\n");
    const workspaces = [
      new ContainerWorkspace(root, runner, {}),
      new UnavailableContainerWorkspace(root, new Error("no runtime")),
      new LocalWorkspace(worktree),
      registry.defaultWorkspace(),
    ];
    for (const workspace of workspaces) {
      const path = workspace === workspaces[3] ? join(inputs, "data.txt") : "file.txt";
      const result = await workspace.read(path, { offset: 2, limit: 1 });
      expect(result.page?.numberedContent).toBe("2: second\n");
      expect(result.page?.next).toEqual({ offset: 3, column: 1 });
    }
  });
});

describe("code read command", () => {
  let world: ReturnType<typeof createTestEngine>;
  let state: ReturnType<typeof scopeProcessState>;
  let resident: ReturnType<ReturnType<typeof createTestEngine>["login"]>;
  beforeEach(() => {
    state = scopeProcessState({ env: { MARINA_CODE_DEFAULT_ROOT: root, MARINA_CODE_ROOTS: root } });
    world = createTestEngine();
    resident = world.login("Reader");
    world.db.createCodingSession({
      id: "read-session",
      title: "Read",
      workspaceRoot: root,
      createdBy: "Reader",
    });
    const entity = world.engine.entities.get(resident.entityId)!;
    entity.properties.coding_session_id = "read-session";
    writeFileSync(join(root, "file.txt"), "first\nsecond\nthird\n");
  });
  afterEach(async () => {
    await world.dispose();
    state[Symbol.dispose]();
  });
  async function send(command: string) {
    resident.connection.clear();
    await world.engine.processCommand(resident.entityId, command);
    return resident.connection.messages.at(-1)!;
  }

  it("keeps plain reads and declares the range form as a read effect", async () => {
    const response = await send("code read file.txt");
    expect(stripAnsi(response.data?.text as string)).toContain("1: first\n2: second\n3: third\n");
    expect(response.data?.code).toMatchObject({
      event: "file_read",
      truncated: false,
      content: "1: first\n2: second\n3: third\n",
    });
    const command = codeCommand({ getEntity: () => undefined });
    const form = describeCommand(command).forms?.find((entry) =>
      entry.syntax.startsWith("code read "),
    );
    expect(form).toMatchObject({
      syntax: "code read <path> [offset:<line>] [limit:<lines>] [column:<character>]",
      effect: "read",
    });
    for (const name of ["offset", "limit", "column"]) {
      expect(form?.fields.find((field) => field.label === name)).toMatchObject({
        kind: "number",
        integer: true,
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
    }
  });

  it("accepts every modifier spelling and provides an executable continuation in text and metadata", async () => {
    for (const modifiers of [
      "offset:2 limit:1",
      "offset=2 limit=1",
      "--offset 2 --limit 1",
      "--offset=2 --limit=1",
    ]) {
      const response = await send(`code read file.txt ${modifiers}`);
      const code = response.data?.code as {
        content: string;
        commands: string[];
        metadata: { continuation: string };
      };
      expect(code.content).toBe("2: second\n");
      expect(code.metadata.continuation).toBe("code read offset:3 limit:1 -- file.txt");
      expect(code.commands).toContain(code.metadata.continuation);
      expect(stripAnsi(response.data?.text as string)).toContain(
        `[truncated; continue with: ${code.metadata.continuation}]`,
      );
      const last = await send(code.metadata.continuation);
      expect(last.data?.code).toMatchObject({ content: "3: third\n", truncated: false });
    }
    const event = world.db
      .listCodingEvents("read-session")
      .find((row) => row.kind === "file_read" && JSON.parse(row.payload_json).offset === 3)!;
    expect(JSON.parse(event.payload_json)).toMatchObject({ offset: 3, endLine: 3 });
  });

  it("continues the default line page and escapes modifier-like paths", async () => {
    writeFileSync(join(root, "limit:notes.txt"), "x\n".repeat(2100));
    const response = await send("code read -- limit:notes.txt");
    const code = response.data?.code as { metadata: { continuation: string } };
    expect(code.metadata.continuation).toBe("code read offset:2001 limit:2000 -- limit:notes.txt");
    expect((await send(code.metadata.continuation)).data?.code).toMatchObject({ truncated: false });
  });

  it("follows byte-cap continuation commands through every character of an oversized line", async () => {
    const source = `${"🌊é".repeat(20000)}\nlast line\n`;
    writeFileSync(join(root, "long line.txt"), source);
    let command: string | undefined = "code read long line.txt";
    let actual = "";
    let pages = 0;
    while (command) {
      const response = await send(command);
      const code = response.data?.code as {
        content: string;
        truncated: boolean;
        metadata: { continuation?: string; next?: { offset: number; column: number } };
      };
      actual += code.content.replace(/^\d+: /gm, "");
      expect(Buffer.byteLength(code.content)).toBeLessThanOrEqual(MAX_READ_PAGE_BYTES);
      if (code.metadata.next?.offset === 1) {
        expect(code.metadata.continuation).toContain(`column:${code.metadata.next.column}`);
      }
      expect(code.truncated).toBe(code.metadata.continuation !== undefined);
      command = code.metadata.continuation;
      expect(++pages).toBeLessThan(10);
    }
    expect(actual).toBe(source);
    expect(pages).toBeGreaterThan(2);
  });

  it("reports empty ranges and refuses invalid modifiers instead of treating them as paths", async () => {
    const response = await send("code read file.txt offset:99");
    expect(response.data?.code).toMatchObject({
      truncated: false,
      content: "[No lines at offset 99; EOF.]",
    });
    const skippedLine = await send("code read file.txt offset:1 column:100 limit:1");
    expect(skippedLine.data?.code).toMatchObject({
      truncated: true,
      content: "[No content in the requested range.]",
      metadata: { continuation: "code read offset:2 limit:1 -- file.txt" },
    });
    for (const args of [
      "offset:0",
      "limit:-1",
      "column:0",
      "offset:1.5",
      "--limit",
      "offset:no",
      "limit:9007199254740992",
    ]) {
      const reply = await send(`code read file.txt ${args}`);
      expect(reply.data?.code).toBeUndefined();
      expect(stripAnsi(reply.data?.text as string)).toMatch(
        /positive safe integer|expected a whole number|missing value/,
      );
    }
  });
});

describe("agent file read tools", () => {
  it("publishes and forwards ranges through both schemas while preserving path-only calls", async () => {
    const commands: string[] = [];
    const ctx = {
      client: {
        isConnected: () => true,
        command: async (command: string) => {
          commands.push(command);
          return [{ kind: "text", data: { text: "ok" } }];
        },
      },
      gameState: { handlePerception: () => {} },
    } as unknown as ToolContext;
    const typed = createTypedCodeTools(ctx).find((tool) => tool.name === "marina_code_read_file")!;
    const generic = createCodeTool(ctx);
    for (const tool of [typed, generic]) {
      const schema = tool.parameters as {
        properties: Record<string, { type: string; minimum?: number }>;
      };
      for (const key of ["offset", "limit", "column"])
        expect(schema.properties[key]).toMatchObject({ type: "integer", minimum: 1 });
      const action = tool === generic ? { action: "read" } : {};
      await tool.execute("plain", { ...action, path: "file.txt" });
      await tool.execute("range", {
        ...action,
        path: "file.txt",
        offset: 2500,
        limit: 20,
        column: 7,
      });
      await tool.execute("literal", { ...action, path: "limit:notes.txt", offset: 2 });
      const before = commands.length;
      for (const value of [0, -1, 1.5, "2\nsay injected", Number.MAX_SAFE_INTEGER + 1]) {
        if (tool === typed) {
          await expect(
            tool.execute("invalid", { ...action, path: "file.txt", offset: value }),
          ).rejects.toThrow("positive safe integer");
        } else {
          const result = await tool.execute("invalid", {
            ...action,
            path: "file.txt",
            offset: value,
          });
          expect(JSON.stringify(result)).toContain("positive safe integer");
        }
      }
      expect(commands).toHaveLength(before);
    }
    expect(commands).toEqual([
      "code read file.txt",
      "code read offset:2500 limit:20 column:7 -- file.txt",
      "code read offset:2 -- limit:notes.txt",
      "code read file.txt",
      "code read offset:2500 limit:20 column:7 -- file.txt",
      "code read offset:2 -- limit:notes.txt",
    ]);
  });
});
