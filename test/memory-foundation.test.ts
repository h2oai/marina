// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { Engine } from "../src/engine/engine";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { handleMemApi } from "../src/net/mem-api";
import { MarinaDB } from "../src/persistence/database";
import { createNote, createNoteLink } from "../src/persistence/db-notes";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";
import type { MarinaClient } from "../src/sdk/client";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("memory foundation contracts", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let memory: PlatformMemoryBackend;
  let commands: string[];

  function command(text: string, connection = alice) {
    connection.clear();
    commands.push(text);
    engine.processCommand(connection.entity!, text);
    return [...connection.messages];
  }

  async function request(actor: "Alice" | "Bob", path: string, method = "GET", body?: unknown) {
    const url = new URL(`http://memory.test/mem${path}`);
    const response = await handleMemApi(
      url,
      method,
      new Request(url, {
        method,
        headers: {
          Authorization: `Bearer test-memory-${actor}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      db,
    );
    if (!response) throw new Error(`Unhandled memory route ${path}`);
    return { status: response.status, data: await response.json() };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-memory-foundation-"));
    db = new MarinaDB(join(directory, "test.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    alice = new MockConnection("alice");
    bob = new MockConnection("bob");
    commands = [];
    for (const [connection, name] of [
      [alice, "Alice"],
      [bob, "Bob"],
    ] as const) {
      db.createUser({ id: crypto.randomUUID(), name });
      engine.addConnection(connection);
      const entity = engine.spawnEntity(connection.id, name)!;
      db.saveEntity(entity);
      db.createMemApiKey(`test-${name}`, `test-memory-${name}`, name);
    }
    memory = new PlatformMemoryBackend({
      command: async (text: string) => command(text),
      memoryService: (request: import("../src/sdk/memory-operations").MemoryOperationRequest) =>
        residentMemoryOperation(db, "Alice", request),
    } as unknown as MarinaClient);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true });
  });

  it("delivers complete structured recall from the actual command producer", async () => {
    const content = `continuity ${"long evidence ".repeat(20)}FINAL_REQUIRED_DETAIL`;
    const id = db.createNote("Alice", content, undefined, { importance: 8, noteType: "fact" });
    const result = await memory.search("continuity");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0]).toMatchObject({ id: String(id), content, noteType: "fact" });
    expect(alice.messages.some((p) => p.data.memory !== undefined)).toBe(true);
  });

  it("round-trips focus and a durable service checkpoint", async () => {
    const focus = { description: "Finish the multi-session task", startedAt: 42 };
    const checkpoint = {
      lastIntent: "Verify the artifact",
      timestamp: 43,
      recentActions: ["inspect"],
    };
    await memory.saveFocus(focus);
    await memory.saveCheckpoint(checkpoint);
    expect(await memory.getFocus()).toEqual(focus);
    expect(await memory.getCheckpoint()).toEqual(checkpoint);
    await memory.saveFocus(null);
    expect(await memory.getFocus()).toBeNull();
  });

  it("delivers full shared evidence and skill procedures", async () => {
    db.createMemoryPool("guide", "guide", "Alice");
    const shared = `inheritance ${"source context ".repeat(20)}SHARED_DETAIL`;
    db.addPoolNote("guide", "Bob", shared);
    expect((await memory.importShared("guide", "inheritance")).results?.[0]?.content).toBe(shared);
    await memory.storeSkill(
      "carefuldeploy",
      "description ".repeat(20),
      "RUN_VALIDATION; VERIFY_HEALTH",
    );
    expect((await memory.searchSkills("carefuldeploy")).results?.[0]?.content).toContain(
      "RUN_VALIDATION; VERIFY_HEALTH",
    );
  });

  it("keeps trusted recall strict when only unverified notes match", async () => {
    db.createNote("Alice", "trustedneedle unsupported claim");
    const result = await memory.search("trustedneedle", { trusted: true });
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(commands).toEqual(["recall trustedneedle trusted"]);
  });

  it("searchTiered keeps the trusted tier strict and surfaces unverified notes as ordinary", async () => {
    const plain = db.createNote("Alice", "tierneedle plain observation");
    const verified = db.createNote("Alice", "tierneedle verified fact", undefined, {
      noteType: "fact",
      verificationStatus: "verified",
    });
    const tiers = await memory.searchTiered("tierneedle");
    expect(commands).toEqual(["recall tierneedle trusted", "recall tierneedle"]);
    expect(tiers.trusted.map((n) => n.id)).toEqual([String(verified)]);
    expect(tiers.ordinary.map((n) => n.id).sort()).toEqual(
      [String(plain), String(verified)].sort(),
    );
  });

  it("applies type, trust, active status and tier to graph-discovered candidates", async () => {
    const seed = db.createNote("Alice", "filterneedle reliable seed", undefined, {
      noteType: "fact",
      verificationStatus: "verified",
    });
    const eligible = db.createNote("Alice", "eligible linked knowledge", undefined, {
      noteType: "fact",
      verificationStatus: "verified",
    });
    const hidden = [
      db.createNote("Alice", "[compaction] hidden scratch", undefined, {
        noteType: "fact",
        verificationStatus: "verified",
      }),
      db.createNote("Alice", "hidden obsolete fact", undefined, {
        noteType: "fact",
        verificationStatus: "superseded",
      }),
      db.createNote("Alice", "hidden wrong type", undefined, {
        noteType: "decision",
        verificationStatus: "verified",
      }),
      db.createNote("Alice", "hidden untrusted fact", undefined, { noteType: "fact" }),
    ];
    for (const id of [eligible, ...hidden]) db.createNoteLink(seed, id, "related_to");
    const result = await memory.search("filterneedle", {
      noteType: "fact",
      mode: "recent",
      trusted: true,
    });
    expect(result.results?.map((n) => n.id).sort()).toEqual(
      [String(seed), String(eligible)].sort(),
    );
    for (const id of hidden) expect(result.text).not.toContain(db.getNote(id)!.content);
  });

  it("keeps old skills in the library after ordinary journal growth", () => {
    command("skill store enduring | useful procedure | inspect; verify");
    for (let i = 0; i < 110; i++) db.createNote("Alice", `ordinary observation ${i}`);
    command("skill list");
    expect(alice.lastText()).toContain("enduring");
  });

  for (const operation of ["evolve", "correct", "trace", "explain", "delete", "verify"]) {
    it(`denies ${operation} of another resident's private note`, () => {
      const id = db.createNote("Alice", "PRIVATE_SENTINEL", undefined, { noteType: "fact" });
      command(
        `note ${operation} ${id} ${operation === "correct" ? "replacement" : "verified"}`,
        bob,
      );
      expect(bob.allTextJoined()).not.toContain("PRIVATE_SENTINEL");
      expect(db.getNotesByEntity("Bob")).toHaveLength(0);
      expect(db.getNote(id)?.content).toBe("PRIVATE_SENTINEL");
      expect(db.getNote(id)?.verification_status).toBe("unverified");
    });
  }

  it("does not leak private room notes or source excerpts", () => {
    const secret = db.createNote("Alice", "PRIVATE_SOURCE_SENTINEL", "test/start");
    const own = db.createNote("Bob", "owned note");
    command("note room", bob);
    expect(bob.allTextJoined()).not.toContain("PRIVATE_SOURCE_SENTINEL");
    command(`note derive ${own} ${secret}`, bob);
    command(`note source ${own} note:${secret}`, bob);
    expect(db.getNoteSources(own)).toHaveLength(0);
    expect(db.getNoteLinks(own)).toHaveLength(0);
  });

  it("requires writable source and readable target for links and unlinks", () => {
    const secret = db.createNote("Alice", "private graph source");
    const own = db.createNote("Bob", "owned graph source");
    command(`note link ${own} ${secret} related_to`, bob);
    expect(db.getNoteLinks(own)).toHaveLength(0);
    db.createNoteLink(secret, own, "supports");
    command(`note unlink ${secret} ${own} supports`, bob);
    expect(db.getNoteLinks(secret)).toHaveLength(1);
  });

  it("does not traverse through denied nodes or expose their edge identifiers", async () => {
    const root = db.createNote("Alice", "visible root");
    const secret = db.createNote("Bob", "PRIVATE_GRAPH_SENTINEL");
    const unreachable = db.createNote("Alice", "hidden behind denied bridge");
    db.createNoteLink(root, secret, "related_to");
    db.createNoteLink(secret, unreachable, "related_to");
    const trace = await request("Alice", `/notes/${root}/trace`);
    expect(trace.status).toBe(200);
    expect(trace.data.graph.map((g: { note: { id: number } }) => g.note.id)).toEqual([root]);
    expect(trace.data.graph[0].links).toEqual([]);
    expect((await request("Alice", `/notes/${root}`)).data.links).toEqual([]);
    command(`note trace ${root}`);
    expect(alice.allTextJoined()).not.toContain("PRIVATE_GRAPH_SENTINEL");
    expect(alice.allTextJoined()).not.toContain("hidden behind denied bridge");
  });

  it("rejects a forbidden inline link atomically", async () => {
    const secret = db.createNote("Alice", "private inline source");
    const response = await request("Bob", "/notes", "POST", {
      content: "must not be persisted",
      links: [{ target: secret, relationship: "related_to" }],
    });
    expect(response.status).toBe(404);
    expect(db.getNotesByEntity("Bob")).toHaveLength(0);
  });

  it("enforces group membership on pool routes, note routes, commands and revocation", async () => {
    db.createGroup({ id: "team", name: "team", leaderId: alice.entity! });
    db.addGroupMember("team", alice.entity!);
    db.createMemoryPool("restricted", "restricted", "Alice", "team");
    const note = db.addPoolNote("restricted", "Alice", "GROUP_PRIVATE_SENTINEL");
    for (const path of [
      "/pools/restricted",
      "/pools/restricted/notes",
      "/pools/restricted/recall?q=GROUP",
      `/notes/${note}`,
    ]) {
      expect((await request("Bob", path)).status).toBe(404);
    }
    expect(
      (await request("Bob", "/pools/restricted/notes", "POST", { content: "forbidden" })).status,
    ).toBe(404);
    expect((await request("Bob", "/pools")).data.pools).toEqual([]);
    command("pool restricted list", bob);
    expect(bob.allTextJoined()).not.toContain("GROUP_PRIVATE_SENTINEL");
    db.addGroupMember("team", bob.entity!);
    expect((await request("Bob", "/pools/restricted/notes")).data.notes[0].content).toBe(
      "GROUP_PRIVATE_SENTINEL",
    );
    expect(
      (await request("Bob", "/pools/restricted/notes", "POST", { content: "member contribution" }))
        .status,
    ).toBe(201);
    db.removeGroupMember("team", bob.entity!);
    expect((await request("Bob", "/notes")).data.notes).toEqual([]);
    command("note list", bob);
    expect(bob.allTextJoined()).not.toContain("member contribution");
  });

  it("preserves explicit world-pool sharing and permitted source attribution", async () => {
    db.createMemoryPool("public", "public", "Alice");
    const shared = db.addPoolNote("public", "Alice", "shared procedure");
    const own = db.createNote("Bob", "my conclusion");
    expect((await request("Bob", "/pools/public/notes")).status).toBe(200);
    command(`note derive ${own} ${shared}`, bob);
    expect(db.getNoteSources(own)[0]?.source_note_id).toBe(shared);
  });

  it("does not copy or share another resident's private skill", () => {
    const secret = db.createNote(
      "Alice",
      "[Skill: PRIVATE_SKILL] description || Actions: hidden",
      undefined,
      { noteType: "skill" },
    );
    const own = db.createNote("Bob", "[Skill: own] desc || Actions: inspect", undefined, {
      noteType: "skill",
    });
    db.createMemoryPool("public", "public", "Bob");
    command(`skill share ${secret} public`, bob);
    command(`skill compose ${secret} ${own}`, bob);
    command(`skill verify ${secret}`, bob);
    expect(db.getPoolNotes("public")).toHaveLength(0);
    expect(db.getNotesByEntity("Bob")).toHaveLength(1);
    expect(db.getNoteLinks(secret)).toHaveLength(0);
  });

  it("repeated corrections expose one current version through command and REST recall", async () => {
    let current = db.createNote("Alice", "revisionneedle initial state", undefined, {
      noteType: "fact",
    });
    const first = current;
    for (let i = 0; i < 100; i++) {
      command(`note correct ${current} revisionneedle state${i}`);
      expect(stripAnsi(alice.lastText())).toContain("superseding");
      const successor = db.getNotesByEntity("Alice", 1)[0]!;
      expect(successor.supersedes_id).toBe(current);
      expect(db.getNote(current)?.verification_status).toBe("superseded");
      current = successor.id;
    }
    expect((await memory.search("revisionneedle")).results?.map((n) => n.id)).toEqual([
      String(current),
    ]);
    expect(
      (await request("Alice", "/recall?q=revisionneedle")).data.results.map(
        (n: { id: number }) => n.id,
      ),
    ).toEqual([current]);
    const before = db.getNotesByEntity("Alice", 1000).length;
    command(`note correct ${first} stale conflicting edit`);
    expect(db.getNotesByEntity("Alice", 1000)).toHaveLength(before);
    command(`note verify ${first} verified 1`);
    db.recordNoteVerification(first, "historical-review", "verified", 1);
    expect(db.updateNoteQuality(first, "Alice", 1, "verified")).toBe(false);
    expect(db.getNote(first)?.verification_status).toBe("superseded");
    expect(db.recallNotes("Alice", "revisionneedle").map((note) => note.id)).toEqual([current]);
  });

  it("allows an explicit new assertion after exact text was retired", () => {
    const keeper = db.createNote("Alice", "current fact");
    const retired = db.createNote("Alice", "returning assertion");
    db.consolidateNotes("Alice", keeper, [retired]);
    const fresh = db.createNote("Alice", "returning assertion");
    expect(fresh).not.toBe(retired);
    expect(db.recallNotes("Alice", "returning assertion").map((n) => n.id)).toContain(fresh);
  });

  it("honors zero weights and excludes process and retired graph candidates in REST", async () => {
    const seed = db.createNote("Alice", "restneedle current fact");
    const hidden = [
      db.createNote("Alice", "[compaction] scratch"),
      db.createNote("Alice", "retired fact", undefined, { verificationStatus: "superseded" }),
    ];
    for (const id of hidden) db.createNoteLink(seed, id, "related_to");
    const result = await request("Alice", "/recall?q=restneedle&wi=0&wr=0&wrel=1");
    expect(result.data.weights).toEqual({
      weightImportance: 0,
      weightRecency: 0,
      weightRelevance: 1,
    });
    expect(result.data.results.map((n: { id: number }) => n.id)).toEqual([seed]);
    expect((await request("Alice", "/recall?q=restneedle&wi=NaN")).status).toBe(400);
  });

  it("preserves JSON whitespace, Unicode and error-like text in persisted checkpoints", async () => {
    const checkpoint = {
      lastIntent: "artifact not found  — inspect again",
      evidence: ["α  β", "line\nnext"],
    };
    expect((await memory.saveCheckpoint(checkpoint)).success).toBe(true);
    expect(await memory.getCheckpoint()).toEqual(checkpoint);
    const encoded = JSON.parse(
      JSON.stringify(
        await residentMemoryOperation(db, "Alice", { operation: "checkpoint", id: "resident" }),
      ),
    );
    const transport = new PlatformMemoryBackend({
      memoryService: async () => encoded,
    } as unknown as MarinaClient);
    expect(await transport.getCheckpoint()).toEqual(checkpoint);
    // Reopen the real database to check persistence independently of the live Engine.
    const reopened = new MarinaDB(join(directory, "test.db"));
    try {
      const result = await residentMemoryOperation(reopened, "Alice", {
        operation: "checkpoint",
        id: "resident",
      });
      expect((result.result as { data: unknown }).data).toEqual(checkpoint);
    } finally {
      reopened.close();
    }
  });

  it("reports failed searches and pool writes accurately to residents", async () => {
    expect((await memory.search("")).success).toBe(false);
    expect((await memory.searchSkills("")).success).toBe(false);
    expect((await memory.share("payload", "missing")).success).toBe(false);
    db.createMemoryPool("public", "public", "Alice");
    expect((await memory.share("payload", "public")).success).toBe(true);
    expect((await memory.write("observation", "new observation")).success).toBe(true);
  });

  it("rolls back both note and revision writes when link persistence fails", () => {
    expect(() =>
      db.createNoteWithLinks("Alice", "partial write", {}, [
        { target: 99999, relationship: "supports" },
      ]),
    ).toThrow();
    expect(db.getNotesByEntity("Alice")).toHaveLength(0);
    const old = db.createNote("Alice", "current state");
    const raw = new Database(join(directory, "test.db"));
    try {
      raw.exec(
        "CREATE TRIGGER reject_test_link BEFORE INSERT ON note_links BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END",
      );
      expect(() => db.reviseNote("Alice", old, "new state")).toThrow();
      expect(db.getNotesByEntity("Alice")).toHaveLength(1);
      expect(db.getNote(old)?.verification_status).toBe("unverified");
      expect(db.getNoteLinks(old)).toHaveLength(0);
    } finally {
      raw.exec("DROP TRIGGER reject_test_link");
      raw.close();
    }
  });

  it("rechecks group membership after awaiting a request body", async () => {
    db.createGroup({ id: "team", name: "team", leaderId: alice.entity! });
    db.addGroupMember("team", bob.entity!);
    db.createMemoryPool("restricted", "restricted", "Alice", "team");
    const url = new URL("http://memory.test/mem/pools/restricted/notes");
    const req = new Request(url, {
      method: "POST",
      headers: { Authorization: "Bearer test-memory-Bob" },
    });
    req.json = async () => {
      db.removeGroupMember("team", bob.entity!);
      return { content: "late write" };
    };
    const response = await handleMemApi(url, "POST", req, db);
    expect(response?.status).toBe(404);
    expect(db.getPoolNotes("restricted")).toHaveLength(0);
  });

  it("keeps process data out of pool recall unless explicitly requested", () => {
    db.createMemoryPool("public", "public", "Alice");
    const process = db.addPoolNote("public", "Alice", "[compaction] poolneedle");
    const fact = db.addPoolNote("public", "Alice", "poolneedle current fact");
    expect(db.recallPoolNotes("public", "poolneedle").map((note) => note.id)).toEqual([fact]);
    expect(
      db.recallPoolNotes("public", "poolneedle", { includeProcess: true }).map((note) => note.id),
    ).toContain(process);
  });

  it("keeps generated reflections in their tier without recursive self-sourcing", () => {
    const original = db.createNote("Alice", "task source copper requirement", undefined, {
      importance: 8,
    });
    db.createNote("Alice", "task source approval requirement", undefined, { importance: 8 });
    for (let i = 0; i < 30; i++) command("reflect");
    const reflections = db.getNotesByEntity("Alice").filter((note) => note.tier === "reflection");
    expect(reflections).toHaveLength(1);
    expect(reflections[0]?.content).toContain("copper requirement");
    expect(db.getNoteLinks(reflections[0]!.id).map((link) => link.source_id)).toContain(original);
    expect(
      db.getNoteLinks(reflections[0]!.id).some((link) => link.source_id === reflections[0]!.id),
    ).toBe(false);
  });

  it("blocks alternate transformations after pool membership is revoked", () => {
    db.createGroup({ id: "team", name: "team", leaderId: alice.entity! });
    db.addGroupMember("team", bob.entity!);
    db.createMemoryPool("restricted", "restricted", "Alice", "team");
    const first = db.addPoolNote("restricted", "Bob", "REVOKED_PRIVATE_ALPHA", 9);
    db.addPoolNote("restricted", "Bob", "REVOKED_PRIVATE_BETA", 9);
    db.removeGroupMember("team", bob.entity!);
    command("reflect", bob);
    expect(bob.allTextJoined()).not.toContain("REVOKED_PRIVATE");
    command(`note source ${first} https://example.test/evidence`, bob);
    expect(db.getNoteSources(first)).toHaveLength(0);
    expect(db.getNotesByEntity("Bob")).toHaveLength(2);
  });

  it("requires write authority over both claims before resolving a contradiction", () => {
    db.createMemoryPool("public", "public", "Alice");
    const left = db.addPoolNote("public", "Alice", "approval is required");
    const right = db.addPoolNote("public", "Bob", "approval is not required");
    db.refreshContradictionCases();
    const conflict = db.listContradictionCases("open")[0]!;
    expect(conflict).toBeDefined();
    command(`note resolve ${conflict.id} left inspected evidence`, bob);
    expect(db.getContradictionCase(conflict.id)?.status).toBe("open");
    expect(db.getNote(left)?.verification_status).toBe("unverified");
    expect(db.getNote(right)?.verification_status).toBe("unverified");
  });

  it("repairs only unambiguous same-scope legacy revisions on database upgrade", () => {
    db.close();
    const path = join(directory, "legacy.db");
    const raw = new Database(path);
    raw.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 95)) {
      raw.exec(migration.sql);
      raw.run("INSERT INTO schema_version(version) VALUES (?)", [migration.version]);
    }
    const old = createNote(raw, "Alice", "legacy old version");
    const successor = createNote(raw, "Alice", "legacy current version", undefined, {
      supersedesId: old,
    });
    createNoteLink(raw, successor, old, "supersedes");
    const foreign = createNote(raw, "Bob", "foreign historical record");
    const unauthorized = createNote(raw, "Alice", "legacy unauthorized copy", undefined, {
      supersedesId: foreign,
    });
    createNoteLink(raw, unauthorized, foreign, "supersedes");
    const keeper = createNote(raw, "Alice", "consolidation keeper");
    const retired = createNote(raw, "Alice", "legacy retired duplicate", undefined, {
      supersedesId: keeper,
      verificationStatus: "superseded",
    });
    createNoteLink(raw, keeper, retired, "supersedes");
    // Real legacy feed rows can contain malformed JSON. Cleanup must still
    // remove private automatic copies and leave unrelated canvases untouched.
    for (const name of ["feed", "personal"])
      raw.run(
        "INSERT INTO canvases(id,name,creator_name,created_at,updated_at) VALUES (?,?,?,0,0)",
        [name, name, "Alice"],
      );
    for (const [id, canvas, data] of [
      ["malformed", "feed", "{bad"],
      ["private-copy", "feed", JSON.stringify({ feedType: "note_created", ref: `note:${old}` })],
      ["manual-copy", "personal", JSON.stringify({ feedType: "note_created", ref: `note:${old}` })],
    ])
      raw.run(
        "INSERT INTO canvas_nodes(id,canvas_id,type,data,creator_name,created_at,updated_at) VALUES (?,?,'text',?,'Alice',0,0)",
        [id!, canvas!, data!],
      );
    raw.close();
    db = new MarinaDB(path);
    expect(db.getNote(old)?.verification_status).toBe("superseded");
    expect(db.getNote(successor)?.supersedes_id).toBe(old);
    expect(db.getNote(foreign)?.verification_status).toBe("unverified");
    expect(db.getNote(retired)?.supersedes_id).toBeNull();
    expect(db.getNoteLinks(keeper)).toHaveLength(1);
    expect(db.getNotesByEntity("Alice")).toHaveLength(5);
    expect(db.getNode("malformed")).toBeDefined();
    expect(db.getNode("private-copy")).toBeUndefined();
    expect(db.getNode("manual-copy")).toBeDefined();
  });
});
