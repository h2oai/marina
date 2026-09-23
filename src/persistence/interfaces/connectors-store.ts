// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorRow } from "../db-connectors";
import type { ExactKeys } from "./exact-keys";

/** Connectors (`db-connectors.ts`). */
export interface ConnectorsStore {
  createConnector(conn: {
    id: string;
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string;
    createdBy: string;
  }): void;
  getConnector(id: string): ConnectorRow | undefined;
  getConnectorByName(name: string): ConnectorRow | undefined;
  listConnectors(status?: string): ConnectorRow[];
  updateConnectorStatus(id: string, status: string): void;
  updateConnectorAuth(id: string, authType: string, authData: string): void;
  deleteConnector(id: string): void;
}

/** Runtime mirror of `ConnectorsStore`'s method names — the drift test compares it to the facade. */
export const CONNECTORS_STORE_METHODS = [
  "createConnector",
  "getConnector",
  "getConnectorByName",
  "listConnectors",
  "updateConnectorStatus",
  "updateConnectorAuth",
  "deleteConnector",
] as const satisfies readonly (keyof ConnectorsStore)[];

export const CONNECTORS_STORE_COMPLETE: ExactKeys<
  ConnectorsStore,
  typeof CONNECTORS_STORE_METHODS
> = true;
