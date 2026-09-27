// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandCatalogEntry } from "../../../src/net/discovery-types";

export { type CommandForm, composeCommand, parseCommandForm } from "../../../src/sdk/command-forms";
/** Never infer an executable form from prose. Undeclared extensions retain raw input. */
export function commandForms(command: Pick<CommandCatalogEntry, "name" | "help" | "forms">) {
  return command.forms ?? [];
}
