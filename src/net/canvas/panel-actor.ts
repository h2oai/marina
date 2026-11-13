// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { principalKind } from "../../engine/challenges";
import type { Engine } from "../../engine/engine";
import type { PanelActorKind } from "../../engine/panel-authority";
import type { EntityId } from "../../types";
import { DESKTOP_OPERATOR_ENTITY_ID } from "../auth-middleware";

/**
 * Person or agent for an HTTP panel request, failing closed to "agent".
 *
 * - A session token resolves to its entity, judged by `principalKind` (an
 *   internal or MCP connection, a declared agent client, or an agent account
 *   is an agent).
 * - The desktop capability token is a person: the desktop app mints it at
 *   boot and only its own window sends it.
 * - The open-API sentinel is an agent. It is any loopback caller that sent no
 *   token, which includes an agent's own processes; the dashboard always
 *   sends its session token.
 */
export function httpPanelActorKind(engine: Engine, entityId: EntityId | undefined): PanelActorKind {
  if (!entityId) return "agent";
  if (entityId === DESKTOP_OPERATOR_ENTITY_ID) return "person";
  const entity = engine.entities.get(entityId);
  return entity ? principalKind(entity) : "agent";
}
