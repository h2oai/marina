// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayRow } from "../db-gateways";
import type { ExactKeys } from "./exact-keys";

/** Gateways and bridges (`db-gateways.ts`). */
export interface GatewaysStore {
  createGateway(opts: { id: string; name: string; url: string; createdBy: string }): void;
  getGatewayByName(name: string): GatewayRow | undefined;
  listGateways(status?: string): GatewayRow[];
  updateGatewayStatus(id: string, status: string): void;
  deleteGateway(id: string): void;
  addGatewayBridge(gatewayId: string, channel: string): void;
  removeGatewayBridge(gatewayId: string, channel: string): void;
  listGatewayBridges(gatewayId: string): string[];
}

/** Runtime mirror of `GatewaysStore`'s method names — the drift test compares it to the facade. */
export const GATEWAYS_STORE_METHODS = [
  "createGateway",
  "getGatewayByName",
  "listGateways",
  "updateGatewayStatus",
  "deleteGateway",
  "addGatewayBridge",
  "removeGatewayBridge",
  "listGatewayBridges",
] as const satisfies readonly (keyof GatewaysStore)[];

export const GATEWAYS_STORE_COMPLETE: ExactKeys<GatewaysStore, typeof GATEWAYS_STORE_METHODS> =
  true;
