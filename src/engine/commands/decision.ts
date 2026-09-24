// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { listApprovals, settleApproval } from "../../decisions/approvals";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { canonicalSub, unknownSubcommand } from "../parse-input";

const USAGE = "Usage: decision list | decision approve <token> | decision deny <token> [reason]";

/**
 * `decision` — settle decision-gate `ask` holds for agents you spawned
 * (src/decisions/approvals.ts). Rank 0 by design: authorization is ownership,
 * checked per request, and an agent can never approve its own call.
 */
export function decisionCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "decision",
    aliases: ["decisions"],
    help: `Approve or deny tool calls your agents' decision gate held for a person.\n${USAGE}`,
    minRank: 0,
    handler: (ctx: RoomContext, input) => {
      const me = deps.getEntity(input.entity);
      if (!me) return;
      const tokens = input.tokens;
      const sub = canonicalSub(tokens[0]?.toLowerCase() ?? "list", ["list", "approve", "deny"]);

      if (sub === "list") {
        const mine = listApprovals(me.name);
        if (mine.length === 0) {
          ctx.send(input.entity, "No tool calls are waiting for your approval.");
          return;
        }
        const now = Date.now();
        ctx.send(
          input.entity,
          [
            header("Held for your approval"),
            separator(),
            ...mine.map(
              (r) =>
                `  ${bold(r.token)} ${r.agentName} → ${r.summary}\n    ${dim(`${r.reason} · expires in ${Math.max(0, Math.round((r.expiresAt - now) / 1000))}s`)}`,
            ),
          ].join("\n"),
        );
        return;
      }

      if (sub === "approve" || sub === "deny") {
        const token = tokens[1];
        if (!token) {
          ctx.send(input.entity, USAGE);
          return;
        }
        const note = tokens.slice(2).join(" ") || undefined;
        const result = settleApproval(
          token,
          me.name,
          sub === "approve" ? "approved" : "denied",
          note,
        );
        if (!result.ok) {
          const why =
            result.error === "self"
              ? "An agent cannot approve its own tool call."
              : result.error === "not_owner"
                ? "Only the principal that spawned this agent can settle its request."
                : `No pending request ${token} (it may have expired).`;
          ctx.send(input.entity, why);
          return;
        }
        ctx.send(
          input.entity,
          `${sub === "approve" ? "Approved" : "Denied"} ${result.request.agentName}'s ${result.request.toolName} call (${token}).`,
        );
        return;
      }

      ctx.send(input.entity, unknownSubcommand("decision", sub, USAGE));
    },
  };
}
