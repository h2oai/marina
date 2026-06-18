import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle, AgentStatus } from "../src/agent/agent-types";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { WorkspaceRegistry } from "../src/coding/workspace-registry";
import { codeCommand } from "../src/engine/commands/code";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_code_command.db";

describe("code command startup", () => {
  it("does not fail engine startup when the configured code workspace is unavailable", () => {
    const previousRoot = process.env.MARINA_CODE_DEFAULT_ROOT;
    const previousRoots = process.env.MARINA_CODE_ROOTS;
    const dbName = "test_code_command_startup.db";
    const db = new MarinaDB(dbName);
    try {
      process.env.MARINA_CODE_DEFAULT_ROOT = join(
        tmpdir(),
        `marina-missing-code-root-${Date.now()}`,
      );
      delete process.env.MARINA_CODE_ROOTS;

      expect(
        () => new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db }),
      ).not.toThrow();
    } finally {
      if (previousRoot === undefined) delete process.env.MARINA_CODE_DEFAULT_ROOT;
      else process.env.MARINA_CODE_DEFAULT_ROOT = previousRoot;
      if (previousRoots === undefined) delete process.env.MARINA_CODE_ROOTS;
      else process.env.MARINA_CODE_ROOTS = previousRoots;
      db.close();
      cleanupDb(dbName);
    }
  });
});

describe("code command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("starts and lists a local coding session", async () => {
    await engine.processCommand(conn.entity!, "code start Test Session");

    const text = stripAnsi(conn.lastText());
    expect(text).toContain("Coding session started:");
    expect(text).toContain("Test Session");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "session_started",
      type: "session",
      title: "Test Session",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code list");

    const list = stripAnsi(conn.lastText());
    expect(list).toContain("Coding Sessions");
    expect(list).toContain("Test Session");
  });

  it("branches sessions, shows the tree, and completes a session", async () => {
    await engine.processCommand(conn.entity!, "code start Main Work");
    const entity = engine.entities.get(conn.entity!)!;
    const parentId = entity.properties.coding_session_id as string;

    conn.clear();
    await engine.processCommand(conn.entity!, "code branch Alternative Work");
    const branchText = stripAnsi(conn.lastText());
    expect(branchText).toContain("Coding session branched:");
    expect(branchText).toContain(`Parent: ${parentId}`);
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "session_branched",
      parentSessionId: parentId,
      type: "session",
    });
    const childId = entity.properties.coding_session_id as string;
    expect(childId).not.toBe(parentId);

    conn.clear();
    await engine.processCommand(conn.entity!, "code tree");
    const tree = stripAnsi(conn.lastText());
    expect(tree).toContain("Coding Session Tree");
    expect(tree).toContain(parentId);
    expect(tree).toContain(childId);
    expect(tree).toContain("Alternative Work");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "session_tree",
      type: "tree",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code status");
    const status = stripAnsi(conn.lastText());
    expect(status).toContain("Pending patches:");
    expect(status).toContain("Latest artifact:");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "session_status",
      sessionId: childId,
      type: "session",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code done implemented the alternate approach");
    const done = stripAnsi(conn.lastText());
    expect(done).toContain(`Coding session completed: ${childId}`);
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "session_completed",
      sessionId: childId,
      status: "complete",
      type: "session",
    });
    expect(db.getCodingSession(childId)?.status).toBe("complete");
    expect(db.getCodingSession(childId)?.mode).toBe("done");
    const completion = db
      .listCodingArtifacts(childId, 10)
      .find((artifact) => artifact.kind === "completion");
    expect(completion?.content_text).toContain("implemented the alternate approach");
  });

  it("lists and reads workspace files", async () => {
    await engine.processCommand(conn.entity!, "code start");
    conn.clear();

    await engine.processCommand(conn.entity!, "code files .");
    expect(stripAnsi(conn.lastText())).toContain("README.md");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "files_listed",
      type: "list",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code read README.md");
    const read = stripAnsi(conn.lastText());
    expect(read).toContain("README.md");
    expect(read).toContain("Marina");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "file_read",
      type: "file",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code search Marina");
    expect(stripAnsi(conn.lastText())).toContain("Code Search");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "workspace_searched",
      query: "Marina",
      type: "search",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code diff");
    expect(stripAnsi(conn.lastText())).toContain("Diff:");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "diff_viewed",
      type: "diff",
    });
  });

  it("routes unprefixed commands while Code Mode is active", async () => {
    await engine.processCommand(conn.entity!, "code");
    expect(stripAnsi(conn.lastText())).toContain("Code Mode active.");

    conn.clear();
    await engine.processCommand(conn.entity!, "start Modal Session");
    expect(stripAnsi(conn.lastText())).toContain("Coding session started:");

    conn.clear();
    await engine.processCommand(conn.entity!, "files .");
    expect(stripAnsi(conn.lastText())).toContain("README.md");

    conn.clear();
    await engine.processCommand(conn.entity!, "exit");
    expect(stripAnsi(conn.lastText())).toContain("Exited Code Mode.");

    conn.clear();
    await engine.processCommand(conn.entity!, "files .");
    expect(stripAnsi(conn.lastText())).toContain("Unknown command: files");
  });

  it("stores a code profile and applies pi-style aliases in Code Mode", async () => {
    await engine.processCommand(conn.entity!, "code profile use pi");
    const entity = engine.entities.get(conn.entity!)!;
    expect(entity.properties.code_profile).toBe("pi");
    expect(stripAnsi(conn.lastText())).toContain("Code profile set: pi");

    conn.clear();
    await engine.processCommand(conn.entity!, "code");
    expect(stripAnsi(conn.lastText())).toContain("Profile: pi");
    expect(stripAnsi(conn.lastText())).toContain("prompt: pi>");

    conn.clear();
    await engine.processCommand(conn.entity!, "start Pi Session");
    expect(stripAnsi(conn.lastText())).toContain("Coding session started:");

    conn.clear();
    await engine.processCommand(conn.entity!, "open README.md");
    const read = stripAnsi(conn.lastText());
    expect(read).toContain("README.md");
    expect(read).toContain("Marina");

    conn.clear();
    await engine.processCommand(conn.entity!, "follow up prefer small patches");
    expect(stripAnsi(conn.lastText())).toContain("Steering recorded: prefer small patches");

    const sessionId = entity.properties.coding_session_id as string;
    const events = db.listCodingEvents(sessionId, 10);
    const steering = events.find((event) => event.kind === "session_steered");
    expect(steering).toBeTruthy();
    expect(steering?.payload_json).toContain("prefer small patches");
    expect(steering?.payload_json).toContain('"profile":"pi"');

    conn.clear();
    await engine.processCommand(conn.entity!, "code branch Pi Branch");
    conn.clear();
    await engine.processCommand(conn.entity!, "tree");
    expect(stripAnsi(conn.lastText())).toContain("Coding Session Tree");
  });

  it("compares profiles and shows migration help", async () => {
    await engine.processCommand(conn.entity!, "code profile compare");
    const comparison = stripAnsi(conn.lastText());
    expect(comparison).toContain("Code Profile Comparison");
    expect(comparison).toContain("Action | marina | pi | claude | codex");
    expect(comparison).toContain("vendor-neutral Marina primitives");
    expect(comparison).toContain(
      "Record plan | plan | plan | plan | plan | plan artifact | native | typed artifact",
    );
    expect(comparison).toContain("Verify checks | verify; test/lint/typecheck run one command");
    expect(comparison).toContain("Verify app behavior | observe; run app planned");
    expect(comparison).toContain("Prompt context | code> context strip");
    expect(comparison).toContain("Inspect run policy | run allowlist");
    expect(comparison).toContain("Pin artifact | pin");
    expect(comparison).toContain("Archive artifact | archive");
    expect(comparison).toContain("List failures | artifacts failed; show last failed");
    expect(comparison).toContain("Approval semantics | patch then apply; run allowlist");
    expect(comparison).toContain("Marina primitive | Grade | Portability | Behavior");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "profile_compared",
      title: "Code Profile Comparison",
      type: "profile",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code profile help codex");
    const help = stripAnsi(conn.lastText());
    expect(help).toContain("Code Profile: codex");
    expect(help).toContain("Prompt: codex>");
    expect(help).toContain("Marina primitives are the durable, vendor-neutral contract");
    expect(help).toContain("inspect -> files");
    expect(help).toContain(
      "Verify checks: check -> verify; run test for one command -> verify -> verification; run -> command_output; grade=native",
    );
    expect(help).toContain(
      "Verify app behavior: browser/test workflow -> observation artifact; grade=planned",
    );
    expect(help).toContain("List failures: show last failed -> artifact status/exit metadata");
    expect(help).toContain("Approval semantics: approval policy -> artifact + host policy");
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      event: "profile_help_shown",
      title: "Code Profile: codex",
      type: "profile",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, "code profile help unknown");
    expect(stripAnsi(conn.lastText())).toContain("Usage: code profile help");
  });

  it("supports claude and codex migration profiles in Code Mode", async () => {
    await engine.processCommand(conn.entity!, "code profile list");
    const list = stripAnsi(conn.lastText());
    expect(list).toContain("claude");
    expect(list).toContain("codex");

    conn.clear();
    await engine.processCommand(conn.entity!, "code profile use claude");
    const entity = engine.entities.get(conn.entity!)!;
    expect(entity.properties.code_profile).toBe("claude");
    expect(stripAnsi(conn.lastText())).toContain("Prompt: claude>");

    conn.clear();
    await engine.processCommand(conn.entity!, "code");
    const claudeEntry = stripAnsi(conn.lastText());
    expect(claudeEntry).toContain("Profile: claude");
    expect(claudeEntry).toContain("prompt: claude>");

    conn.clear();
    await engine.processCommand(conn.entity!, "start Claude Session");
    expect(stripAnsi(conn.lastText())).toContain("Coding session started:");

    conn.clear();
    await engine.processCommand(conn.entity!, "plan prefer review before apply");
    expect(stripAnsi(conn.lastText())).toContain("Plan stored:");
    const sessionId = entity.properties.coding_session_id as string;
    const events = db.listCodingEvents(sessionId, 10);
    const steering = events.find((event) => event.kind === "session_steered");
    expect(steering?.payload_json).toContain('"profile":"claude"');
    expect(steering?.payload_json).toContain('"artifactKind":"plan"');
    const artifacts = db.listCodingArtifacts(sessionId, 10);
    const plan = artifacts.find((artifact) => artifact.kind === "plan");
    expect(plan?.status).toBe("complete");
    expect(plan?.content_text).toBe("prefer review before apply");

    conn.clear();
    await engine.processCommand(conn.entity!, "code profile use codex");
    expect(entity.properties.code_profile).toBe("codex");
    expect(stripAnsi(conn.lastText())).toContain("Prompt: codex>");

    conn.clear();
    await engine.processCommand(conn.entity!, "inspect .");
    expect(stripAnsi(conn.lastText())).toContain("README.md");

    conn.clear();
    await engine.processCommand(conn.entity!, "view README.md");
    const read = stripAnsi(conn.lastText());
    expect(read).toContain("README.md");
    expect(read).toContain("Marina");
  });

  it("stores plan, summary, handoff, and decision as typed coding artifacts", async () => {
    await engine.processCommand(conn.entity!, "code start Artifact Notes");
    const entity = engine.entities.get(conn.entity!)!;
    const sessionId = entity.properties.coding_session_id as string;
    expect(entity.properties.code_context).toMatchObject({
      pendingPatches: 0,
      profile: "marina",
      sessionId,
      sessionStatus: "active",
    });

    for (const [command, kind] of [
      ["code plan inspect before editing", "plan"],
      ["code summary tests are green", "summary"],
      ["code handoff continue with profile compare", "handoff"],
      ["code decision keep aliases profile scoped", "decision"],
    ] as const) {
      conn.clear();
      await engine.processCommand(conn.entity!, command);
      expect(stripAnsi(conn.lastText())).toContain(`${capitalizeForTest(kind)} stored:`);
      expect(conn.messages.at(-1)?.data?.code).toMatchObject({
        artifactKind: kind,
        event: `${kind}_recorded`,
        type: "note",
      });
    }

    const artifacts = db.listCodingArtifacts(sessionId, 20);
    for (const kind of ["plan", "summary", "handoff", "decision"]) {
      const artifact = artifacts.find((candidate) => candidate.kind === kind);
      expect(artifact?.status).toBe("complete");
      expect(artifact?.metadata_json).toContain('"profile":"marina"');
    }

    const decision = artifacts.find((candidate) => candidate.kind === "decision");
    expect(decision).toBeTruthy();

    conn.clear();
    await engine.processCommand(conn.entity!, `code pin ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain(`Artifact pinned: ${decision!.id}`);
    let updatedDecision = db.getCodingArtifact(decision!.id);
    expect(updatedDecision?.status).toBe("complete");
    expect(updatedDecision?.metadata_json).toContain('"lifecycle":"pinned"');
    expect(conn.messages.at(-1)?.data?.code).toMatchObject({
      artifactId: decision!.id,
      event: "artifact_pinned",
      status: "complete",
    });

    conn.clear();
    await engine.processCommand(conn.entity!, `code archive ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain(
      `Artifact ${decision!.id} is pinned; unpin it before archived.`,
    );
    updatedDecision = db.getCodingArtifact(decision!.id);
    expect(updatedDecision?.status).toBe("complete");
    expect(updatedDecision?.metadata_json).toContain('"lifecycle":"pinned"');

    conn.clear();
    await engine.processCommand(conn.entity!, `code supersede ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain(
      `Artifact ${decision!.id} is pinned; unpin it before superseded.`,
    );
    expect(db.getCodingArtifact(decision!.id)?.metadata_json).toContain('"lifecycle":"pinned"');

    conn.clear();
    await engine.processCommand(conn.entity!, `code unpin ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain(`Artifact unpinned: ${decision!.id}`);
    updatedDecision = db.getCodingArtifact(decision!.id);
    expect(updatedDecision?.status).toBe("complete");
    expect(updatedDecision?.metadata_json).not.toContain('"lifecycle":"pinned"');

    conn.clear();
    await engine.processCommand(conn.entity!, `code supersede ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain(`Artifact superseded: ${decision!.id}`);
    updatedDecision = db.getCodingArtifact(decision!.id);
    expect(updatedDecision?.status).toBe("complete");
    expect(updatedDecision?.metadata_json).toContain('"lifecycle":"superseded"');

    conn.clear();
    await engine.processCommand(conn.entity!, `code show ${decision!.id}`);
    expect(stripAnsi(conn.lastText())).toContain("lifecycle: superseded");
  });

  it("selects an explicit workspace root for new sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "marina-code-roots-"));
    const app = join(root, "app");
    const docs = join(root, "docs");
    try {
      mkdirSync(app);
      mkdirSync(docs);
      writeFileSync(join(app, "app.txt"), "app workspace\n");
      writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      writeFileSync(join(docs, "notes.txt"), "docs workspace\n");
      writeFileSync(join(docs, "package.json"), JSON.stringify({ scripts: { lint: "echo ok" } }));
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(app),
        workspaceRegistry: new WorkspaceRegistry({ defaultRoot: app, roots: [root] }),
      });
      const ctx = testRoomContext(sent);

      await command.handler(ctx, inputFor(entity, "code workspace"));
      expect(sent.at(-1) ?? "").toContain(app);

      await command.handler(ctx, inputFor(entity, "code workspace discover"));
      expect(sent.at(-1) ?? "").toContain("Discovered Code Workspaces");
      expect(sent.at(-1) ?? "").toContain("app");
      expect(sent.at(-1) ?? "").toContain("docs");

      await command.handler(ctx, inputFor(entity, "code workspace use docs"));
      expect(sent.at(-1) ?? "").toContain("Code workspace selected: docs");
      expect(entity.properties.code_workspace_root).toBe(docs);

      await command.handler(ctx, inputFor(entity, "code start Docs Session"));
      const sessionId = entity.properties.coding_session_id as string;
      expect(db.getCodingSession(sessionId)?.workspace_root).toBe(docs);

      await command.handler(ctx, inputFor(entity, "code read notes.txt"));
      expect(sent.at(-1) ?? "").toContain("docs workspace");

      await command.handler(ctx, inputFor(entity, "code doctor"));
      expect(sent.at(-1) ?? "").toContain("Code Doctor");
      expect(sent.at(-1) ?? "").toContain(docs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports workspace readiness with scripts, git state, and binaries", async () => {
    const root = makeTempGitWorkspace();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            build: "bun build src/index.ts",
            lint: "biome check .",
            test: "bun test",
            typecheck: "tsc --noEmit",
          },
        }),
      );
      writeFileSync(join(root, "bun.lock"), "");
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Doctor Session"));
      await command.handler(ctx, inputFor(entity, "code doctor"));

      const output = sent.at(-1) ?? "";
      expect(output).toContain("Code Doctor");
      expect(output).toContain(`Workspace: ${root}`);
      expect(output).toContain("Package manager: bun");
      expect(output).toContain("Package scripts: build, lint, test, typecheck");
      expect(output).toContain("Git:");
      expect(output).toContain("changed path");
      expect(output).toContain("Binaries: bun=");
      expect(output).toContain("git=");
      expect(output).toContain("rg=");
      expect(output).toContain(
        "Recommended verify: code run typecheck -> code run lint -> code run test -> code run build",
      );
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "doctor_ran",
        title: "Code Doctor",
        type: "readiness",
        workspace: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns when workspace onboarding uses the process cwd fallback", async () => {
    const previousRoot = process.env.MARINA_CODE_DEFAULT_ROOT;
    const previousRoots = process.env.MARINA_CODE_ROOTS;
    try {
      delete process.env.MARINA_CODE_DEFAULT_ROOT;
      delete process.env.MARINA_CODE_ROOTS;
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
      });
      const ctx = testRoomContext(sent);

      await command.handler(ctx, inputFor(entity, "code"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("process cwd fallback");

      await command.handler(ctx, inputFor(entity, "code onboard"));
      const output = stripAnsi(sent.at(-1) ?? "");
      expect(output).toContain("Code Doctor");
      expect(output).toContain("process cwd fallback; configure MARINA_CODE_ROOTS for production");
    } finally {
      if (previousRoot === undefined) delete process.env.MARINA_CODE_DEFAULT_ROOT;
      else process.env.MARINA_CODE_DEFAULT_ROOT = previousRoot;
      if (previousRoots === undefined) delete process.env.MARINA_CODE_ROOTS;
      else process.env.MARINA_CODE_ROOTS = previousRoots;
    }
  });

  it("runs the detected verification chain and stores artifacts", async () => {
    const root = makeTempGitWorkspace();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            lint: "true",
            test: "true",
            typecheck: "true",
          },
        }),
      );
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent);

      await command.handler(ctx, inputFor(entity, "code start Verify Session"));
      const sessionId = entity.properties.coding_session_id as string;
      await command.handler(ctx, inputFor(entity, "code verify"));

      const output = stripAnsi(sent.at(-1) ?? "");
      expect(output).toContain("Verification passed.");
      expect(output).toContain("$ bun run typecheck");
      expect(output).toContain("$ bun run lint");
      expect(output).toContain("$ bun run test");
      expect(output).toContain("verification artifact: verification_");

      const artifacts = db.listCodingArtifacts(sessionId, 20);
      expect(artifacts.filter((artifact) => artifact.kind === "command_output")).toHaveLength(3);
      const verification = artifacts.find((artifact) => artifact.kind === "verification");
      expect(verification?.status).toBe("complete");
      expect(verification?.content_text).toContain("$ bun run typecheck");
      const events = db.listCodingEvents(sessionId, 20);
      expect(events.some((event) => event.kind === "verification_ran")).toBe(true);

      await command.handler(ctx, inputFor(entity, "code profile use codex"));
      await command.handler(ctx, inputFor(entity, "code check"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("verification artifact: verification_");
      const codexArtifacts = db.listCodingArtifacts(sessionId, 50);
      expect(codexArtifacts.filter((artifact) => artifact.kind === "verification")).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes a code prompt through the direct Marina model surface and stores the response", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const sent: string[] = [];
    const prompts: string[] = [];
    const command = codeCommand({
      db,
      getEntity: () => entity,
      workspace: new LocalWorkspace(),
      answerPrompt: async (request) => {
        prompts.push(
          `${request.sessionId}:${request.profile}:${request.modelTarget ?? "default"}:${request.prompt}`,
        );
        return "Inspect, patch, and verify through Code Mode.";
      },
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Direct Strategy"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code model set anthropic/claude-sonnet-4"));
    await command.handler(ctx, inputFor(entity, "code ask how should we fix this?"));

    const response = sent.at(-1) ?? "";
    expect(response).toContain("Code response stored:");
    expect(response).toContain("Strategy: direct model");
    expect(response).toContain("Inspect, patch, and verify through Code Mode.");
    expect(prompts).toEqual([
      `${sessionId}:marina:anthropic/claude-sonnet-4:how should we fix this?`,
    ]);

    const session = db.getCodingSession(sessionId);
    expect(session?.mode).toBe("direct");
    const artifacts = db.listCodingArtifacts(sessionId, 10);
    const artifact = artifacts.find((candidate) => candidate.kind === "agent_response");
    expect(artifact?.status).toBe("complete");
    expect(artifact?.content_text).toContain("Inspect, patch, and verify");
    expect(artifact?.metadata_json).toContain('"modelTarget":"anthropic/claude-sonnet-4"');
    const events = db.listCodingEvents(sessionId, 20);
    expect(events.some((event) => event.kind === "code_prompt_started")).toBe(true);
    expect(events.some((event) => event.kind === "code_prompt_completed")).toBe(true);
  });

  it("assigns a coding session to a live Marina agent without spawning new agents", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const helperEntity = makeAgentEntity("agent_helper", "Helper");
    db.saveEntity(helperEntity);
    const sent: string[] = [];
    const attention: string[] = [];
    const helper = fakeAgent("Helper", attention, helperEntity.id);
    const command = codeCommand({
      agentRuntime: {
        get: (name) => (name === "Helper" ? helper : undefined),
      },
      db,
      getEntity: (id) => (id === helperEntity.id ? helperEntity : entity),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent);

    await command.handler(ctx, inputFor(entity, "code start Agent Strategy"));
    const sessionId = entity.properties.coding_session_id as string;
    await command.handler(ctx, inputFor(entity, "code assign Helper inspect failing tests"));

    const response = sent.at(-1) ?? "";
    expect(response).toContain("Coding session assigned: Helper");
    expect(response).toContain(
      "The agent will continue through Marina's normal attention/tool loop.",
    );
    expect(attention).toHaveLength(1);
    expect(attention[0]).toContain(`coding session ${sessionId}`);
    expect(attention[0]).toContain(`active Code Mode session has been bound to ${sessionId}`);
    expect(attention[0]).toContain("Request: inspect failing tests");
    expect(attention[0]).toContain("Use the marina_code tool when it is available.");
    expect(attention[0]).toContain("files/read/search/diff");
    expect(attention[0]).toContain("Use verify for the local check chain");
    expect(attention[0]).toContain("Host app launch is disabled");
    expect(helperEntity.properties.active_modal).toBe("code");
    expect(helperEntity.properties.coding_session_id).toBe(sessionId);
    expect(helperEntity.properties.code_profile).toBe("marina");

    const session = db.getCodingSession(sessionId);
    expect(session?.mode).toBe("agent");
    const artifacts = db.listCodingArtifacts(sessionId, 10);
    const artifact = artifacts.find((candidate) => candidate.kind === "agent_assignment");
    expect(artifact?.status).toBe("complete");
    expect(artifact?.metadata_json).toContain('"agent":"Helper"');
    expect(artifact?.metadata_json).toContain('"boundEntityId":"agent_helper"');
    const events = db.listCodingEvents(sessionId, 20);
    expect(events.some((event) => event.kind === "code_agent_assigned")).toBe(true);
    expect(events.some((event) => event.kind === "code_agent_bound")).toBe(true);
  });

  it("rejects paths outside the workspace", async () => {
    await engine.processCommand(conn.entity!, "code start");
    conn.clear();

    await engine.processCommand(conn.entity!, "code read ../README.md");
    expect(stripAnsi(conn.lastText())).toContain("Path escapes the workspace root");
  });

  it("proposes and applies a checked patch in a confined workspace", async () => {
    const root = makeTempGitWorkspace();
    try {
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Patch Session"));
      const sessionText = sent.at(-1) ?? "";
      expect(sessionText).toContain("Coding session started:");

      await command.handler(
        ctx,
        inputFor(
          entity,
          `code patch Update greeting
diff --git a/example.txt b/example.txt
--- a/example.txt
+++ b/example.txt
@@ -1 +1 @@
-hello
+hello marina
`,
        ),
      );
      const proposed = sent.at(-1) ?? "";
      expect(proposed).toContain("Patch proposed:");
      const patchId = proposed.match(/patch_[a-f0-9-]+/)?.[0];
      expect(patchId).toBeTruthy();
      expect(metadata.at(-1)?.code).toMatchObject({
        artifactId: patchId,
        event: "patch_proposed",
        type: "patch",
      });
      expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("hello\n");

      await command.handler(ctx, inputFor(entity, "code show last"));
      expect(sent.at(-1) ?? "").toContain(`(${patchId})`);

      await command.handler(ctx, inputFor(entity, "code show last patch"));
      expect(sent.at(-1) ?? "").toContain(`(${patchId})`);
      expect(metadata.at(-1)?.code).toMatchObject({
        artifactId: patchId,
        event: "artifact_shown",
        type: "patch",
      });

      for (const lifecycleCommand of ["pin", "archive", "supersede"] as const) {
        await command.handler(ctx, inputFor(entity, `code ${lifecycleCommand} ${patchId}`));
        expect(stripAnsi(sent.at(-1) ?? "")).toContain(
          "Pending patches must be applied or rejected before lifecycle status changes.",
        );
        expect(db.getCodingArtifact(patchId!)?.status).toBe("pending");
      }

      await command.handler(ctx, inputFor(entity, "code patches pending"));
      const pendingPatches = stripAnsi(sent.at(-1) ?? "");
      expect(pendingPatches).toContain("Patches: pending");
      expect(pendingPatches).toContain(patchId!);
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "patches_listed",
        status: "pending",
        type: "list",
      });

      await command.handler(ctx, inputFor(entity, "code apply last patch"));
      expect(sent.at(-1) ?? "").toContain("Patch applied:");
      expect(metadata.at(-1)?.code).toMatchObject({
        artifactId: patchId,
        event: "patch_applied",
        status: "applied",
        type: "patch",
      });
      expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("hello marina\n");

      const artifact = db.getCodingArtifact(patchId!);
      expect(artifact?.status).toBe("applied");
      expect(artifact?.applied_by).toBe(entity.name);

      await command.handler(ctx, inputFor(entity, "code patches applied"));
      const appliedPatches = stripAnsi(sent.at(-1) ?? "");
      expect(appliedPatches).toContain("Patches: applied");
      expect(appliedPatches).toContain(patchId!);
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "patches_listed",
        status: "applied",
        type: "list",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects patch paths outside the confined workspace", async () => {
    const root = makeTempGitWorkspace();
    try {
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Escape Session"));
      await command.handler(
        ctx,
        inputFor(
          entity,
          `code patch Escape
diff --git a/../outside.txt b/../outside.txt
--- a/../outside.txt
+++ b/../outside.txt
@@ -0,0 +1 @@
+no
`,
        ),
      );

      expect(sent.at(-1) ?? "").toContain("Patch path escapes the workspace root");
      expect(existsSync(join(root, "..", "outside.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs an allowed workspace command and stores command output", async () => {
    const root = makeTempGitWorkspace();
    const homeProof = join(tmpdir(), "marina-code-home", "marina-home-proof");
    try {
      rmSync(homeProof, { force: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            test: "node -e \"require('fs').writeFileSync(require('path').join(process.env.HOME, 'marina-home-proof'), 'ok')\"",
          },
        }),
      );
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Run Session"));
      await command.handler(ctx, inputFor(entity, "code run allowlist"));
      const allowlist = stripAnsi(sent.at(-1) ?? "");
      expect(allowlist).toContain("Code Run Allowlist");
      expect(allowlist).toContain("Allowed By Host Policy");
      expect(allowlist).toContain("bun run test detected");
      expect(allowlist).toContain("bun run typecheck not detected");
      expect(allowlist).toContain("git status --short");
      expect(allowlist).toContain("Detected package scripts: test");
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "run_allowlist_shown",
        type: "list",
      });

      await command.handler(ctx, inputFor(entity, "code run test"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("$ bun run test");
      expect(existsSync(join(root, "marina-home-proof"))).toBe(false);
      expect(existsSync(homeProof)).toBe(true);
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "command_ran",
        exitCode: 0,
        type: "command",
      });

      await command.handler(ctx, inputFor(entity, "code run git branch --show-current"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("$ git branch --show-current");

      await command.handler(ctx, inputFor(entity, "code run git status --short"));

      const output = sent.at(-1) ?? "";
      expect(output).toContain("$ git status --short");
      expect(output).toContain("example.txt");
      expect(output).toContain("[exit 0]");
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "command_ran",
        exitCode: 0,
        type: "command",
      });
      const artifactId = output.match(/command_output_[a-f0-9-]+/)?.[0];
      expect(artifactId).toBeTruthy();

      const artifact = db.getCodingArtifact(artifactId!);
      expect(artifact?.kind).toBe("command_output");
      expect(artifact?.status).toBe("complete");
      expect(artifact?.content_text).toContain("example.txt");

      await command.handler(ctx, inputFor(entity, `code show ${artifactId}`));
      expect(sent.at(-1) ?? "").toContain("Kind: command_output");

      await command.handler(ctx, inputFor(entity, "code show last"));
      expect(sent.at(-1) ?? "").toContain(`(${artifactId})`);

      await command.handler(ctx, inputFor(entity, "code artifacts kind command_output"));
      const artifacts = stripAnsi(sent.at(-1) ?? "");
      expect(artifacts).toContain("Artifacts: command_output");
      expect(artifacts).toContain(artifactId!);
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "artifacts_listed",
        type: "list",
      });
    } finally {
      rmSync(homeProof, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists failed command artifacts and shows the last failed artifact", async () => {
    const root = makeTempGitWorkspace();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            lint: "false",
          },
        }),
      );
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Failure Triage"));
      await command.handler(ctx, inputFor(entity, "code run lint"));
      const failedRun = stripAnsi(sent.at(-1) ?? "");
      expect(failedRun).toContain("$ bun run lint");
      expect(failedRun).toContain("[exit 1]");
      const failedId = failedRun.match(/command_output_[a-f0-9-]+/)?.[0];
      expect(failedId).toBeTruthy();

      await command.handler(ctx, inputFor(entity, "code artifacts failed"));
      const failedArtifacts = stripAnsi(sent.at(-1) ?? "");
      expect(failedArtifacts).toContain("Artifacts: failed");
      expect(failedArtifacts).toContain(failedId!);
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "artifacts_listed",
        title: "Artifacts: failed",
        type: "list",
      });

      await command.handler(ctx, inputFor(entity, "code show last failed"));
      const shown = stripAnsi(sent.at(-1) ?? "");
      expect(shown).toContain(`(${failedId})`);
      expect(shown).toContain("Status: failed");
      expect(metadata.at(-1)?.code).toMatchObject({
        artifactId: failedId,
        event: "artifact_shown",
        exitCode: 1,
      });

      await command.handler(ctx, inputFor(entity, "code artifacts status failed"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain(failedId!);

      await command.handler(ctx, inputFor(entity, "code artifacts recent"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("Artifacts: recent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables host app scripts and records manual observations", async () => {
    const root = makeTempGitWorkspace();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            dev: "bun -e \"Bun.write('should-not-exist.txt', 'ran')\"",
          },
        }),
      );
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start App Session"));
      const sessionId = entity.properties.coding_session_id as string;
      await command.handler(ctx, inputFor(entity, "code run app"));

      const runOutput = stripAnsi(sent.at(-1) ?? "");
      expect(runOutput).toContain("code run app is disabled in host local mode.");
      expect(runOutput).toContain("container/userland runner");
      expect(existsSync(join(root, "should-not-exist.txt"))).toBe(false);
      const denialId = runOutput.match(/app_run_denial_[a-f0-9-]+/)?.[0];
      expect(denialId).toBeTruthy();
      const denial = db.getCodingArtifact(denialId!);
      expect(denial?.kind).toBe("app_run_denial");
      expect(denial?.status).toBe("denied");
      expect(denial?.content_text).toContain("code run app is disabled in host local mode.");
      expect(denial?.metadata_json).toContain('"containerRequired":true');
      expect(denial?.metadata_json).toContain('"reason":"host-local-mode"');
      expect(metadata.at(-1)?.code).toMatchObject({
        artifactKind: "app_run_denial",
        event: "app_run_denied",
        status: "denied",
        type: "artifact",
      });

      await command.handler(
        ctx,
        inputFor(entity, "code observe app starts and prints the local URL"),
      );
      const observationOutput = stripAnsi(sent.at(-1) ?? "");
      expect(observationOutput).toContain("Observation stored: observation_");
      const observationId = observationOutput.match(/observation_[a-f0-9-]+/)?.[0];
      expect(observationId).toBeTruthy();
      const observation = db.getCodingArtifact(observationId!);
      expect(observation?.kind).toBe("observation");
      expect(observation?.content_text).toContain("app starts");

      const events = db.listCodingEvents(sessionId, 20);
      expect(events.some((event) => event.kind === "app_run_observed")).toBe(false);
      expect(events.some((event) => event.kind === "app_run_denied")).toBe(true);
      expect(events.some((event) => event.kind === "observation_recorded")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unallowed workspace commands", async () => {
    const root = makeTempGitWorkspace();
    try {
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent);

      await command.handler(ctx, inputFor(entity, "code start Reject Run Session"));
      await command.handler(ctx, inputFor(entity, "code run sh -c echo"));

      expect(sent.at(-1) ?? "").toContain("Command is not allowed");

      await command.handler(ctx, inputFor(entity, "code run /bin/git status"));
      expect(sent.at(-1) ?? "").toContain("Binary paths are not allowed");

      await command.handler(ctx, inputFor(entity, "code run git status ; echo nope"));
      expect(sent.at(-1) ?? "").toContain("Shell metacharacters are not allowed");

      await command.handler(ctx, inputFor(entity, "code run bun test ../escape.test.ts"));
      expect(sent.at(-1) ?? "").toContain("Run path escapes the workspace root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores recipes, uses them for verification, and records model/thread metadata", async () => {
    const root = makeTempGitWorkspace();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            lint: "true",
            test: "true",
            typecheck: "true",
          },
        }),
      );
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const metadata: Record<string, unknown>[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent, metadata);

      await command.handler(ctx, inputFor(entity, "code start Recipe Session"));
      const sessionId = entity.properties.coding_session_id as string;
      await command.handler(ctx, inputFor(entity, "code recipe save default typecheck then lint"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("Recipe saved: default");
      expect(db.listCodingArtifacts(sessionId, 10).some((a) => a.kind === "run_recipe")).toBe(true);

      await command.handler(ctx, inputFor(entity, "code recipe list"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("default: typecheck then lint");

      await command.handler(ctx, inputFor(entity, "code verify"));
      const verify = stripAnsi(sent.at(-1) ?? "");
      expect(verify).toContain("$ bun run typecheck");
      expect(verify).toContain("$ bun run lint");
      expect(verify).not.toContain("$ bun run test");

      await command.handler(ctx, inputFor(entity, "code model set anthropic/claude-sonnet-4"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain(
        "Code model target set: anthropic/claude-sonnet-4",
      );
      expect(entity.properties.code_context).toMatchObject({
        modelTarget: "anthropic/claude-sonnet-4",
      });

      await command.handler(ctx, inputFor(entity, "code thread"));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain("Code Thread:");
      expect(metadata.at(-1)?.code).toMatchObject({
        event: "code_thread_shown",
        type: "history",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates and reverts checkpoints", async () => {
    const root = makeTempGitWorkspace();
    try {
      const add = Bun.spawnSync(["git", "add", "example.txt"], { cwd: root });
      expect(add.exitCode).toBe(0);
      writeFileSync(join(root, "example.txt"), "hello checkpoint\n");
      const entity = engine.entities.get(conn.entity!)!;
      const sent: string[] = [];
      const command = codeCommand({
        db,
        getEntity: () => entity,
        workspace: new LocalWorkspace(root),
      });
      const ctx = testRoomContext(sent);

      await command.handler(ctx, inputFor(entity, "code start Checkpoint Session"));
      await command.handler(ctx, inputFor(entity, "code checkpoint before revert"));
      const output = stripAnsi(sent.at(-1) ?? "");
      expect(output).toContain("Checkpoint stored:");
      const checkpointId = output.match(/checkpoint_[a-f0-9-]+/)?.[0];
      expect(checkpointId).toBeTruthy();
      expect(db.getCodingArtifact(checkpointId!)?.content_text).toContain("hello checkpoint");

      await command.handler(ctx, inputFor(entity, `code revert ${checkpointId}`));
      expect(stripAnsi(sent.at(-1) ?? "")).toContain(`Checkpoint reverted: ${checkpointId}`);
      expect(readFileSync(join(root, "example.txt"), "utf8")).toBe("hello\n");
      expect(
        db
          .listCodingEvents(entity.properties.coding_session_id as string, 20)
          .some((event) => event.kind === "checkpoint_reverted"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores approvals, code skills, crew plans, spawn requests, and external links", async () => {
    const entity = engine.entities.get(conn.entity!)!;
    const spawnedEntity = makeAgentEntity("agent_spawned_reviewer", "SpawnedReviewer");
    db.saveEntity(spawnedEntity);
    const sent: string[] = [];
    const metadata: Record<string, unknown>[] = [];
    const attention: string[] = [];
    const spawned = fakeAgent("code-reviewer-test", attention, spawnedEntity.id);
    const spawnedConfigs: Record<string, unknown>[] = [];
    const command = codeCommand({
      agentRuntime: {
        get: (name) => (name === spawned.name ? spawned : undefined),
        isAvailable: () => true,
        list: () => [],
        spawn: async (config) => {
          spawnedConfigs.push(config);
          return spawned;
        },
      },
      db,
      getEntity: (id) => (id === spawnedEntity.id ? spawnedEntity : entity),
      workspace: new LocalWorkspace(),
    });
    const ctx = testRoomContext(sent, metadata);

    await command.handler(ctx, inputFor(entity, "code start Collaboration Session"));
    const sessionId = entity.properties.coding_session_id as string;

    await command.handler(ctx, inputFor(entity, "code roles"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("planner");

    await command.handler(ctx, inputFor(entity, "code crew implement the profile migration"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Coding crew plan stored:");

    await command.handler(ctx, inputFor(entity, "code spawn reviewer inspect the diff"));
    const spawnRequest = stripAnsi(sent.at(-1) ?? "");
    expect(spawnRequest).toContain("Coding spawn request stored:");
    const spawnId = spawnRequest.match(/spawn_request_[a-f0-9-]+/)?.[0];
    expect(spawnId).toBeTruthy();
    expect(db.getCodingArtifact(spawnId!)?.status).toBe("pending");

    await command.handler(ctx, inputFor(entity, `code approve ${spawnId}`));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain(`Approval approved: ${spawnId}`);
    expect(db.getCodingArtifact(spawnId!)?.status).toBe("approved");

    await command.handler(
      ctx,
      inputFor(entity, `code spawn run ${spawnId} name code-reviewer-test model local/tester`),
    );
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Coding agent launched: code-reviewer-test");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]).toMatchObject({
      model: "local/tester",
      name: "code-reviewer-test",
      role: "reviewer",
      spawnedBy: "Alice",
    });
    expect(attention.at(-1)).toContain(`coding session ${sessionId}`);
    expect(attention.at(-1)).toContain("Goal: inspect the diff");
    expect(spawnedEntity.properties.active_modal).toBe("code");
    expect(spawnedEntity.properties.coding_session_id).toBe(sessionId);
    expect(db.getCodingArtifact(spawnId!)?.status).toBe("launched");

    await command.handler(ctx, inputFor(entity, "code approval request shell run extended tests"));
    const approvalOutput = stripAnsi(sent.at(-1) ?? "");
    expect(approvalOutput).toContain("Approval requested:");
    const approvalId = approvalOutput.match(/approval_[a-f0-9-]+/)?.[0];
    expect(approvalId).toBeTruthy();

    await command.handler(ctx, inputFor(entity, `code approve ${approvalId}`));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain(`Approval approved: ${approvalId}`);
    expect(db.getCodingArtifact(approvalId!)?.status).toBe("approved");

    await command.handler(
      ctx,
      inputFor(entity, "code skill add review prefer small focused diffs"),
    );
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Code skill stored: review");

    await command.handler(ctx, inputFor(entity, "code skill use review"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("Code skill active for next work: review");

    await command.handler(ctx, inputFor(entity, "code external link acp zed-session-1"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain(
      "External coding link stored: acp zed-session-1",
    );

    await command.handler(ctx, inputFor(entity, "code external"));
    expect(stripAnsi(sent.at(-1) ?? "")).toContain("zed-session-1");
    expect(metadata.at(-1)?.code).toMatchObject({
      event: "external_sessions_listed",
      type: "list",
    });

    const kinds = db.listCodingArtifacts(sessionId, 50).map((artifact) => artifact.kind);
    expect(kinds).toContain("crew_plan");
    expect(kinds).toContain("spawn_request");
    expect(kinds).toContain("spawn_assignment");
    expect(kinds).toContain("approval");
    expect(kinds).toContain("code_skill");
    expect(kinds).toContain("external_link");
  });
});

function makeTempGitWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "marina-code-test-"));
  writeFileSync(join(root, "example.txt"), "hello\n");
  const proc = Bun.spawnSync(["git", "init"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr));
  }
  return root;
}

function capitalizeForTest(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function makeAgentEntity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: "coding helper",
    inventory: [],
    properties: {},
  };
}

function fakeAgent(
  name: string,
  attention: string[],
  entityId: EntityId | null = null,
): AgentHandle {
  return {
    name,
    getStatus: () =>
      ({
        contextWindow: 128_000,
        effectiveContextWindow: 128_000,
        entityId,
        errorReason: null,
        errors: 0,
        focus: null,
        goal: null,
        lastActivity: Date.now(),
        maxOutputTokens: 4096,
        model: "marina",
        name,
        peakInputTokens: 0,
        role: "coder",
        state: "autonomous",
        supports: { text: true },
        toolCalls: 0,
        uptime: 0,
      }) satisfies AgentStatus,
    reconfigure: async () => {},
    sendAttention: async (message: string) => {
      attention.push(message);
    },
    setFocus: () => {},
    setSystemPrompt: () => {},
    stop: async () => {},
    subscribe: () => () => {},
  };
}

function inputFor(entity: Entity, raw: string): CommandInput {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const verb = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return {
    raw: trimmed,
    verb,
    args,
    tokens: args ? args.split(/\s+/) : [],
    entity: entity.id,
    room: roomId("test/start"),
  };
}

function testRoomContext(sent: string[], metadata: Record<string, unknown>[] = []): RoomContext {
  return {
    send: (
      _target: EntityId,
      message: string,
      _tag?: string,
      messageMetadata?: Record<string, unknown>,
    ) => {
      sent.push(stripAnsi(message));
      if (messageMetadata) metadata.push(messageMetadata);
    },
  } as unknown as RoomContext;
}
