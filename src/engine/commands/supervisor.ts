// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { WorldSupervisor, WorldSupervisorDb } from "../../routing/world-supervisor";
import { resolveSupervisorRoot } from "../../routing/world-supervisor";
import type { CommandDef, Entity } from "../../types";
import { getErrorMessage } from "../errors";
import { canonicalSub, parseModifiers, unknownSubcommand } from "../parse-input";

const USAGE = [
  "Usage: supervisor [status]",
  "       supervisor start [root:<dir>] [label:<name>]   — run the native agent supervisor in this server",
  "       supervisor stop",
].join("\n");
const SUBS = ["status", "start", "stop"];

const HELP = `The native agent supervisor (Claude Code, Codex, pi), run by the server itself: the same supervisor as \`marina supervise\`, with no process to keep open. A person starts it in a configured code root (MARINA_CODE_ROOTS); it holds a routing-only supervision credential issued to that person (renewed, revoked on stop). Launch agents from Dashboard → Workspace → Streams: each becomes its own world account (supervised resident) and each launch still needs code.exec and agent.spawn. Native agents start with a minimal environment (no server keys) and use their own CLI logins. It survives a restart (MARINA_SUPERVISOR_AUTOSTART=resume) until stopped.
${USAGE}`;

export interface SupervisorCommandDeps {
  db: WorldSupervisorDb;
  supervisor: WorldSupervisor;
  getEntity: (id: string) => Entity | undefined;
  /** An agent drives this entity (internal/MCP/declared agent, or an agent account). */
  isAgent: (id: string) => boolean;
  /** The transport the entity is connected over (`telnet` refuses start). */
  getConnectionProtocol?: (id: string) => string | undefined;
  isOperator: (entity: Entity) => boolean;
}

/**
 * `supervisor` — start, stop and inspect the in-world native agent supervisor
 * (`src/routing/world-supervisor.ts`). A person only: agents never launch it.
 * The router's `agent.spawn` gate guards start and stop; `status` reads.
 */
export function supervisorCommand(deps: SupervisorCommandDeps): CommandDef {
  return {
    usage: [
      { syntax: "supervisor [status]", effect: "read" },
      { syntax: "supervisor start [root:<dir>] [label:<name>]", effect: "execute" },
      { syntax: "supervisor stop", effect: "write" },
    ],
    name: "supervisor",
    category: "Agents",
    minRank: 5,
    gate: "agent.spawn",
    readOnlyForm: (input) =>
      canonicalSub(input.tokens[0]?.toLowerCase() ?? "status", SUBS) === "status",
    help: HELP,
    handler: async (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const reply = (text: string) => ctx.send(input.entity, text);
      const sub = canonicalSub(input.tokens[0]?.toLowerCase() ?? "status", SUBS);

      if (sub === "status") {
        const status = deps.supervisor.status();
        if (!status.running)
          return reply(
            [
              "In-world supervisor: not running.",
              ...(status.failure ? [`Last stop: ${status.failure}`] : []),
              dim("Start it: supervisor start [root:<dir>]"),
            ].join("\n"),
          );
        return reply(
          [
            header("In-world supervisor"),
            separator(),
            `  ${bold("owner")}:    ${status.owner}`,
            `  ${bold("root")}:     ${status.root}`,
            `  ${bold("label")}:    ${status.label}`,
            `  ${bold("agents")}:   ${status.adapters?.join(", ")}`,
            `  ${bold("session")}:  ${status.sessionId}`,
            ...(status.lastError ? [`  ${bold("sync")}:     ${status.lastError}`] : []),
            "",
            dim("Launch agents from Dashboard → Workspace → Streams. Stop: supervisor stop"),
          ].join("\n"),
        );
      }

      // People supervise; an agent never starts or stops the supervisor.
      if (deps.isAgent(entity.id))
        return reply("Only a person may run the supervisor; an agent never starts or stops it.");

      if (sub === "start") {
        // Plaintext, unauthenticated telnet never starts host processes (as Code Mode).
        if (deps.getConnectionProtocol?.(entity.id) === "telnet")
          return reply(
            "The supervisor runs host processes; it is not available over telnet. Use marina connect or the dashboard.",
          );
        const parsed = parseModifiers(input.tokens.slice(1), {
          root: { type: "string" },
          label: { type: "string" },
        });
        if (parsed.errors.length || parsed.rest.length)
          return reply(parsed.errors[0] ?? `Unexpected: ${parsed.rest.join(" ")}\n${USAGE}`);
        const root = resolveSupervisorRoot(parsed.raw.root);
        if ("error" in root) return reply(`supervisor start: ${root.error}`);
        try {
          const status = await deps.supervisor.start({
            db: deps.db,
            owner: entity.name,
            root: root.root,
            ...(parsed.raw.label ? { label: parsed.raw.label } : {}),
          });
          return reply(
            `Supervisor started in ${status.root} (${status.adapters?.join(", ")}). Launch agents from Dashboard → Workspace → Streams; each becomes its own resident. Stop: supervisor stop`,
          );
        } catch (error) {
          return reply(`supervisor start: ${getErrorMessage(error)}`);
        }
      }

      if (sub === "stop") {
        const status = deps.supervisor.status();
        if (!status.running) return reply("The in-world supervisor is not running.");
        if (status.owner !== entity.name && !deps.isOperator(entity))
          return reply(
            `The supervisor belongs to ${status.owner}; only they or an operator stop it.`,
          );
        await deps.supervisor.stop();
        return reply("Supervisor stopped: its agents stopped and its credential was revoked.");
      }

      return reply(unknownSubcommand("supervisor", input.tokens[0], USAGE));
    },
  };
}
