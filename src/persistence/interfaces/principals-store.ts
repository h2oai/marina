// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as principalsDb from "../db-principals";
import type { ExactKeys } from "./exact-keys";

/** Principals and workload credentials (`db-principals.ts`). */
export interface PrincipalsStore {
  ensurePrincipal(
    input: Parameters<typeof principalsDb.ensurePrincipal>[1],
  ): principalsDb.PrincipalRow;
  getPrincipal(
    type: principalsDb.PrincipalType,
    displayName: string,
    homeWorld?: string,
  ): principalsDb.PrincipalRow | undefined;
  listPrincipals(): principalsDb.PrincipalRow[];
  setPrincipalStatus(principalId: string, status: principalsDb.PrincipalStatus): boolean;
  issueWorkloadCredential(
    principalId: string,
    ttlMs?: number,
  ): principalsDb.IssuedWorkloadCredential;
  verifyWorkloadCredential(token: string): principalsDb.PrincipalRow | undefined;
  revokeWorkloadCredential(credentialId: string): boolean;
}

/** Runtime mirror of `PrincipalsStore`'s method names — the drift test compares it to the facade. */
export const PRINCIPALS_STORE_METHODS = [
  "ensurePrincipal",
  "getPrincipal",
  "listPrincipals",
  "setPrincipalStatus",
  "issueWorkloadCredential",
  "verifyWorkloadCredential",
  "revokeWorkloadCredential",
] as const satisfies readonly (keyof PrincipalsStore)[];

export const PRINCIPALS_STORE_COMPLETE: ExactKeys<
  PrincipalsStore,
  typeof PRINCIPALS_STORE_METHODS
> = true;
