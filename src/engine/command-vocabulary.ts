// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandVocabulary } from "./commands/knowledge-hygiene";
import type { Engine } from "./engine";

/**
 * Live builtins plus the loaded rooms' own command names: what a knowledge
 * audit judges command references against (`pool … audit`, `guide audit`,
 * the work pulse).
 */
export function commandVocabulary(engine: Engine): CommandVocabulary {
  return {
    commands: engine.commands.allBuiltins(),
    knownCommands: engine.rooms.all().flatMap((room) => Object.keys(room.module.commands ?? {})),
  };
}
