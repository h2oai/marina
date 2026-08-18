// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_project.db";

describe("Project Command", () => {
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

  // ─── Project Creation ─────────────────────────────────────────────────

  describe("Project Creation", () => {
    it("should create a project with bundle, pool, and group", () => {
      engine.processCommand(conn1.entity!, "project create Alpha | A test project");
      const text = conn1.lastText();
      expect(text).toContain('Project "Alpha" created');
      expect(text).toContain("Bundle: #");
      expect(text).toContain("Pool: project:Alpha");
      expect(text).toContain("Group: project:Alpha");
    });

    it("should create DB records for the project", () => {
      engine.processCommand(conn1.entity!, "project create Beta | Testing");
      const project = db.getProjectByName("Beta");
      expect(project).toBeDefined();
      expect(project!.name).toBe("Beta");
      expect(project!.description).toBe("Testing");
      expect(project!.status).toBe("active");
      expect(project!.created_by).toBe("Alice");
      expect(project!.bundle_id).not.toBeNull();
      expect(project!.pool_id).not.toBeNull();
      expect(project!.group_id).not.toBeNull();

      // Verify side effects: bundle actually exists
      const bundle = db.getTask(project!.bundle_id!);
      expect(bundle).toBeDefined();
      expect(bundle!.title).toBe("Beta");

      // Verify side effects: pool actually exists and has notes
      const poolNotes = db.recallPoolNotes(project!.pool_id!, "Beta");
      expect(poolNotes.length).toBeGreaterThan(0);

      // Verify side effects: group actually exists
      const group = db.getGroup(project!.group_id!);
      expect(group).toBeDefined();
      expect(group!.name).toBe("project:Beta");
    });

    it("should reject duplicate project names", () => {
      engine.processCommand(conn1.entity!, "project create Alpha | First");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project create Alpha | Second");
      expect(conn1.lastText()).toContain("already exists");
    });

    it("should create project without description", () => {
      engine.processCommand(conn1.entity!, "project create NoPipe");
      expect(conn1.lastText()).toContain('Project "NoPipe" created');
    });

    it("should seed pool with welcome note", () => {
      engine.processCommand(conn1.entity!, "project create Gamma | Welcome test");
      const project = db.getProjectByName("Gamma");
      expect(project).toBeDefined();
      const notes = db.recallPoolNotes(project!.pool_id!, "project Gamma created");
      expect(notes.length).toBeGreaterThan(0);
    });
  });

  // ─── Orchestration ────────────────────────────────────────────────────

  describe("Orchestration", () => {
    it("should set NSED orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create OrcTest | Orch");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project OrcTest orchestrate nsed");
      expect(conn1.lastText()).toContain('Set orchestration to "nsed"');

      const project = db.getProjectByName("OrcTest");
      expect(project!.orchestration).toBe("nsed");

      const notes = db.recallPoolNotes(project!.pool_id!, "NSED orchestration structured cycle");
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set Chorus orchestration", () => {
      engine.processCommand(conn1.entity!, "project create ChorusTest | Chorus");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project ChorusTest orchestrate chorus");
      expect(conn1.lastText()).toContain('Set orchestration to "chorus"');
      expect(db.getProjectByName("ChorusTest")!.orchestration).toBe("chorus");
    });

    it("should set Foundry orchestration", () => {
      engine.processCommand(conn1.entity!, "project create FoundryTest | Foundry");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project FoundryTest orchestrate foundry");
      expect(conn1.lastText()).toContain('Set orchestration to "foundry"');
      expect(db.getProjectByName("FoundryTest")!.orchestration).toBe("foundry");
    });

    it("should set swarm orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create SwarmTest | Swarm");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project SwarmTest orchestrate swarm");
      expect(conn1.lastText()).toContain('Set orchestration to "swarm"');

      const project = db.getProjectByName("SwarmTest");
      expect(project!.orchestration).toBe("swarm");

      const notes = db.recallPoolNotes(
        project!.pool_id!,
        "Swarm orchestration specialist handoffs",
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set pipeline orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create PipeTest | Pipe");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project PipeTest orchestrate pipeline");
      expect(conn1.lastText()).toContain('Set orchestration to "pipeline"');

      const project = db.getProjectByName("PipeTest");
      expect(project!.orchestration).toBe("pipeline");

      const notes = db.recallPoolNotes(
        project!.pool_id!,
        "Pipeline orchestration sequential stages",
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set debate orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create DebateTest | Debate");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project DebateTest orchestrate debate");
      expect(conn1.lastText()).toContain('Set orchestration to "debate"');

      const project = db.getProjectByName("DebateTest");
      expect(project!.orchestration).toBe("debate");

      const notes = db.recallPoolNotes(
        project!.pool_id!,
        "Debate orchestration adversarial argumentation",
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set mapreduce orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create MRTest | MapReduce");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project MRTest orchestrate mapreduce");
      expect(conn1.lastText()).toContain('Set orchestration to "mapreduce"');

      const project = db.getProjectByName("MRTest");
      expect(project!.orchestration).toBe("mapreduce");

      const notes = db.recallPoolNotes(
        project!.pool_id!,
        "MapReduce orchestration parallel decomposition",
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set blackboard orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create BBTest | Blackboard");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project BBTest orchestrate blackboard");
      expect(conn1.lastText()).toContain('Set orchestration to "blackboard"');

      const project = db.getProjectByName("BBTest");
      expect(project!.orchestration).toBe("blackboard");

      const notes = db.recallPoolNotes(
        project!.pool_id!,
        "Blackboard orchestration shared workspace",
      );
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set symbiosis orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create SymTest | Symbiosis");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project SymTest orchestrate symbiosis");
      expect(conn1.lastText()).toContain('Set orchestration to "symbiosis"');

      const project = db.getProjectByName("SymTest");
      expect(project!.orchestration).toBe("symbiosis");

      const notes = db.recallPoolNotes(project!.pool_id!, "Symbiosis orchestration");
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set research orchestration and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create ResTest | Research");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project ResTest orchestrate research");
      expect(conn1.lastText()).toContain('Set orchestration to "research"');

      const project = db.getProjectByName("ResTest");
      expect(project!.orchestration).toBe("research");

      const notes = db.recallPoolNotes(project!.pool_id!, "Research orchestration");
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should handle custom orchestration", () => {
      engine.processCommand(conn1.entity!, "project create CustomOrch | Custom");
      conn1.clear();
      engine.processCommand(
        conn1.entity!,
        "project CustomOrch orchestrate custom We do things our way",
      );
      expect(conn1.lastText()).toContain("Set custom orchestration");
    });

    it("should reject unknown orchestration", () => {
      engine.processCommand(conn1.entity!, "project create BadOrch | Bad");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project BadOrch orchestrate invalid");
      expect(conn1.lastText()).toContain("Unknown orchestration");
    });
  });

  // ─── Memory Architecture ──────────────────────────────────────────────

  describe("Memory Architecture", () => {
    it("should set tiered memory and seed pool", () => {
      engine.processCommand(conn1.entity!, "project create MemTest | Mem");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project MemTest memory tiered");
      expect(conn1.lastText()).toContain('Set memory architecture to "tiered"');

      const project = db.getProjectByName("MemTest");
      expect(project!.memory_arch).toBe("tiered");

      const notes = db.recallPoolNotes(project!.pool_id!, "tiered core memory notes archival");
      expect(notes.length).toBeGreaterThan(0);
    });

    it("should set generative memory", () => {
      engine.processCommand(conn1.entity!, "project create GenTest | Gen");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project GenTest memory generative");
      expect(conn1.lastText()).toContain('Set memory architecture to "generative"');
      expect(db.getProjectByName("GenTest")!.memory_arch).toBe("generative");
    });

    it("should set graph memory", () => {
      engine.processCommand(conn1.entity!, "project create GraphTest | Graph");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project GraphTest memory graph");
      expect(conn1.lastText()).toContain('Set memory architecture to "graph"');
      expect(db.getProjectByName("GraphTest")!.memory_arch).toBe("graph");
    });

    it("should set shared memory", () => {
      engine.processCommand(conn1.entity!, "project create SharedTest | Shared");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project SharedTest memory shared");
      expect(conn1.lastText()).toContain('Set memory architecture to "shared"');
      expect(db.getProjectByName("SharedTest")!.memory_arch).toBe("shared");
    });

    it("should handle custom memory", () => {
      engine.processCommand(conn1.entity!, "project create CustomMem | Custom");
      conn1.clear();
      engine.processCommand(
        conn1.entity!,
        "project CustomMem memory custom Use only notes with high importance",
      );
      expect(conn1.lastText()).toContain("Set custom memory");
    });

    it("should reject unknown memory architecture", () => {
      engine.processCommand(conn1.entity!, "project create BadMem | Bad");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project BadMem memory invalid");
      expect(conn1.lastText()).toContain("Unknown memory");
    });
  });

  // ─── Join ─────────────────────────────────────────────────────────────

  describe("Join", () => {
    it("should join a project and receive orientation", () => {
      engine.processCommand(conn1.entity!, "project create JoinTest | Join testing");
      conn2.clear();
      engine.processCommand(conn2.entity!, "project JoinTest join");
      const text = conn2.lastText();
      expect(text).toContain('Joined project "JoinTest"');
      expect(text).toContain("Orchestration:");
      expect(text).toContain("Memory:");
    });

    it("should not join twice", () => {
      engine.processCommand(conn1.entity!, "project create JoinOnce | Once");
      // Alice is already the leader/member
      conn1.clear();
      engine.processCommand(conn1.entity!, "project JoinOnce join");
      expect(conn1.lastText()).toContain("already in project");
    });
  });

  // ─── Status ───────────────────────────────────────────────────────────

  describe("Status", () => {
    it("should show project status", () => {
      engine.processCommand(conn1.entity!, "project create StatusTest | Status testing");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project StatusTest status");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("StatusTest Status");
      expect(text).toContain("Status: [active]");
    });
  });

  // ─── Propose ──────────────────────────────────────────────────────────

  describe("Propose", () => {
    it("should post a proposal to the project board", () => {
      engine.processCommand(conn1.entity!, "project create PropTest | Proposal testing");
      conn1.clear();
      engine.processCommand(
        conn1.entity!,
        "project PropTest propose We should start with the relay room",
      );
      expect(conn1.lastText()).toContain("Proposal posted");
    });
  });

  // ─── Tasks ────────────────────────────────────────────────────────────

  describe("Tasks", () => {
    it("should show no tasks initially", () => {
      engine.processCommand(conn1.entity!, "project create TaskTest | Task testing");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project TaskTest tasks");
      expect(conn1.lastText()).toContain("no tasks yet");
    });
  });

  // ─── List ─────────────────────────────────────────────────────────────

  describe("List", () => {
    it("should list all projects", () => {
      engine.processCommand(conn1.entity!, "project create ListA | First");
      engine.processCommand(conn1.entity!, "project create ListB | Second");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project list");
      const text = conn1.lastText();
      expect(text).toContain("Projects");
      expect(text).toContain("ListA");
      expect(text).toContain("ListB");
    });

    it("should show empty list when no projects", () => {
      engine.processCommand(conn1.entity!, "project list");
      expect(conn1.lastText()).toContain("No projects exist");
    });
  });

  // ─── Info ─────────────────────────────────────────────────────────────

  describe("Info", () => {
    it("should show project info", () => {
      engine.processCommand(conn1.entity!, "project create InfoTest | Info testing project");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project info InfoTest");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("Project: InfoTest");
      expect(text).toContain("Info testing project");
      expect(text).toContain("Status: [active]");
      expect(text).toContain("Orchestration: [custom]");
      expect(text).toContain("Memory: custom");
      expect(text).toContain("Created by: Alice");
    });

    it("should show not found for missing project", () => {
      engine.processCommand(conn1.entity!, "project info NonExistent");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Error Cases ──────────────────────────────────────────────────────

  describe("Error Cases", () => {
    it("should show usage with no args", () => {
      engine.processCommand(conn1.entity!, "project");
      expect(conn1.lastText()).toContain("Usage:");
    });

    it("should handle unknown project name", () => {
      engine.processCommand(conn1.entity!, "project NoSuchProject status");
      expect(conn1.lastText()).toContain("not found");
    });

    it("should handle unknown action", () => {
      engine.processCommand(conn1.entity!, "project create ErrTest | Error testing");
      conn1.clear();
      engine.processCommand(conn1.entity!, "project ErrTest badaction");
      expect(conn1.lastText()).toContain("Unknown project action");
    });

    it("should reject short project names", () => {
      engine.processCommand(conn1.entity!, "project create X");
      expect(conn1.lastText()).toContain("at least 2 characters");
    });
  });

  // ─── DB Methods ───────────────────────────────────────────────────────

  describe("DB Methods", () => {
    it("should create and retrieve projects", () => {
      db.createProject({
        id: "proj_test_1",
        name: "DBTest",
        description: "Direct DB test",
        createdBy: "system",
      });
      const project = db.getProjectByName("DBTest");
      expect(project).toBeDefined();
      expect(project!.name).toBe("DBTest");
      expect(project!.status).toBe("active");
    });

    it("should list projects by status", () => {
      db.createProject({ id: "proj_a", name: "Active1", createdBy: "system" });
      db.createProject({ id: "proj_b", name: "Active2", createdBy: "system" });
      db.createProject({ id: "proj_c", name: "Done1", createdBy: "system" });
      db.updateProjectStatus("proj_c", "completed");

      const active = db.listProjects("active");
      expect(active.length).toBe(2);

      const completed = db.listProjects("completed");
      expect(completed.length).toBe(1);
      expect(completed[0]!.name).toBe("Done1");

      const all = db.listProjects();
      expect(all.length).toBe(3);
    });

    it("should update orchestration and memory_arch", () => {
      db.createProject({ id: "proj_up", name: "UpTest", createdBy: "system" });
      db.updateProjectOrchestration("proj_up", "nsed");
      db.updateProjectMemoryArch("proj_up", "graph");

      const project = db.getProject("proj_up");
      expect(project!.orchestration).toBe("nsed");
      expect(project!.memory_arch).toBe("graph");
    });
  });
});
