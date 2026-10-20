// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process dispatch to residents for forecast parts
 * (`src/forecast/resident-part.ts`): `marina:<crew>` goes through the same
 * `routeToChannel` as `/v1` (no HTTP, no key); `role:<r>` resolves to the
 * live resident with that role and the highest standing (the `conduct
 * resolve` rule) and is routed to it, pinned, on an endpoint channel it
 * already serves — else on its own `model-resident-<name>` endpoint.
 *
 * The routed request carries the forecast's deadline and as-of fence, and
 * the reply names the resident that answered.
 */

import { getStanding } from "../../agent/standing";
import type { Engine } from "../../engine/engine";
import type { ResidentDispatcher, ResidentReply } from "../../forecast/resident-part";
import { routeToChannel } from "./routing";

/**
 * The live resident a `role:` assignee resolves to: that role, highest
 * standing (ties by name). `slot` picks the slot-th by standing, wrapping, so
 * parallel slots spread over the role's residents.
 */
export function residentForRole(
  engine: Engine,
  role: string,
  slot = 0,
  exclude?: string,
): { id: string; name: string } | undefined {
  const want = role.trim().toLowerCase();
  if (!want) return undefined;
  const ranked: Array<{ id: string; name: string; standing: number }> = [];
  for (const agent of engine.getOnlineAgents()) {
    const config = engine.db?.getAgentConfig(agent.name);
    if (config?.role?.toLowerCase() !== want) continue;
    if (exclude && agent.name.toLowerCase() === exclude.toLowerCase()) continue;
    ranked.push({
      id: agent.id,
      name: agent.name,
      standing: engine.db ? getStanding(engine.db, agent.id) : 0,
    });
  }
  ranked.sort((a, b) => b.standing - a.standing || a.name.localeCompare(b.name));
  if (ranked.length === 0) return undefined;
  const pick = ranked[Math.max(0, Math.floor(slot)) % ranked.length]!;
  return { id: pick.id, name: pick.name };
}

/**
 * The `marina:` model a resident answers on: an endpoint channel it is
 * already a member of, else its own `model-resident-<name>` (created and
 * joined once).
 */
export function residentEndpoint(engine: Engine, resident: { id: string; name: string }): string {
  const cm = engine.channelManager;
  if (!cm) throw new Error("Channel system unavailable");
  const served = cm
    .getEntityChannels(resident.id)
    .find((c) => c.name.startsWith("model-") && c.name.length > "model-".length);
  if (served) return `marina:${served.name.slice("model-".length)}`;
  const slug = resident.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const name = `model-resident-${slug}`;
  const channel = cm.getChannelByName(name) ?? cm.createChannel({ type: "model", name });
  if (!cm.isMember(channel.id, resident.id)) cm.addMember(channel.id, resident.id);
  return `marina:resident-${slug}`;
}

/** What the resident's own turns cost under a routed request (its trace). */
export function requestCostUsd(engine: Engine, requestId: string): number | undefined {
  let cost = 0;
  let seen = false;
  for (const event of engine.getEventLog()) {
    if (event.type !== "agent_turn_end" || event.traceId !== requestId) continue;
    if (typeof event.costUsd !== "number") continue;
    seen = true;
    cost += event.costUsd;
  }
  return seen ? cost : undefined;
}

export function inProcessResidentDispatcher(engine: Engine): ResidentDispatcher {
  return {
    async ask(spec, request): Promise<ResidentReply> {
      request.signal?.throwIfAborted();
      let model = spec;
      let pinTarget: string | undefined;
      if (spec.startsWith("role:")) {
        const resident = residentForRole(
          engine,
          spec.slice("role:".length),
          request.slot ?? 0,
          request.exclude,
        );
        if (!resident) throw new Error(`${spec}: no live resident has that role`);
        model = residentEndpoint(engine, resident);
        pinTarget = resident.id;
      } else if (!spec.startsWith("marina:")) {
        throw new Error(`${spec}: not a resident (marina:<crew> or role:<r>)`);
      }
      // The system prompt rides first: the perception clamp cuts from the end.
      const content = `${request.system.trim()}\n\n${request.user}`;
      const result = await routeToChannel(engine, model, content, {
        ...(request.deadlineMs ? { deadlineMs: request.deadlineMs } : {}),
        ...(request.evidenceCutoff ? { evidenceCutoff: request.evidenceCutoff } : {}),
        ...(pinTarget ? { pinTarget } : {}),
      });
      const costUsd = requestCostUsd(engine, result.requestId);
      return {
        text: result.content,
        ...(result.respondent ? { resident: result.respondent.name } : {}),
        requestId: result.requestId,
        ...(result.budgetForced ? { budgetForced: result.budgetForced.reason } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}
