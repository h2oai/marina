import { afterEach, describe, expect, test } from "bun:test";
import { CodingServiceManager } from "../src/coding/service-manager";
import type { FlywheelToolBackend } from "../src/integrations/flywheel-manager";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { cleanupDb } from "./helpers";

const DB_PATH = "test_coding_services.db";
const OWNER = entityId("entity-service");

afterEach(() => cleanupDb(DB_PATH));

describe("CodingServiceManager", () => {
  test("persists a bounded managed-service recipe and controls it without host fallback", async () => {
    const db = databaseWithSessionAndBinding();
    const state = { alive: true, starts: 0 };
    const manager = new CodingServiceManager(db, backend(state));

    const service = await manager.start({
      entityId: OWNER,
      sessionId: "coding-session",
      name: "web",
      command: ["bun", "run", "dev"],
      port: 3000,
    });
    expect(service).toMatchObject({
      entity_id: OWNER,
      guest_cwd: "/workspace/projects/demo",
      name: "web",
      pid: 4242,
      port: 3000,
      process_identity: "9001",
      status: "running",
    });
    expect(JSON.parse(service.command_json)).toEqual(["bun", "run", "dev"]);
    expect(await manager.logs(OWNER, service, 1000)).toBe("ready on 3000");
    expect(await manager.probe(OWNER, service, "/health")).toMatchObject({
      body: '{"ok":true}',
      httpStatus: 200,
      truncated: false,
    });
    const screenshot = await manager.screenshot(OWNER, service, "/health");
    expect([...screenshot.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await expect(manager.probe(OWNER, service, "http://elsewhere")).rejects.toThrow("Probe path");
    await expect(manager.logs(OWNER, service, Number.NaN)).rejects.toThrow("Log line count");

    state.alive = false;
    expect(await manager.refresh(OWNER, service)).toMatchObject({ status: "stopped", pid: null });
    state.alive = true;
    const restarted = await manager.restart(OWNER, db.getCodingService(service.id)!);
    expect(restarted).toMatchObject({ status: "running", pid: 4242 });
    expect(state.starts).toBe(2);
    expect(await manager.stop(OWNER, restarted)).toMatchObject({ status: "stopped", pid: null });
    db.close();
  });

  test("rejects invalid names, ports, duplicate services, and cross-sandbox ownership", async () => {
    const db = databaseWithSessionAndBinding();
    const manager = new CodingServiceManager(db, backend({ alive: true, starts: 0 }));
    await expect(
      manager.start({
        entityId: OWNER,
        sessionId: "coding-session",
        name: "Bad Name",
        command: ["sleep", "10"],
      }),
    ).rejects.toThrow("Service names");
    await expect(
      manager.start({
        entityId: OWNER,
        sessionId: "coding-session",
        name: "web",
        command: ["sleep", "10"],
        port: 70000,
      }),
    ).rejects.toThrow("1 to 65535");
    const service = await manager.start({
      entityId: OWNER,
      sessionId: "coding-session",
      name: "web",
      command: ["sleep", "10"],
    });
    await expect(
      manager.start({
        entityId: OWNER,
        sessionId: "coding-session",
        name: "web",
        command: ["sleep", "10"],
      }),
    ).rejects.toThrow("already exists");
    db.deleteFlywheelBinding(OWNER);
    db.saveFlywheelBinding({
      entityId: OWNER,
      sessionId: "flywheel-new",
      sandboxId: "sandbox-new",
      image: "code:latest",
      keepAlive: true,
      state: "running",
    });
    await expect(manager.logs(OWNER, service)).rejects.toThrow("current Flywheel sandbox");
    db.close();
  });

  test("never signals a reused PID whose process birth identity changed", async () => {
    const db = databaseWithSessionAndBinding();
    const state = { alive: true, starts: 0, identityMatches: true };
    const manager = new CodingServiceManager(db, backend(state));
    const service = await manager.start({
      entityId: OWNER,
      sessionId: "coding-session",
      name: "worker",
      command: ["sleep", "100"],
    });
    state.identityMatches = false;
    expect(await manager.refresh(OWNER, service)).toMatchObject({
      status: "unknown",
      last_error: expect.stringContaining("different process"),
    });
    await expect(manager.stop(OWNER, db.getCodingService(service.id)!)).rejects.toThrow(
      "no process was signaled",
    );
    expect(state.alive).toBe(true);
    db.close();
  });
});

function databaseWithSessionAndBinding(): MarinaDB {
  const db = new MarinaDB(DB_PATH);
  db.createCodingSession({
    id: "coding-session",
    title: "Services",
    workspaceRoot: "/unused",
    createdBy: "Agent",
  });
  db.saveFlywheelBinding({
    entityId: OWNER,
    sessionId: "flywheel-session",
    sandboxId: "sandbox-service",
    image: "code:latest",
    keepAlive: true,
    state: "running",
  });
  db.updateFlywheelBinding(OWNER, {
    activeProjectId: "project-demo",
    guestCwd: "/workspace/projects/demo",
  });
  return db;
}

function backend(state: {
  alive: boolean;
  starts: number;
  identityMatches?: boolean;
}): FlywheelToolBackend {
  return {
    async create() {
      throw new Error("not used");
    },
    async exec() {
      throw new Error("detailed execution required");
    },
    async execDetailed(_entityId, _command, args = []) {
      const command = args.slice(3);
      let output = "";
      let exitCode = 0;
      if (command[0] === "/bin/sh" && command[2]?.includes("nohup")) {
        state.starts++;
        state.alive = true;
        output = "4242 9001\n";
      } else if (command[0] === "/bin/sh" && command[2]?.includes("--screenshot")) {
        output = "";
      } else if (command[0] === "/bin/sh" && command.includes("4242") && command.includes("9001")) {
        exitCode = !state.alive ? 1 : state.identityMatches === false ? 42 : 0;
        if (command[2]?.includes("kill -9") && exitCode === 0) state.alive = false;
      } else if (command[0] === "tail") {
        output = "ready on 3000\n";
      } else if (command[0] === "curl") {
        output = '{"ok":true}\n__MARINA_HTTP_STATUS__=200\n';
      }
      return { output: `${output}__MARINA_EXIT_7f31c9__=${exitCode}\n`, events: [] };
    },
    async readFile() {
      const data = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      return {
        data,
        events: [],
        byteLength: data.length,
        sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
      };
    },
    async publish() {
      return "https://web.example";
    },
    async hibernate() {},
    async resume() {},
    async stop() {},
    status() {
      return {
        sessionId: "flywheel-session",
        sandboxId: "sandbox-service",
        image: "code:latest",
        keepAlive: true,
        state: "running",
      };
    },
  };
}
