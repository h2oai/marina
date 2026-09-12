// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SQLiteError } from "bun:sqlite";

/** Only SQLite result codes classify storage faults; never echo SQL or match
 * caller-controlled error text. Busy can retry; disk/permission faults need repair. */
export function memoryStorageFailure(error: unknown) {
  if (!(error instanceof SQLiteError)) return undefined;
  switch (error.errno & 255) {
    case 5:
    case 6:
      return {
        status: 503,
        code: "storage_busy",
        message: "Memory storage is busy; retry the same request key",
        retryAfter: "1",
      };
    case 13:
      return {
        status: 507,
        code: "storage_full",
        message: "Memory storage is full; operator capacity recovery is required",
      };
    case 3:
    case 8:
      return {
        status: 500,
        code: "storage_read_only",
        message: "Memory storage is not writable; operator repair is required",
      };
    case 10:
    case 14:
      return {
        status: 500,
        code: "storage_io_error",
        message:
          "Memory storage is unavailable; inspect storage and recover the receipt before retrying",
      };
    case 11:
    case 26:
      return {
        status: 500,
        code: "storage_corrupt",
        message: "Memory storage integrity failed; operator recovery is required",
      };
    default:
      return undefined;
  }
}
