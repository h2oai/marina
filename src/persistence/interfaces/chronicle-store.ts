// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as chronicleDb from "../db-chronicle";
import type { ExactKeys } from "./exact-keys";

/** Chronicle (`db-chronicle.ts`). */
export interface ChronicleStore {
  appendChronicle(entry: chronicleDb.InsertChronicle): number;
  queryChronicle(q?: chronicleDb.ChronicleQuery): chronicleDb.ChronicleEntry[];
  getChronicleEntry(id: number): chronicleDb.ChronicleEntry | undefined;
  getChronicleCorrectionsFor(id: number): chronicleDb.ChronicleEntry[];
  getChronicleCount(): number;
}

/** Runtime mirror of `ChronicleStore`'s method names — the drift test compares it to the facade. */
export const CHRONICLE_STORE_METHODS = [
  "appendChronicle",
  "queryChronicle",
  "getChronicleEntry",
  "getChronicleCorrectionsFor",
  "getChronicleCount",
] as const satisfies readonly (keyof ChronicleStore)[];

export const CHRONICLE_STORE_COMPLETE: ExactKeys<ChronicleStore, typeof CHRONICLE_STORE_METHODS> =
  true;
