// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  formatProjectInstructions,
  loadProjectInstructions,
  projectInstructionMetadata,
} from "../src/coding/project-instructions";
import type { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, Entity, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";

describe("scoped project instructions", () => {
  let directory: string;
  let root: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-instructions-"));
    root = join(directory, "project");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "src", "nested", "file.ts"), "export const value = 1;\n");
  });
  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it("loads only ancestors in order and retains explicit same-directory precedence", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "Root convention wins over AGENTS.md here.");
    writeFileSync(join(root, "AGENTS.md"), "Read CLAUDE.md; it wins when these disagree.");
    writeFileSync(join(root, "src", "AGENTS.md"), "Use the src tests for this subtree.");
    writeFileSync(join(root, "src", "nested", ".marina.md"), "Nested exception: use spaces.");
    writeFileSync(join(root, "other", "AGENTS.md"), "Other subtree only.");
    const instructions = await loadProjectInstructions({
      root,
      executionTarget: "local",
      target: "src/nested/file.ts",
    });
    expect(instructions.notices).toEqual([]);
    expect(instructions.sources.map((source) => [source.path, source.scope])).toEqual([
      ["CLAUDE.md", "."],
      ["AGENTS.md", "."],
      ["src/AGENTS.md", "src"],
      ["src/nested/.marina.md", "src/nested"],
    ]);
    const text = formatProjectInstructions(instructions).join("\n");
    expect(text).toContain("filename order does not establish precedence");
    expect(text).toContain("Read CLAUDE.md; it wins");
    expect(text).toContain("Scope: src/nested/ subtree");
    expect(text).not.toContain("Other subtree only.");
    expect(instructions.sources[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(projectInstructionMetadata(instructions).sources[0]).not.toHaveProperty("content");
  });

  it("makes per-file and total excerpt truncation visible without unbounded reads", async () => {
    for (const path of [
      "CLAUDE.md",
      "AGENTS.md",
      ".marina.md",
      "src/AGENTS.md",
      "src/.marina.md",
    ]) {
      writeFileSync(join(root, path), `${"x".repeat(5000)}UNSEEN_TAIL`);
    }
    const instructions = await loadProjectInstructions({
      root,
      executionTarget: "local",
      target: "src/nested",
    });
    expect(instructions.sources.map((source) => source.status)).toEqual([
      "truncated",
      "truncated",
      "truncated",
      "truncated",
      "omitted",
    ]);
    expect(
      instructions.sources.reduce((total, source) => total + (source.loadedBytes ?? 0), 0),
    ).toBe(16384);
    const text = formatProjectInstructions(instructions).join("\n");
    expect(text).toContain("Showing 4096 of 5011 bytes");
    expect(text).toContain("read this file explicitly");
    expect(text).not.toContain("UNSEEN_TAIL");
  });

  it("refreshes content and provenance after instructions change or disappear", async () => {
    const path = join(root, "src", "AGENTS.md");
    writeFileSync(path, "Old rules.");
    const options = { root, target: "src/nested/file.ts", executionTarget: "local" };
    const first = await loadProjectInstructions(options);
    writeFileSync(path, "Updated rules.");
    const second = await loadProjectInstructions(options);
    expect(first.sources[0]?.content).toBe("Old rules.");
    expect(second.sources[0]?.content).toBe("Updated rules.");
    expect(second.sources[0]?.excerptHash).not.toBe(first.sources[0]?.excerptHash);
    rmSync(path);
    expect((await loadProjectInstructions(options)).sources).toEqual([]);
  });

  it("reports unreadable instruction paths and refuses escaped or ambiguous scopes", async () => {
    writeFileSync(join(directory, "secret.md"), "PRIVATE_OUTSIDE_RULES");
    symlinkSync(join(directory, "secret.md"), join(root, "AGENTS.md"));
    mkdirSync(join(root, "CLAUDE.md"));
    const instructions = await loadProjectInstructions({ root, executionTarget: "local" });
    expect(instructions.sources.map((source) => source.status)).toEqual([
      "unreadable",
      "unreadable",
    ]);
    expect(formatProjectInstructions(instructions).join("\n")).not.toContain(
      "PRIVATE_OUTSIDE_RULES",
    );
    expect(instructions.sources[1]?.detail).toContain("non-symlink");
    for (const target of ["../secret.md", join(directory, "secret.md")]) {
      const escaped = await loadProjectInstructions({ root, executionTarget: "local", target });
      expect(escaped.sources).toEqual([]);
      expect(escaped.notices[0]).toContain("Project instructions unavailable");
    }
    symlinkSync(join(directory), join(root, "linked"));
    const linked = await loadProjectInstructions({
      root,
      executionTarget: "local",
      target: "linked/secret.md",
    });
    expect(linked.sources).toEqual([]);
    expect(linked.notices[0]).toContain("not a plain directory");
  });

  it("does not load host instructions for a sandbox or silently ignore a missing root", async () => {
    writeFileSync(join(root, "AGENTS.md"), "HOST_ONLY_RULES");
    const sandbox = await loadProjectInstructions({ root, executionTarget: "flywheel" });
    expect(sandbox.sources).toEqual([]);
    expect(formatProjectInstructions(sandbox).join("\n")).toContain("not loaded from the host");
    expect(formatProjectInstructions(sandbox).join("\n")).not.toContain("HOST_ONLY_RULES");
    const missing = await loadProjectInstructions({
      root: join(root, "missing"),
      executionTarget: "local",
    });
    expect(missing.notices[0]).toContain("Project instructions unavailable");
  });

  it("bounds ancestor discovery and rejects deep paths explicitly", async () => {
    const target = Array.from({ length: 33 }, () => "nested").join("/");
    mkdirSync(join(root, target), { recursive: true });
    const instructions = await loadProjectInstructions({ root, target, executionTarget: "local" });
    expect(instructions.notices[0]).toContain("exceeds 32 directory levels");
  });

  it("file and directory inspection expose freshly read scopes through existing commands", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const entity: Entity = {
        id: "instructions_owner" as EntityId,
        name: "Owner",
        kind: "agent",
        room: roomId("test/start"),
        createdAt: Date.now(),
        short: "Owner",
        long: "Owner",
        inventory: [],
        properties: {},
      };
      const workspace = new LocalWorkspace(root);
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace,
        workspaceRegistry: {
          defaultRoot: root,
          roots: [root],
          usesCwdFallback: false,
          workspaceForRoot: () => workspace,
        } as unknown as WorkspaceRegistry,
      });
      const messages: { text: string; metadata?: Record<string, unknown> }[] = [];
      const ctx = {
        send: (_id: EntityId, text: string, _tag?: string, metadata?: Record<string, unknown>) =>
          messages.push({ text, metadata }),
      } as unknown as RoomContext;
      async function run(args: string) {
        await command.handler(ctx, {
          raw: `code ${args}`,
          verb: "code",
          args,
          tokens: args.split(/\s+/),
          entity: entity.id,
          room: entity.room,
        } satisfies CommandInput);
      }
      const session = db.createCodingSession({
        id: "instruction-inspection",
        title: "Instructions",
        workspaceRoot: root,
        createdBy: entity.name,
      });
      entity.properties.coding_session_id = session.id;
      writeFileSync(join(root, "src", "AGENTS.md"), "First scoped rule.");
      await run("files src/nested");
      expect(messages.at(-1)?.text).toContain("First scoped rule.");
      writeFileSync(join(root, "src", "AGENTS.md"), "Changed scoped rule.");
      await run("read src/nested/file.ts");
      expect(messages.at(-1)?.text).toContain("Changed scoped rule.");
      expect(messages.at(-1)?.text).not.toContain("First scoped rule.");
      expect(messages.at(-1)?.metadata).toMatchObject({
        code: {
          event: "file_read",
          metadata: {
            projectInstructions: {
              target: "src/nested/file.ts",
              sources: [{ path: "src/AGENTS.md", scope: "src", status: "loaded" }],
            },
          },
        },
      });
    } finally {
      db.close();
    }
  });
});
