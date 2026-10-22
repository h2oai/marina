// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standingOf } from "../src/agent/standing";
import {
  assembleSnapshot,
  captureReviewSnapshot,
  isReviewRequestCommand,
  snapshotEvents,
  withSnapshotModifier,
} from "../src/routing/review-snapshot";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { git, gitInit } from "./git-helpers";
import { MockConnection, stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const REVIEW_TYPES = new Set(["review_requested", "review_verdict", "review_closed"]);

describe("code review request / verdict", () => {
  let world: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let root: string;
  let ids: Record<string, ReturnType<typeof world.login>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-review-"));
    gitInit(root);
    writeFileSync(join(root, "auth.ts"), "export const refresh = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    writeFileSync(join(root, "auth.ts"), "export const refresh = 2; // SECRET-CLAIM-TEXT\n");
    world = createTestEngine({ storage: "disk" });
    state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_CODE_ROOTS: root,
        MARINA_CODE_DEFAULT_ROOT: root,
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
      },
    });
    // One person owns three supervised agents: two of one vendor, one of another.
    const agents: [string, string][] = [
      ["Wren", "claude"],
      ["Sage", "claude"],
      ["Fern", "codex"],
    ];
    for (const [name, vendor] of agents)
      world.db.saveAgentConfig({
        name,
        model: "frontier",
        spawnedBy: "Owner",
        runtime: "supervised",
        vendor,
      });
    ids = {};
    for (const name of ["Owner", "Wren", "Sage", "Fern", "Stranger"]) ids[name] = world.login(name);
    world.db.createCodingSession({
      id: "code_wren",
      title: "wren",
      workspaceRoot: root,
      createdBy: "Wren",
    });
    world.engine.entities.get(ids.Wren!.entityId)!.properties.coding_session_id = "code_wren";
  });

  afterEach(async () => {
    await world.dispose();
    state.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  async function run(name: string, command: string): Promise<string> {
    const connection = ids[name]!.connection;
    const before = connection.messages.length;
    await world.engine.processCommand(ids[name]!.entityId as EntityId, command);
    return connection.messages
      .slice(before)
      .map((m) => stripAnsi(String(m.data?.text ?? "")))
      .join("\n");
  }

  function reviewId(text: string): string {
    const id = /review_[a-z0-9]{12}/.exec(text)?.[0];
    expect(id).toBeDefined();
    return id!;
  }

  function reviewEvents(): EngineEvent[] {
    return world.engine.eventLog.filter((event) => REVIEW_TYPES.has(event.type));
  }

  it("auto picks an online reviewer of a different vendor and delivers an owed tell", async () => {
    const out = await run("Wren", "code review request auto -- fixed the refresh race");
    const id = reviewId(out);
    expect(out).toContain("Fern");
    expect(out).toContain("different vendor (codex; author claude)");
    const fern = ids.Fern!.connection.messages.map((m) => stripAnsi(String(m.data?.text ?? "")));
    expect(fern.some((line) => line.includes(`code review verdict ${id}`))).toBe(true);
    const tell = world.engine.eventLog.find((e) => e.type === "tell_sent");
    expect(tell).toMatchObject({ from: "Wren", to: "Fern" });
    const shown = await run("Fern", `code review ${id}`);
    expect(shown).toContain("refresh = 2");
    expect(shown).toContain("claims: fixed the refresh race");
  });

  it("falls back to the same vendor with an honest label when no other vendor is online", async () => {
    world.engine.removeConnection(ids.Fern!.connection.id);
    const out = await run("Wren", "code review request auto");
    expect(out).toContain("Sage");
    expect(out).toContain("auto: same vendor and model (claude)");
  });

  it("the author can neither give a verdict nor close its review", async () => {
    const id = reviewId(await run("Wren", "code review request Fern"));
    expect(await run("Wren", `code review verdict ${id} approve`)).toContain(
      "The author cannot give its own verdict",
    );
    expect(await run("Wren", `code review approve ${id}`)).toContain(
      "The author cannot close its own review",
    );
    expect(await run("Sage", `code review verdict ${id} approve`)).toContain(
      "Only the reviewer (Fern)",
    );
    // Another agent (even a sibling) cannot close: a person closes.
    expect(await run("Fern", `code review approve ${id}`)).toContain("A person closes a review");
    expect(await run("Stranger", `code review approve ${id}`)).toContain(
      "A person closes a review",
    );
    expect(world.db.getCodingArtifact(id)!.status).toBe("open");
  });

  it("rework reopens the work and the author requests the next round", async () => {
    const id = reviewId(await run("Wren", "code review request Fern"));
    expect(await run("Fern", `code review verdict ${id} rework`)).toContain(
      "Rework needs findings",
    );
    expect(
      await run("Fern", `code review verdict ${id} rework -- the lock is never released`),
    ).toContain("rework");
    const wren = ids.Wren!.connection.messages.map((m) => stripAnsi(String(m.data?.text ?? "")));
    expect(wren.some((line) => line.includes("the lock is never released"))).toBe(true);
    expect(await run("Fern", `code review verdict ${id} approve`)).toContain("is rework");
    const next = await run("Wren", `code review request ${id} -- released the lock`);
    expect(next).toContain("round 2");
    expect(world.db.getCodingArtifact(id)!.status).toBe("open");
    expect(await run("Fern", `code review verdict ${id} approve`)).toContain("approved");
  });

  it("a person's merge against the reviewer's verdict is recorded as an override", async () => {
    const id = reviewId(await run("Wren", "code review request Fern"));
    await run("Fern", `code review verdict ${id} rework -- missing test`);
    const closed = await run("Owner", `code review approve ${id}`);
    expect(closed).toContain("merged");
    expect(closed).toContain("override of the reviewer's rework verdict (recorded)");
    const meta = JSON.parse(world.db.getCodingArtifact(id)!.metadata_json);
    expect(meta.closed).toMatchObject({
      by: "Owner",
      outcome: "merged",
      override: true,
      priorVerdict: "rework",
    });
    expect(reviewEvents().at(-1)).toMatchObject({ type: "review_closed", override: true });
    expect(await run("Owner", `code review reject ${id}`)).toContain("already merged");
  });

  it("an approval credits standing only when passing checks ground it", async () => {
    const id = reviewId(await run("Wren", "code review request Fern"));
    expect(await run("Fern", `code review verdict ${id} approve`)).toContain(
      "standing: none (no passing checks",
    );
    expect(standingOf(world.db, "Wren")).toBe(0);

    world.db.createCodingArtifact({
      id: "run_passed",
      sessionId: "code_wren",
      kind: "task_run",
      title: "attempt",
      status: "submitted",
      contentText: "",
      metadata: { workerName: "Wren", verification: "passed", taskId: 1 },
      createdBy: "Wren",
    });
    const grounded = reviewId(await run("Wren", "code review request Fern"));
    expect(await run("Fern", `code review verdict ${grounded} approve`)).toContain(
      "standing: Wren +",
    );
    expect(standingOf(world.db, "Wren")).toBeGreaterThan(0);
  });

  it("broadcast events carry names, ids and outcomes only", async () => {
    const id = reviewId(await run("Wren", "code review request auto -- SECRET-CLAIM-TEXT"));
    await run("Fern", `code review verdict ${id} rework -- SECRET-FINDINGS-TEXT`);
    await run("Wren", `code review request ${id}`);
    await run("Fern", `code review verdict ${id} approve`);
    await run("Owner", `code review approve ${id}`);
    const events = reviewEvents();
    expect(events.map((e) => e.type)).toEqual([
      "review_requested",
      "review_verdict",
      "review_requested",
      "review_verdict",
      "review_closed",
    ]);
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("refresh");
    expect(events.at(-1)).toMatchObject({ outcome: "merged", override: false });
  });

  it("a stranger cannot read a review", async () => {
    const id = reviewId(await run("Wren", "code review request Fern"));
    expect(await run("Stranger", `code review ${id}`)).toContain(`No review ${id}`);
    expect(await run("Owner", `code review ${id}`)).toContain("refresh = 2");
  });

  it("refuses with nothing to snapshot", async () => {
    expect(await run("Sage", "code review request Fern")).toContain("Nothing to snapshot");
    git(root, "checkout", "--", "auth.ts");
    expect(await run("Wren", "code review request Fern")).toContain("Nothing to review");
  });

  it("refuses a snapshot from an account that is not a supervised run", async () => {
    expect(await run("Owner", "code review request Fern snapshot:review-snapshot-x")).toContain(
      "not a supervised resident",
    );
  });
  it("reads a supervisor snapshot only from the caller's own run session", async () => {
    const key = world.db.durableEntityKey(ids.Owner!.entityId);
    const own = world.db.joinRoutingSession(key, {
      clientKey: "run:w",
      kind: "claude",
      label: "w",
    });
    const other = world.db.joinRoutingSession(key, {
      clientKey: "run:s",
      kind: "claude",
      label: "s",
    });
    world.db.setAgentRunSession("Wren", own.id);
    const snapshot = {
      text: "+supervised change\n",
      totalBytes: 20,
      truncated: false,
      files: ["x"],
    };
    world.db.appendRoutingEvents(other.id, snapshotEvents("snap-elsewhere", snapshot));
    expect(await run("Wren", "code review request Fern snapshot:snap-elsewhere")).toContain(
      "missing or incomplete",
    );
    world.db.appendRoutingEvents(own.id, snapshotEvents("snap-own", snapshot));
    const id = reviewId(await run("Wren", "code review request Fern snapshot:snap-own"));
    expect(await run("Fern", `code review ${id}`)).toContain("+supervised change");
  });

  it("refuses over telnet before any host subprocess (LAYER 0)", async () => {
    const conn = new MockConnection("telnet-wren");
    (conn as unknown as { protocol: string }).protocol = "telnet";
    world.engine.removeConnection(ids.Wren!.connection.id);
    world.engine.addConnection(conn);
    const login = world.engine.login(conn.id, "Wren");
    if ("error" in login) throw new Error(login.error);
    world.engine.entities.get(login.entityId)!.properties.coding_session_id = "code_wren";
    await world.engine.processCommand(login.entityId, "code review request Fern");
    expect(stripAnsi(conn.lastText())).toContain("not available over telnet");
    expect(reviewEvents()).toEqual([]);
  });
});

describe("review snapshots", () => {
  it("recognises a relayed review request and replaces a typed snapshot", () => {
    expect(isReviewRequestCommand("  code review request auto")).toBe(true);
    expect(isReviewRequestCommand("code review requests")).toBe(false);
    expect(isReviewRequestCommand("code review verdict x approve")).toBe(false);
    expect(withSnapshotModifier("code review request auto snapshot:forged -- a -- b", "s1")).toBe(
      "code review request auto snapshot:s1 -- a -- b",
    );
    expect(withSnapshotModifier("code review request Fern", "s2")).toBe(
      "code review request Fern snapshot:s2",
    );
  });

  it("splits within the event payload bound and reassembles exactly", () => {
    const text = `${'"\\'.repeat(20_000)}é\n${"x".repeat(50_000)}`;
    const events = snapshotEvents("s", { text, totalBytes: 1, truncated: true, files: ["a"] });
    expect(events.length).toBeGreaterThan(1);
    for (const event of events)
      expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThan(32_768);
    const back = assembleSnapshot(events.reverse(), "s")!;
    expect(back).toEqual({ text, totalBytes: 1, truncated: true, files: ["a"] });
    expect(assembleSnapshot(events.slice(1), "s")).toBeUndefined();
  });

  it("captures tracked and untracked changes against HEAD", async () => {
    const repo = mkdtempSync(join(tmpdir(), "marina-snap-"));
    try {
      gitInit(repo);
      writeFileSync(join(repo, "a.ts"), "1\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "init");
      writeFileSync(join(repo, "a.ts"), "2\n");
      writeFileSync(join(repo, "b.ts"), "new\n");
      const snapshot = await captureReviewSnapshot(repo);
      expect(snapshot.text).toContain("+2");
      expect(snapshot.text).toContain("+new");
      expect(snapshot.files).toEqual(["a.ts", "b.ts"]);
      expect(snapshot.truncated).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("leaves out empty read-only placeholders a command sandbox mounts over", async () => {
    const repo = mkdtempSync(join(tmpdir(), "marina-snap-"));
    try {
      gitInit(repo);
      writeFileSync(join(repo, "a.ts"), "1\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "init");
      writeFileSync(join(repo, "b.ts"), "new\n");
      writeFileSync(join(repo, "empty.ts"), "");
      writeFileSync(join(repo, ".bashrc"), "");
      chmodSync(join(repo, ".bashrc"), 0o444);
      const snapshot = await captureReviewSnapshot(repo);
      expect(snapshot.files).toEqual(["b.ts", "empty.ts"]);
      expect(snapshot.text).not.toContain(".bashrc");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
