// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may act through a published panel, and who may give a panel buttons
 * that act. People press panel buttons; an agent may build a panel but never
 * press one, and a panel an agent wrote or last revised carries no
 * operations — its buttons would otherwise run commands with the clicking
 * person's authority under a label the agent chose. The clients' confirm
 * review is a courtesy; these rules are enforced on the server.
 */
import type { MarinaDB } from "../persistence/database";

export type PanelActorKind = "person" | "agent";

export const PANEL_PERSON_REQUIRED =
  "Only a person may act through a panel. Agents read panels and act with world commands.";

export const AGENT_PANEL_OPERATIONS_REFUSED =
  "Panel refused: a panel an agent writes carries no `operation`. Remove each operation; a person may add them.";

export const AGENT_PANEL_OPERATIONS_INERT =
  "This panel was last written by an agent, so its buttons run nothing. A person may revise it to add actions.";

/** Whether a validated panel document has any button operation (any component, known or not). */
export function panelHasOperations(document: unknown): boolean {
  const components =
    document && typeof document === "object" && "components" in document
      ? (document as { components: unknown }).components
      : undefined;
  return (
    Array.isArray(components) &&
    components.some(
      (component) =>
        !!component &&
        typeof component === "object" &&
        (component as { operation?: unknown }).operation !== undefined,
    )
  );
}

/** The refusal for an agent writing a panel with operations, else null. */
export function agentPanelOperationsRefusal(
  document: unknown,
  writer: PanelActorKind,
): string | null {
  return writer === "agent" && panelHasOperations(document) ? AGENT_PANEL_OPERATIONS_REFUSED : null;
}

/** An account the world runs as an agent: an agent config or an agent principal. */
export function isAgentAccountName(
  db: Pick<MarinaDB, "getAgentConfig" | "getPrincipal">,
  name: string,
): boolean {
  return !!db.getAgentConfig(name) || !!db.getPrincipal("agent", name);
}

/**
 * The account that last wrote a panel's definition: the editor a revision
 * recorded, else the node's creator. Panels written before this rule have no
 * editor, so their creator stands for them.
 */
export function panelLastWriter(
  node: { creator_name: string },
  data: Record<string, unknown>,
): string {
  return typeof data.panelEditor === "string" && data.panelEditor
    ? data.panelEditor
    : node.creator_name;
}
