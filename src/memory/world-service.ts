// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import { MemoryService } from "./service";

const services = new WeakMap<MarinaDB, MemoryService>();
/** HTTP and resident commands share the same service and canonical records. */
export function worldMemoryService(db: MarinaDB): MemoryService {
  let service = services.get(db);
  if (!service) {
    service = new MemoryService(db);
    services.set(db, service);
  }
  return service;
}
