// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "./engine";
import { registerCoordinationCommands } from "./registrations/coordination";
import { registerGeneralCommands } from "./registrations/general";
import { registerMemoryCommands } from "./registrations/memory";
import { registerOperationCommands } from "./registrations/operations";

/** Explicit ordered composition; builtin ownership remains separate from extensions. */
export function registerBuiltinCommands(engine: Engine): void {
  registerGeneralCommands(engine);
  registerMemoryCommands(engine);
  registerCoordinationCommands(engine);
  registerOperationCommands(engine);
}
