// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { MarinaDB } from "../persistence/database";

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,47}$/;

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const managers = new WeakMap<MarinaDB, WorldCollectiveManager>();

/**
 * One manager per database — REQUIRED for every caller (dashboard API and the
 * `marina-descend` command share it). Constructing a fresh manager per call is
 * incorrect: the constructor fails over live variant rows, `processes` starts
 * empty so `stop()` can't reach an already-spawned child, and the
 * already-running guard never fires.
 */
export function collectiveManager(db: MarinaDB, sourceRoot = PROJECT_ROOT): WorldCollectiveManager {
  let manager = managers.get(db);
  if (!manager) {
    manager = new WorldCollectiveManager(db, sourceRoot);
    managers.set(db, manager);
  }
  return manager;
}

export class WorldCollectiveManager {
  private readonly processes = new Map<string, Bun.Subprocess>();
  readonly sourceRoot: string;

  constructor(
    private readonly db: MarinaDB,
    sourceRoot = process.cwd(),
  ) {
    this.sourceRoot = resolve(sourceRoot);
    for (const variant of db.listWorldVariants()) {
      if (variant.status === "running" || variant.status === "starting") {
        db.updateWorldVariant(variant.id, {
          status: "failed",
          pid: null,
          lastError: "Parent process restarted; child liveness was not assumed.",
        });
      }
    }
  }

  sourceAvailable(): boolean {
    return existsSync(join(this.sourceRoot, "src", "main.ts"));
  }

  list() {
    return this.db.listWorldVariants();
  }

  create(input: {
    name: string;
    worldTemplate: string;
    hypothesis?: string;
    parentVariantId?: string;
    createdBy: string;
  }) {
    if (!SAFE_NAME.test(input.name)) {
      throw new Error("Variant name must be 2-48 letters, numbers, underscores, or hyphens.");
    }
    if (!SAFE_NAME.test(input.worldTemplate)) {
      throw new Error("World template has an invalid name.");
    }
    if ((input.hypothesis?.length ?? 0) > 2_000) {
      throw new Error("Variant hypothesis must be at most 2000 characters.");
    }
    if (!this.sourceAvailable()) {
      throw new Error("Marina source is not available at this process root.");
    }
    if (input.parentVariantId && !this.db.getWorldVariant(input.parentVariantId)) {
      throw new Error("Parent variant does not exist.");
    }
    const usedPorts = new Set(this.db.listWorldVariants().map((variant) => variant.ws_port));
    let wsPort = 34_000;
    while (usedPorts.has(wsPort)) wsPort += 10;
    if (wsPort > 65_500) throw new Error("No collective port range remains available.");
    const variantRoot = join(this.sourceRoot, "data", "collective", input.name);
    mkdirSync(join(variantRoot, "assets"), { recursive: true });
    return this.db.createWorldVariant({
      ...input,
      sourceRoot: this.sourceRoot,
      dbPath: join(variantRoot, "marina.db"),
      wsPort,
    });
  }

  async start(id: string) {
    const variant = this.db.getWorldVariant(id);
    if (!variant) throw new Error("Variant not found.");
    if (this.processes.has(id)) throw new Error("Variant is already running.");
    if (!this.sourceAvailable()) throw new Error("Marina source is not available.");
    this.db.updateWorldVariant(id, { status: "starting", pid: null, lastError: null });
    const assetsDir = join(dirname(variant.db_path), "assets");
    const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: variant.source_root,
      env: {
        ...process.env,
        MARINA_NAME: variant.name,
        MARINA_WORLD: variant.world_template,
        MARINA_COLLECTIVE_CHILD: "1",
        DB_PATH: variant.db_path,
        ASSETS_DIR: assetsDir,
        WS_PORT: String(variant.ws_port),
        MCP_PORT: String(variant.ws_port + 1),
        LOG_PORT: String(variant.ws_port + 2),
        // Telnet is plaintext + unauthenticated: descendants never get one
        // (explicit "0" also prevents inheriting the parent's TELNET_PORT,
        // which would collide across children).
        TELNET_PORT: "0",
        AGENT_AUTORESPAWN: "false",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    this.processes.set(id, child);
    this.db.updateWorldVariant(id, { status: "starting", pid: child.pid, lastError: null });
    void child.exited.then((exitCode) => {
      this.processes.delete(id);
      const current = this.db.getWorldVariant(id);
      if (current?.status === "running" || current?.status === "starting") {
        this.db.updateWorldVariant(id, {
          status: exitCode === 0 ? "stopped" : "failed",
          pid: null,
          lastError: exitCode === 0 ? null : `Child exited with code ${exitCode}.`,
        });
      }
    });
    const ready = await this.waitForReady(variant.ws_port, child);
    if (!ready) {
      child.kill();
      this.processes.delete(id);
      return this.db.updateWorldVariant(id, {
        status: "failed",
        pid: null,
        lastError: "Child did not become ready within 10 seconds.",
      })!;
    }
    return this.db.updateWorldVariant(id, { status: "running", pid: child.pid, lastError: null })!;
  }

  async stop(id: string) {
    const variant = this.db.getWorldVariant(id);
    if (!variant) throw new Error("Variant not found.");
    const child = this.processes.get(id);
    if (child) {
      child.kill();
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
      ]);
      if (!exited && child.exitCode === null) {
        child.kill(9);
        await child.exited;
      }
      this.processes.delete(id);
    }
    return this.db.updateWorldVariant(id, {
      status: "stopped",
      pid: null,
      lastError: null,
    })!;
  }

  promote(id: string, input: { rationale: string; evidenceRefs: string[]; promotedBy: string }) {
    const variant = this.db.getWorldVariant(id);
    if (!variant) throw new Error("Variant not found.");
    if (variant.status !== "running" && variant.status !== "stopped") {
      throw new Error("Only a running or stopped variant can be promoted.");
    }
    const rationale = input.rationale.trim();
    const evidenceRefs = [...new Set(input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))];
    if (rationale.length < 10 || rationale.length > 2_000) {
      throw new Error("Promotion rationale must be 10-2000 characters.");
    }
    if (evidenceRefs.length === 0 || evidenceRefs.length > 20) {
      throw new Error("Promotion requires 1-20 exact evidence references.");
    }
    const promoted = this.db.promoteWorldVariant(id, {
      rationale,
      evidenceRefs,
      promotedBy: input.promotedBy,
    })!;
    return promoted;
  }

  private async waitForReady(port: number, child: Bun.Subprocess): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/setup-status`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return true;
      } catch {
        // Expected while the child binds its ports and applies migrations.
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    return false;
  }
}
