// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
import { migrateEmptyTo } from "./schema-replay";

test("provider migration retains legacy allocation and isolates new-provider state over reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-binding-upgrade-"));
  const path = join(directory, "world.db");
  const owner = entityId("owner");
  try {
    const legacy = new Database(path);
    migrateEmptyTo(legacy, 182);
    legacy.run(`INSERT INTO flywheel_bindings(entity_id,session_id,sandbox_id,image,keep_alive,state,
      active_project_id,guest_cwd,created_at,updated_at) VALUES('owner','fw-session','fw-sandbox',
      'image',1,'running','fw-project','/workspace/fw',1,1)`);
    legacy.close();
    let db = new MarinaDB(path);
    expect(db.getFlywheelBinding(owner)).toMatchObject({
      provider_id: "flywheel",
      sandbox_id: "fw-sandbox",
      active_project_id: "fw-project",
      guest_cwd: "/workspace/fw",
    });
    db.saveFlywheelBinding({
      entityId: owner,
      providerId: "openshell",
      sessionId: "os-session",
      sandboxId: "os-sandbox",
      image: "os",
      keepAlive: true,
      state: "running",
    });
    db.updateFlywheelBinding(
      owner,
      { activeProjectId: "os-project", guestCwd: "/workspace/os" },
      "openshell",
    );
    db.close();
    db = new MarinaDB(path);
    expect(db.listFlywheelBindings()).toHaveLength(1);
    expect(db.listFlywheelBindings(null)).toHaveLength(2);
    expect(db.getFlywheelBinding(owner, "openshell")?.active_project_id).toBe("os-project");
    db.saveFlywheelBinding({
      entityId: owner,
      providerId: "openshell",
      sessionId: "os-next",
      sandboxId: "os-next",
      image: "os",
      keepAlive: true,
      state: "running",
    });
    expect(db.getFlywheelBinding(owner, "openshell")?.active_project_id).toBeNull();
    db.deleteFlywheelBinding(owner, "openshell");
    expect(db.getFlywheelBinding(owner)?.active_project_id).toBe("fw-project");
    db.close();
    const verify = new Database(path, { readonly: true });
    expect(verify.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    verify.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
