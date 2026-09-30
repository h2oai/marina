// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openConnectedCodeSession } from "../scripts/code-connected";
import { CodeConsole } from "../scripts/code-console";
import { HarnessStore } from "../scripts/code-harness";
import { parseDispatch } from "../scripts/marina";
import {
  cachedParticipantToken,
  participantUrl,
  saveParticipantToken,
} from "../scripts/session-cache";
import type { AgentEvent, AgentHandle } from "../src/agent/agent-types";
import {
  beginCodingRun,
  codingRunMetadata,
  endCodingRun,
  heartbeatCodingRun,
  recoverCodingRuns,
} from "../src/coding/task-run";
import { grant } from "../src/engine/safety-gates";
import { WebSocketServer } from "../src/net/websocket-server";
import type { MarinaAgent, Perception } from "../src/sdk/client";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

it("selects connected coding explicitly and rejects options with ambiguous ownership", () => {
  const args = ["--url", "ws://localhost:3300", "--name", "Owner", "--session", "project"];
  expect(parseDispatch(args)).toEqual({
    kind: "code-connected",
    url: args[1]!,
    name: "Owner",
    session: "project",
  });
  for (const extra of [
    ["."],
    ["--fresh"],
    ["-p", "work"],
    ["--agent", "codex"],
    ["--allow-exec"],
    ["--model", "a/model"],
  ])
    expect(parseDispatch([...args, ...extra]).kind).toBe("usage-error");
  expect(parseDispatch(["--session", "project"]).kind).toBe("usage-error");
  expect(parseDispatch([]).kind).toBe("code");
  expect(parseDispatch(["connect", "Owner"]).kind).toBe("connect");
});

it("validates participant URLs before any credential is read or sent", () => {
  expect(participantUrl("http://localhost:3300/ws")).toBe("ws://localhost:3300");
  expect(participantUrl("https://example.test/")).toBe("wss://example.test");
  for (const url of [
    "file:///tmp",
    "https://user:secret@example.test",
    "ws://host?token=secret",
    "https://host/path",
    "ws://host#token",
  ])
    expect(() => participantUrl(url)).toThrow("root URL");
});

describe("connected coding in an existing world", () => {
  let world: ReturnType<typeof createTestEngine>;
  let owner: ReturnType<typeof world.login>;
  let peer: ReturnType<typeof world.login>;
  let server: WebSocketServer;
  let state: DisposableStack;
  let cacheDirectory: string;
  let url: string;
  let token: string;
  const clients: MarinaAgent[] = [];
  beforeEach(() => {
    world = createTestEngine({ storage: "disk" });
    const root = dirname(world.path);
    state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_CODE_ROOTS: root,
        MARINA_CODE_DEFAULT_ROOT: root,
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
      },
    });
    owner = world.login("Owner");
    peer = world.login("Independent");
    grant(world.db, owner.entityId, "code.exec");
    for (const [id, name] of [
      ["project", "Owner"],
      ["private", "Independent"],
    ])
      world.db.createCodingSession({ id: id!, title: id!, workspaceRoot: root, createdBy: name! });
    const actor = world.engine.entities.get(owner.entityId)!;
    actor.properties.code_profile = "pi";
    actor.properties.coding_session_id = "project";
    token = world.engine.sessionManager!.create(owner.entityId, "Owner", 0).token;
    world.engine.removeConnection(owner.connection.id);
    server = new WebSocketServer(world.engine, 0);
    server.start();
    url = `ws://127.0.0.1:${server.getPort()}`;
    cacheDirectory = join(root, "credentials");
    saveParticipantToken("Owner", url, token, cacheDirectory);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await server.stop();
    await world.dispose();
    state.dispose();
  });
  function options(session = "project") {
    return { url, name: "Owner", session, cacheDirectory };
  }
  async function open(observe?: (p: Perception) => void) {
    const connected = await openConnectedCodeSession(options(), observe);
    clients.push(connected.agent);
    return connected;
  }
  function consoleFor(connected: Awaited<ReturnType<typeof open>>, finish = (_code: number) => {}) {
    const consoleView = new CodeConsole({
      agent: connected.agent,
      url: url.replace("ws:", "http:"),
      root: connected.workspace,
      directory: dirname(world.path),
      store: new HarnessStore(dirname(world.path)),
      sessionId: "project",
      connected: true,
      harness: connected.harness,
      finish,
    });
    consoleView.write = () => {};
    return consoleView;
  }

  it("rotates the exact account's credential, retains entity identity and server session settings", async () => {
    const connected = await open();
    expect(connected.workspace).toBe(dirname(world.path));
    expect(connected.harness).toEqual({ version: 1, agent: "marina", profile: "pi" });
    expect(connected.agent.getSession()?.entityId).toBe(owner.entityId);
    expect(world.engine.authenticate(token)).toBeNull();
    const cached = cachedParticipantToken("Owner", url, cacheDirectory)!;
    expect(cached).toBe(connected.agent.getSession()!.token);
    expect(world.engine.authenticate(cached)).toBe(owner.entityId);
    expect(statSync(join(cacheDirectory, "Owner.json")).mode & 0o777).toBe(0o600);
    expect(cachedParticipantToken("Owner", "wss://other.test", cacheDirectory)).toBeUndefined();
    const view = consoleFor(connected);
    await view.start(false);
    expect(world.engine.entities.get(owner.entityId)?.properties.code_profile).toBe("pi");
    expect(world.db.listCodingArtifacts("project").some((a) => a.kind === "model_setting")).toBe(
      false,
    );
    await view.close(0);
  });

  it("follows a confirmed local session selection without adopting late ambient session events", async () => {
    const connected = await open();
    const view = consoleFor(connected);
    const seen: Perception[] = [];
    connected.agent.onPerception((p) => {
      seen.push(p);
      view.observe(p);
    });
    world.db.createCodingSession({
      id: "another-project",
      title: "another",
      workspaceRoot: dirname(world.path),
      createdBy: "Owner",
    });
    try {
      await view.submit("/world code resume another-project");
      view.observe({
        kind: "message",
        timestamp: 0,
        data: {
          code: {
            event: "session_resumed",
            sessionId: "project",
            workspace: dirname(world.path),
          },
        },
      });
      seen.length = 0;
      await view.submit("/status");
      expect(
        seen.some((p) => {
          const code = p.data.code as { event?: string; sessionId?: string } | undefined;
          return code?.event === "session_status" && code.sessionId === "another-project";
        }),
      ).toBe(true);
      expect(
        seen.some(
          (p) => (p.data.code as { sessionId?: string } | undefined)?.sessionId === "project",
        ),
      ).toBe(false);
    } finally {
      await view.close(0);
    }
  });

  it("runs the terminal process and exits on EOF without stopping its server", async () => {
    const entry = join(import.meta.dir, "../scripts/code-connected.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { runConnectedCodeSession } from ${JSON.stringify(entry)}; process.exitCode = await runConnectedCodeSession(${JSON.stringify(options())});`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    let output = "";
    // The preflight transcript uses stdout; readline renders the terminal on stderr.
    const reading = Promise.all(
      [child.stdout, child.stderr].map((stream) => {
        const decoder = new TextDecoder();
        return stream.pipeTo(
          new WritableStream({
            write(chunk) {
              output += decoder.decode(chunk, { stream: true });
            },
          }),
        );
      }),
    );
    try {
      await until(
        () => output.includes("Connected to an existing world.") || child.exitCode !== null,
        { timeoutMs: 3000 },
      );
      expect(output).toContain("Connected to an existing world.");
      child.stdin.write("/world tell Independent terminal process is here\n");
      await until(() =>
        peer.connection.allText().some((text) => text.includes("terminal process is here")),
      );
      child.stdin.end();
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(0);
      await reading;
      expect(output).toContain("Server workspace");
      expect(output).not.toContain("outcomes may be unknown");
      expect(world.engine.getConnectionForEntity(peer.entityId)).toBe(peer.connection);
      expect(world.db.getCodingSession("project")?.status).toBe("active");
    } catch (error) {
      throw new Error(`Terminal output: ${output}`, { cause: error });
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await reading;
    }
  }, 10000);

  it("edits real server files, runs a passing check and exchanges messages without stopping the world", async () => {
    const root = dirname(world.path);
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "bun check.ts" } }),
    );
    await Bun.write(
      join(root, "check.ts"),
      'const value = (await import("./answer.ts")).answer; if (value !== 42) throw new Error("wrong answer"); console.log("checked 42");',
    );
    await Bun.write(join(root, "answer.ts"), "export const answer = 0;");
    const seen: Perception[] = [];
    const connected = await open((p) => seen.push(p));
    const view = consoleFor(connected, () => connected.agent.disconnect());
    await view.start(false);
    // Ordinary Code Mode syntax over the real correlated command transport.
    await view.submit("write answer.ts\nexport const answer = 42;");
    expect(readFileSync(join(root, "answer.ts"), "utf8")).toContain("42");
    await view.submit("verify start");
    await view.submit("/world tell Independent checks are running");
    expect(peer.connection.allText().join("\n")).toContain("checks are running");
    await world.engine.processCommand(peer.entityId, "tell Owner still working independently");
    await until(() =>
      seen.some((p) => String(p.data.text).includes("still working independently")),
    );
    await world.engine.drainCommands();
    const verification = world.db
      .listCodingArtifacts("project")
      .find((a) => a.kind === "verification");
    expect(verification?.status).toBe("complete");
    expect(
      world.db.listCodingArtifacts("project").find((a) => a.kind === "command_output")
        ?.content_text,
    ).toContain("checked 42");
    const retainedToken = cachedParticipantToken("Owner", url, cacheDirectory)!;
    await view.close(0);
    await until(() => !world.engine.getConnectionForEntity(owner.entityId));
    expect(world.engine.entities.get(peer.entityId)).toBeDefined();
    expect(world.engine.getConnectionForEntity(peer.entityId)).toBe(peer.connection);
    expect(world.db.getCodingSession("project")?.status).toBe("active");
    expect(world.engine.authenticate(retainedToken)).toBe(owner.entityId);
    expect((await fetch(`${url.replace("ws:", "http:")}/health`)).ok).toBe(true);
    const resumed = await open();
    expect(resumed.agent.getSession()?.entityId).toBe(owner.entityId);
  });

  it("dispatches natural language, reattaches worker output and preserves the live task through disconnect", async () => {
    const worker = world.login("Coder");
    grant(world.db, worker.entityId, "code.exec");
    world.db.updateCodingSession("project", { agent: "Coder" });
    const attention: string[] = [];
    const listeners = new Set<(event: AgentEvent) => void>();
    // Deterministic provider boundary; all admission, commands, files and checks below are real.
    const handle = {
      name: "Coder",
      getStatus: () => ({ entityId: worker.entityId, role: "coder", state: "idle" }),
      sendAttention: async (text: string) => {
        attention.push(text);
      },
      setActiveCodingTask: () => {},
      reconfigure: async () => {},
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as AgentHandle;
    const originalGet = world.engine.agentRuntime.get.bind(world.engine.agentRuntime);
    const get = spyOn(world.engine.agentRuntime, "get").mockImplementation((name) =>
      name === "Coder" ? handle : originalGet(name),
    );
    try {
      const root = dirname(world.path);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "bun answer.ts" } }),
      );
      writeFileSync(join(root, "answer.ts"), 'throw new Error("broken");');
      const first = await open();
      const firstView = consoleFor(first, () => first.agent.disconnect());
      first.agent.onPerception((p) => firstView.observe(p));
      await firstView.start(false);
      await firstView.submit("Repair answer.ts and verify it");
      expect(attention).toHaveLength(1);
      expect(attention[0]).toContain("Repair answer.ts and verify it");
      const run = world.db.listCodingRuns({ sessionId: "project", status: "active" })[0]!;
      expect(run).toBeDefined();
      expect(codingRunMetadata(run).workerKey).not.toBe(worker.entityId);
      expect(codingRunMetadata(run).claimantId).toBe(worker.entityId);
      expect(firstView.busy()).toBe(true);
      await firstView.close(0);
      await until(() => !world.engine.getConnectionForEntity(owner.entityId));
      // Only the task observer remains. Closing a view does not clear the canonical claim.
      expect(listeners.size).toBe(1);
      expect(world.db.getCodingArtifact(run.id)?.status).toBe("active");
      expect(world.engine.entities.get(worker.entityId)?.properties.coding_task).toBeDefined();

      const messages: Perception[] = [];
      const second = await open((p) => messages.push(p));
      const secondView = consoleFor(second, () => second.agent.disconnect());
      second.agent.onPerception((p) => secondView.observe(p));
      await secondView.start(false);
      await second.agent.command("code status", { codingTarget: { sessionId: "project" } });
      expect(secondView.busy()).toBe(true);
      secondView.completed("another-session");
      expect(secondView.busy()).toBe(true);
      expect(attention).toHaveLength(1);
      expect(listeners.size).toBe(2);
      for (const listener of listeners)
        listener({ type: "text_delta", delta: "I have the repair." });
      for (const listener of listeners) listener({ type: "turn_end" } as AgentEvent);
      await until(() => messages.some((p) => String(p.data.text).includes("I have the repair.")));
      await secondView.submit("/world tell Independent the repair continues");
      expect(peer.connection.allText().join("\n")).toContain("the repair continues");
      await world.engine.processCommand(worker.entityId, "code write answer.ts\nconsole.log(42);");
      await world.engine.processCommand(worker.entityId, "code verify");
      await world.engine.processCommand(
        worker.entityId,
        "code summary Repaired answer.ts; checks passed.",
      );
      const submitted = world.db.getCodingArtifact(run.id)!;
      expect(submitted.status).toBe("submitted");
      expect(codingRunMetadata(submitted).verification).toBe("unbound");
      expect(world.db.getTask(codingRunMetadata(run).taskId)?.status).toBe("claimed");
      await secondView.submit(`review approve ${run.id}`);
      expect(world.db.getTask(codingRunMetadata(run).taskId)?.status).toBe("completed");
      expect(readFileSync(join(root, "answer.ts"), "utf8")).toContain("console.log(42)");
      await secondView.close(0);
      await until(() => !world.engine.getConnectionForEntity(owner.entityId));
      expect(listeners.size).toBe(0);
    } finally {
      get.mockRestore();
    }
  });

  it.each([false, true])(
    "heartbeats and releases account-backed claims, including older attempts (legacy=%s)",
    (legacy) => {
      const worker = world.login("Coder");
      const begin = () =>
        beginCodingRun(world.db, {
          session: world.db.getCodingSession("project")!,
          owner: world.engine.entities.get(owner.entityId)!,
          worker: world.engine.entities.get(worker.entityId)!,
          prompt: "Repair the application",
          profile: "marina",
        });
      let run = begin();
      if (legacy) {
        const metadata = codingRunMetadata(run);
        delete metadata.claimantId;
        world.db.updateCodingArtifact(run.id, { metadata });
        run = world.db.getCodingArtifact(run.id)!;
      }
      expect(heartbeatCodingRun(world.db, run)).toBe(true);
      endCodingRun(world.db, run.id, "cancelled", "explicit stop");
      expect(world.db.getTaskClaim(codingRunMetadata(run).taskId, worker.entityId)?.status).toBe(
        "released",
      );
      run = begin();
      recoverCodingRuns(world.db);
      expect(world.db.getCodingArtifact(run.id)?.status).toBe("interrupted");
      expect(world.db.getTaskClaim(codingRunMetadata(run).taskId, worker.entityId)?.status).toBe(
        "released",
      );
    },
  );

  it("refuses a second controller without evicting the first or rotating its token", async () => {
    const connected = await open();
    const current = connected.agent.getSession()!.token;
    await expect(openConnectedCodeSession(options())).rejects.toThrow("already in use");
    expect(world.engine.authenticate(current)).toBe(owner.entityId);
    expect(connected.agent.isConnected()).toBe(true);
    await connected.agent.command("/say first view still works");
    expect(peer.connection.allText().join("\n")).toContain("first view still works");
  });

  it("refuses foreign sessions, preserves the rotated credential and never falls back to name login", async () => {
    await expect(openConnectedCodeSession(options("private"))).rejects.toThrow("not authorized");
    const refreshed = cachedParticipantToken("Owner", url, cacheDirectory)!;
    expect(refreshed).not.toBe(token);
    expect(world.engine.authenticate(refreshed)).toBe(owner.entityId);
    expect(world.engine.entities.get(owner.entityId)?.properties.coding_session_id).toBe("project");
    await expect(openConnectedCodeSession({ ...options(), token: "revoked" })).rejects.toThrow(
      "Invalid or expired",
    );
    expect(world.engine.authenticate(refreshed)).toBe(owner.entityId);
    expect(world.db.getCodingSession("private")?.agent).toBeNull();
  });

  it("rejects a closed session and does not choose or create a substitute", async () => {
    world.db.updateCodingSession("project", { status: "complete" });
    await expect(openConnectedCodeSession(options())).rejects.toThrow("active session");
    expect(world.db.listCodingSessions()).toHaveLength(2);
    expect(world.db.getCodingSession("project")?.status).toBe("complete");
  });

  it("requires server-bound credentials and refuses a mismatched account before coding commands", async () => {
    writeFileSync(join(cacheDirectory, "Owner.json"), JSON.stringify({ token }));
    await expect(openConnectedCodeSession(options())).rejects.toThrow("Authenticate");
    await expect(
      openConnectedCodeSession({ ...options(), name: "Another", token }),
    ).rejects.toThrow("credential belongs to Owner");
    expect(world.db.listCodingEvents("project").some((e) => e.kind === "session_resumed")).toBe(
      false,
    );
    expect(cachedParticipantToken("Owner", url, cacheDirectory)).not.toBe(token);
  });

  it("does not start native local runtimes or rewrite the profile when a connected user requests one", async () => {
    const connected = await open();
    const view = consoleFor(connected);
    const messages: string[] = [];
    view.write = (message) => messages.push(message);
    await view.start(false);
    await view.submit("/use codex");
    await view.submit("/spawn claude helper");
    expect(messages.some((m) => m.includes("server-side coding agent"))).toBe(true);
    expect(world.engine.entities.get(owner.entityId)?.properties.code_profile).toBe("pi");
    await view.close(0);
  });
});
