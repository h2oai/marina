// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as federationDb from "../db-federation";
import type { ExactKeys } from "./exact-keys";

/** Federation peers and world id (`db-federation.ts`). */
export interface FederationStore {
  getOrCreateWorldId(): string;
  upsertFederationPeer(
    input: Parameters<typeof federationDb.upsertFederationPeer>[1],
  ): federationDb.FederationPeerRow;
  getFederationPeer(worldId: string): federationDb.FederationPeerRow | undefined;
  listFederationPeers(): federationDb.FederationPeerRow[];
  setFederationTrust(
    worldId: string,
    trust: federationDb.FederationTrust,
  ): federationDb.FederationPeerRow | undefined;
}

/** Runtime mirror of `FederationStore`'s method names — the drift test compares it to the facade. */
export const FEDERATION_STORE_METHODS = [
  "getOrCreateWorldId",
  "upsertFederationPeer",
  "getFederationPeer",
  "listFederationPeers",
  "setFederationTrust",
] as const satisfies readonly (keyof FederationStore)[];

export const FEDERATION_STORE_COMPLETE: ExactKeys<
  FederationStore,
  typeof FEDERATION_STORE_METHODS
> = true;
