import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_groups.db";

describe("Groups", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create a group", () => {
    engine.processCommand(conn1.entity!, "group create explorers The Explorers Guild");
    expect(conn1.lastText()).toContain('Created group "The Explorers Guild"');
  });

  it("should list groups", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn1.clear();
    engine.processCommand(conn1.entity!, "group list");
    expect(conn1.lastText()).toContain("Explorers");
  });

  it("should show group info", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn1.clear();
    engine.processCommand(conn1.entity!, "group info Explorers");
    const text = conn1.lastText();
    expect(text).toContain("Explorers");
    expect(text).toContain("Members");
  });

  it("should allow join and leave", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn2.clear();
    engine.processCommand(conn2.entity!, "group join Explorers");
    expect(conn2.lastText()).toContain('Joined group "Explorers"');

    conn2.clear();
    engine.processCommand(conn2.entity!, "group leave Explorers");
    expect(conn2.lastText()).toContain('Left group "Explorers"');
  });

  it("should auto-create channel and board for group", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    const gm = engine.groupManager!;
    const group = gm.getByName("Explorers");
    expect(group).toBeDefined();
    expect(group!.channelId).toBeTruthy();
    expect(group!.boardId).toBeTruthy();

    // Channel should exist
    const channel = engine.channelManager!.getChannel(group!.channelId!);
    expect(channel).toBeDefined();
    expect(channel!.name).toContain("group:explorers");

    // Board should exist
    const board = engine.boardManager!.getBoard(group!.boardId!);
    expect(board).toBeDefined();
  });

  it("should add member to group channel on join", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    engine.processCommand(conn2.entity!, "group join Explorers");

    const group = engine.groupManager!.getByName("Explorers")!;
    const members = engine.channelManager!.getMembers(group.channelId!);
    expect(members).toContain(conn2.entity!);
  });

  it("should remove member from group channel on leave", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    engine.processCommand(conn2.entity!, "group join Explorers");
    engine.processCommand(conn2.entity!, "group leave Explorers");

    const group = engine.groupManager!.getByName("Explorers")!;
    const members = engine.channelManager!.getMembers(group.channelId!);
    expect(members).not.toContain(conn2.entity!);
  });

  it("should invite players", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "group invite Bob explorers");
    expect(conn1.lastText()).toContain("Invited Bob");
    expect(conn2.lastText()).toContain("invited to group");
  });

  it("should kick players", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    engine.processCommand(conn2.entity!, "group join Explorers");
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "group kick Bob explorers");
    expect(conn1.lastText()).toContain("Kicked Bob");
    expect(conn2.lastText()).toContain("kicked from group");
  });

  it("should promote and demote members", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    engine.processCommand(conn2.entity!, "group join Explorers");
    conn1.clear();
    engine.processCommand(conn1.entity!, "group promote Bob explorers");
    expect(conn1.lastText()).toContain("Promoted Bob");

    conn1.clear();
    engine.processCommand(conn1.entity!, "group demote Bob explorers");
    expect(conn1.lastText()).toContain("Demoted Bob");
  });

  it("should prevent leader from leaving", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn1.clear();
    engine.processCommand(conn1.entity!, "group leave Explorers");
    expect(conn1.lastText()).toContain("Leaders cannot leave");
  });

  it("should disband a group", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    conn1.clear();
    engine.processCommand(conn1.entity!, "group disband Explorers");
    expect(conn1.lastText()).toContain("Disbanded group");
  });

  it("should prevent non-leader from disbanding", () => {
    engine.processCommand(conn1.entity!, "group create explorers Explorers");
    engine.processCommand(conn2.entity!, "group join Explorers");
    conn2.clear();
    engine.processCommand(conn2.entity!, "group disband Explorers");
    expect(conn2.lastText()).toContain("Only the leader");
  });

  it("group manager should work directly", () => {
    const gm = engine.groupManager!;
    const group = gm.create({
      id: "testers",
      name: "Testers",
      description: "Testing group",
      leaderId: conn1.entity!,
    });
    expect(group.name).toBe("Testers");
    expect(gm.isMember("testers", conn1.entity!)).toBe(true);

    gm.addMember("testers", conn2.entity!);
    expect(gm.isMember("testers", conn2.entity!)).toBe(true);

    const members = gm.getMembers("testers");
    expect(members.length).toBe(2);

    expect(gm.canInvite("testers", conn1.entity!)).toBe(true);
    expect(gm.canKick("testers", conn1.entity!)).toBe(true);
  });
});
