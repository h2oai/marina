// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export type FederationTrust = "unverified" | "trusted" | "blocked";

export interface FederationPeerRow {
  world_id: string;
  name: string;
  base_url: string;
  public_key: string | null;
  trust_status: FederationTrust;
  manifest: string;
  first_seen_at: number;
  last_seen_at: number;
}

export function upsertFederationPeer(
  db: Database,
  input: {
    worldId: string;
    name: string;
    baseUrl: string;
    publicKey?: string | null;
    manifest: unknown;
  },
): FederationPeerRow {
  const now = Date.now();
  db.run(
    `INSERT INTO federation_peers
     (world_id,name,base_url,public_key,trust_status,manifest,first_seen_at,last_seen_at)
     VALUES (?,?,?,?, 'unverified',?,?,?)
     ON CONFLICT(world_id) DO UPDATE SET
       name=excluded.name,base_url=excluded.base_url,public_key=excluded.public_key,
       manifest=excluded.manifest,last_seen_at=excluded.last_seen_at`,
    [
      input.worldId,
      input.name,
      input.baseUrl,
      input.publicKey ?? null,
      JSON.stringify(input.manifest),
      now,
      now,
    ],
  );
  return getFederationPeer(db, input.worldId)!;
}

export function getFederationPeer(
  reader: Database,
  worldId: string,
): FederationPeerRow | undefined {
  return (
    (reader
      .query("SELECT * FROM federation_peers WHERE world_id=?")
      .get(worldId) as FederationPeerRow | null) ?? undefined
  );
}

export function listFederationPeers(reader: Database): FederationPeerRow[] {
  return reader
    .query("SELECT * FROM federation_peers ORDER BY name COLLATE NOCASE,world_id")
    .all() as FederationPeerRow[];
}

export function setFederationTrust(
  db: Database,
  worldId: string,
  trust: FederationTrust,
): FederationPeerRow | undefined {
  db.run("UPDATE federation_peers SET trust_status=? WHERE world_id=?", [trust, worldId]);
  return getFederationPeer(db, worldId);
}
