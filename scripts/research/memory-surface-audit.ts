// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Wider-surface audit: records unresolved boundaries, never treats collection as a pass.
 * Synthetic identities, a disposable database and real authenticated route handlers. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine/engine";
import { handleDashboardApi } from "../../src/net/dashboard-api";
import { MarinaDB } from "../../src/persistence/database";
import { roomId } from "../../src/types";
import { MockConnection, makeTestRoom } from "../../test/helpers";

const directory = mkdtempSync(join(tmpdir(), "marina-memory-surfaces-"));
const db = new MarinaDB(join(directory, "surface.db"));
const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
engine.registerRoom(roomId("test/start"), makeTestRoom());

try {
  function login(name: string) {
    const connection = new MockConnection(name);
    engine.addConnection(connection);
    const session = engine.login(connection.id, name);
    if ("error" in session) throw new Error(session.error);
    return { ...session, entity: connection.entity! };
  }
  const alice = login("SurfaceAlice");
  const bob = login("SurfaceBob");
  const secret = db.createNote("SurfaceAlice", "PRIVATE_SURFACE_SENTINEL");
  const own = db.createNote("SurfaceBob", "owned source with a legacy link");
  db.createNoteLink(own, secret, "related_to");
  db.createGroup({ id: "restricted", name: "restricted", leaderId: alice.entity });
  db.createMemoryPool("restricted", "restricted", "SurfaceAlice", "restricted");
  const groupNote = db.addPoolNote("restricted", "SurfaceAlice", "GROUP_SURFACE_SENTINEL");
  const cases = [
    {
      id: "S01",
      path: `/api/notes/${secret}`,
      marker: "PRIVATE_SURFACE_SENTINEL",
      invariant: "Direct personal note lookup denies another resident",
    },
    {
      id: "S02",
      path: "/api/graph",
      marker: "PRIVATE_SURFACE_SENTINEL",
      invariant: "Global graph does not disclose private notes to ordinary residents",
    },
    {
      id: "S03",
      path: `/api/notes/${groupNote}`,
      marker: "GROUP_SURFACE_SENTINEL",
      invariant: "Dashboard note lookup enforces group membership",
    },
    {
      id: "S04",
      path: `/api/notes/${own}`,
      marker: "PRIVATE_SURFACE_SENTINEL",
      invariant: "Hydrated links do not expose unreadable endpoints",
    },
  ];
  const observations = [];
  for (const item of cases) {
    const url = new URL(item.path, "http://surface.invalid");
    const request = new Request(url, { headers: { Authorization: `Bearer ${bob.token}` } });
    const response = await handleDashboardApi(request, url, "GET", engine, db);
    if (!response) throw new Error(`Unhandled dashboard route: ${item.path}`);
    const content = await response.text();
    observations.push({
      id: item.id,
      desired_invariant: item.invariant,
      satisfied_in_fixture: !content.includes(item.marker),
      observed: {
        route: item.path,
        status: response.status,
        exposes_marker: content.includes(item.marker),
      },
    });
  }
  console.log(
    JSON.stringify(
      {
        purpose:
          "Authenticated dashboard memory boundary observations; unresolved release blockers",
        observed_at: new Date().toISOString(),
        observations,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true });
}
