// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceRuntime } from "../src/coding/local-workspace";
import {
  CodingProjectManager,
  validateProjectArchiveManifest,
} from "../src/coding/project-manager";
import type { SandboxProvider } from "../src/coding/sandbox-provider";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { cleanupDb, FAKE_SANDBOX_IDENTITY, tempDbPath } from "./helpers";

const DB_PATH = tempDbPath("test_coding_projects.db");
const OWNER = entityId("entity-1");

afterEach(() => {
  cleanupDb(DB_PATH);
  __setDnsResolverForTest(null);
});

describe("CodingProjectManager", () => {
  test("rejects unsafe, special, oversized, and suspicious archive manifests", () => {
    const regular = "-rw-r--r-- 0/0 12 2026-08-05 00:00 ./src/app.ts";
    expect(validateProjectArchiveManifest(regular, 12)).toEqual({
      expandedBytes: 12,
      memberCount: 1,
    });
    expect(() =>
      validateProjectArchiveManifest(
        "lrwxrwxrwx 0/0 0 2026-08-05 00:00 ./escape -> ../../outside",
        10,
      ),
    ).toThrow("special file");
    expect(() =>
      validateProjectArchiveManifest("-rw-r--r-- 0/0 1 2026-08-05 00:00 ../../outside", 10),
    ).toThrow("unsafe path");
    expect(() =>
      validateProjectArchiveManifest("-rw-r--r-- 0/0 33554433 2026-08-05 00:00 ./large.bin", 1024),
    ).toThrow("member exceeds");
    expect(() =>
      validateProjectArchiveManifest("-rw-r--r-- 0/0 10001 2026-08-05 00:00 ./bomb.txt", 100),
    ).toThrow("compression-ratio");
  });

  test("materializes an empty project and restores its active metadata after restart", async () => {
    const db = databaseWithBinding();
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const manager = new CodingProjectManager(db, unusedLocal(), backend(calls));

    const project = await manager.init(OWNER, "demo-app");
    expect(project).toMatchObject({
      entity_id: OWNER,
      guest_path: "/workspace/projects/demo-app",
      name: "demo-app",
      source_type: "empty",
    });
    expect(calls.map((call) => call.command)).toEqual([
      ["mkdir", "-p", "/workspace/projects/demo-app"],
      ["git", "init", "-b", "main"],
    ]);
    db.close();

    const reopened = new MarinaDB(DB_PATH);
    const restored = new CodingProjectManager(reopened, unusedLocal(), backend([])).active(OWNER);
    expect(restored?.id).toBe(project.id);
    expect(reopened.listFlywheelBindings()[0]).toMatchObject({
      active_project_id: project.id,
      guest_cwd: project.guest_path,
    });
    reopened.close();
  });

  test("clones only sanitized public HTTPS sources into deterministic guest paths", async () => {
    const db = databaseWithBinding();
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const manager = new CodingProjectManager(db, unusedLocal(), backend(calls));
    // The clone guard resolves names; stub DNS so the test never needs the network.
    __setDnsResolverForTest(async () => ["140.82.112.3"]);

    const project = await manager.clone(OWNER, "https://github.com/h2oai/Marina.git?token=nope");
    expect(project.source_locator).toBe("https://github.com/h2oai/Marina.git");
    expect(project.guest_path).toBe("/workspace/projects/marina");
    expect(calls[1]?.command).toEqual([
      "git",
      "clone",
      "--",
      "https://github.com/h2oai/Marina.git",
      "/workspace/projects/marina",
    ]);
    await expect(manager.clone(OWNER, "https://user:secret@example.com/repo.git")).rejects.toThrow(
      "embedded credentials",
    );
    await expect(manager.clone(OWNER, "https://127.0.0.1/repo.git")).rejects.toThrow(
      "private network",
    );
    db.close();
  });

  test("refuses every local, private, link-local and metadata spelling of a clone host", async () => {
    const db = databaseWithBinding();
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const manager = new CodingProjectManager(db, unusedLocal(), backend(calls));
    __setDnsResolverForTest(async (host) =>
      host === "internal.example" ? ["10.1.2.3"] : ["93.184.216.34"],
    );
    for (const url of [
      "https://localhost/repo.git",
      "https://127.0.0.1/repo.git",
      "https://[::1]/repo.git",
      "https://[::ffff:127.0.0.1]/repo.git",
      "https://10.0.0.5/repo.git",
      "https://172.16.0.1/repo.git",
      "https://192.168.1.10/repo.git",
      "https://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/repo.git",
      "https://internal.example/repo.git", // a public-looking name that resolves privately
    ]) {
      await expect(manager.clone(OWNER, url)).rejects.toThrow("private network");
    }
    // Nothing reached the sandbox.
    expect(calls.some((call) => call.command[0] === "git")).toBe(false);
    db.close();
  });

  test("blocks dirty switching until a complete tracked-work export is recorded", async () => {
    const db = databaseWithBinding();
    let status = "## main\n";
    const manager = new CodingProjectManager(
      db,
      unusedLocal(),
      backend(
        [],
        () => status,
        () => "diff --git a/src/app.ts b/src/app.ts\n",
      ),
    );
    const first = await manager.init(OWNER, "first");
    const second = await manager.init(OWNER, "second");
    await manager.switch(OWNER, first.id);

    status = "## main\n M src/app.ts\n";
    await expect(manager.switch(OWNER, second.id)).rejects.toThrow("unexported changes");
    const inspected = await manager.diff(OWNER, first);
    expect(inspected.diff.content).toContain("diff --git");
    expect(db.getCodingProject(first.id)?.has_unexported_changes).toBe(1);
    const exported = await manager.exportPatch(OWNER, first);
    expect(exported.content).toContain("diff --git");
    await expect(manager.switch(OWNER, second.id)).resolves.toMatchObject({ id: second.id });

    status = "## main\n";
    await manager.switch(OWNER, first.id);
    status = "## main\n?? secret.bin\n";
    expect((await manager.diff(OWNER, first)).diff.untrackedPaths).toEqual(["secret.bin"]);
    await expect(manager.exportPatch(OWNER, first)).rejects.toThrow("untracked files");
    db.close();
  });

  test("exports and atomically imports bounded complete project archives", async () => {
    const db = databaseWithBinding();
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const archive = Uint8Array.from([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    const manager = new CodingProjectManager(
      db,
      unusedLocal(),
      backend(calls, undefined, undefined, archive),
    );
    const original = await manager.init(OWNER, "original");

    const exported = await manager.exportArchive(OWNER, original);
    expect(exported.data).toEqual(archive);
    const imported = await manager.importArchive(OWNER, "restored", exported.data);
    expect(imported).toMatchObject({
      guest_path: "/workspace/projects/restored",
      source_type: "archive",
    });
    expect(calls.some((call) => call.command[0] === "tar" && call.command[1] === "-czf")).toBe(
      true,
    );
    expect(calls.some((call) => call.command[0] === "tar" && call.command[1] === "-xzf")).toBe(
      true,
    );
    db.close();
  });

  test("deletes only owned current-sandbox projects and reconciles stale metadata", async () => {
    const db = databaseWithBinding();
    const calls: Array<{ command: string[]; cwd?: string }> = [];
    const manager = new CodingProjectManager(db, unusedLocal(), backend(calls));
    const project = await manager.init(OWNER, "disposable");
    await expect(manager.delete(OWNER, project.id)).resolves.toMatchObject({ id: project.id });
    expect(db.getCodingProject(project.id)).toBeNull();
    expect(calls.some((call) => call.command.join(" ").includes("rm -rf --"))).toBe(true);

    const stale = db.createCodingProject({
      id: "project-stale",
      entityId: OWNER,
      sandboxId: "sandbox-replaced",
      name: "stale",
      sourceType: "empty",
      guestPath: "/workspace/projects/stale",
    });
    expect(manager.reconcile(OWNER)).toEqual({ removed: [stale.id] });
    expect(db.getCodingProject(stale.id)).toBeNull();
    db.close();
  });
});

function databaseWithBinding(): MarinaDB {
  const db = new MarinaDB(DB_PATH);
  db.saveFlywheelBinding({
    entityId: OWNER,
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    image: "code:latest",
    keepAlive: true,
    state: "running",
  });
  return db;
}

function unusedLocal(): WorkspaceRuntime {
  return {
    displayRoot: () => "/unused",
    list: () => [],
    read: () => "",
    resolve: () => "/unused",
    search: () => [],
    async run() {
      throw new Error("local execution must not run");
    },
  } as unknown as WorkspaceRuntime;
}

function backend(
  calls: Array<{ command: string[]; cwd?: string }>,
  getStatus: () => string = () => "## main\n",
  getDiff: () => string = () => "",
  archive: Uint8Array = Uint8Array.from([0x1f, 0x8b]),
): SandboxProvider {
  return {
    ...FAKE_SANDBOX_IDENTITY,
    async create() {
      throw new Error("not used");
    },
    async exec() {
      throw new Error("detailed execution required");
    },
    async execDetailed(_entityId, _command, args = [], cwd) {
      const command = args.slice(3);
      calls.push({ command, cwd });
      let output = "";
      const exitCode = 0;
      if (command[0] === "git" && command[1] === "status") output = getStatus();
      if (command[0] === "git" && command[1] === "rev-parse") {
        output = "0123456789abcdef\n";
      }
      if (command[0] === "git" && command[1] === "diff") output = getDiff();
      if (command[0] === "tar" && command[1] === "-tvzf") {
        output =
          "drwxr-xr-x 0/0 0 2026-08-05 00:00 ./\n-rw-r--r-- 0/0 7 2026-08-05 00:00 ./README.md\n";
      }
      return { output: `${output}__MARINA_EXIT_7f31c9__=${exitCode}\n`, events: [] };
    },
    async readFile() {
      return {
        data: archive,
        events: [],
        byteLength: archive.length,
        sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
      };
    },
    async writeFile(_entityId, _guestPath, data) {
      expect(data).toEqual(archive);
      return {
        byteLength: data.length,
        sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
      };
    },
    async publish() {
      throw new Error("not used");
    },
    async hibernate() {},
    async resume() {},
    async stop() {},
    status() {
      return {
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        image: "code:latest",
        keepAlive: true,
        state: "running",
      };
    },
  };
}
