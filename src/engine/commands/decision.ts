// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../auth/rate-limiter";
import { listApprovals, settleApproval } from "../../decisions/approvals";
import { getDecisionProvider } from "../../decisions/config";
import type { Evidence } from "../../decisions/evidence";
import { checkDraft, chooseOption } from "../../decisions/verify";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { canonicalSub, unknownSubcommand } from "../parse-input";

const USAGE = [
  "Usage: decision check [<request> |] <draft>   — score your own draft before you use it",
  "       decision choose <question> | <option> | <option> [| …]",
  "       decision list | decision approve <token> | decision deny <token> [reason]",
].join("\n");

/** Judge calls cost money: a per-entity budget (burst 10, then one every 6 s). */
const judgeLimiter = new RateLimiter({ maxTokens: 10, refillRate: 1, refillInterval: 6_000 });
const MAX_OPTIONS = 8;

/**
 * `decision` — the harness-decision primitive as a TOOL any entity can reach
 * for (`check`, `choose`), plus settling gate `ask` holds for agents you
 * spawned (src/decisions/approvals.ts). Rank 0 by design: the numbers only
 * inform — nothing here blocks, records or rewards on the caller's behalf, so
 * autonomy stays with the agent. Authorization for approvals is ownership,
 * checked per request, and an agent can never approve its own call.
 */
export function decisionCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  /** Resolve `note:N` / `task:N` / `chronicle:N` refs the caller may read. */
  resolveEvidence?: (actor: { name: string; id: string }, text: string) => Evidence[];
  logEvent?: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "decision",
    aliases: ["decisions"],
    help: `Cheap judgement calls: check your own draft, choose among options, or settle tool calls your agents' decision gate held for you.\n${USAGE}`,
    minRank: 0,
    handler: (ctx: RoomContext, input) => {
      const me = deps.getEntity(input.entity);
      if (!me) return;
      const tokens = input.tokens;
      const sub = canonicalSub(tokens[0]?.toLowerCase() ?? "list", [
        "list",
        "approve",
        "deny",
        "check",
        "choose",
      ]);

      if (sub === "check" || sub === "choose") {
        const provider = getDecisionProvider();
        if (!provider) {
          ctx.send(
            input.entity,
            "No decision backend is configured on this world (the operator sets MARINA_DECISIONS).",
          );
          return;
        }
        const rest = input.args.replace(/^\s*\S+\s*/, "");
        const parts = rest.split("|").map((part) => part.trim());
        if (!rest.trim() || (sub === "choose" && parts.filter(Boolean).length < 3)) {
          ctx.send(input.entity, USAGE);
          return;
        }
        if (!judgeLimiter.consume(input.entity)) {
          ctx.send(input.entity, "Too many judgement calls — wait a few seconds and try again.");
          return;
        }
        const emit = (event: {
          stage: "check" | "choose";
          verdict: string;
          reason: string;
          signals: Record<string, number | string>;
          provider?: string;
          model?: string;
          latencyMs?: number;
          costUsd?: number;
          error?: string;
        }) =>
          deps.logEvent?.({
            type: "agent_decision",
            name: me.name,
            subject: "self",
            ...event,
            timestamp: Date.now(),
          });

        if (sub === "choose") {
          const [question, ...options] = parts.filter(Boolean);
          const picked = options.slice(0, MAX_OPTIONS);
          return chooseOption(provider, question!, picked).then((r) => {
            emit({
              stage: "choose",
              verdict: r.choice ? "picked" : "unavailable",
              reason: r.error ?? `${picked.length} options`,
              signals: r.confidence === undefined ? {} : { confidence: r.confidence },
              ...meta(r),
            });
            if (!r.choice) {
              ctx.send(
                input.entity,
                `No pick — the judge is unavailable (${r.error ?? "no answer"}).`,
              );
              return;
            }
            const sure =
              r.confidence === undefined ? "" : ` (confidence ${r.confidence.toFixed(2)})`;
            ctx.send(
              input.entity,
              `Pick: ${bold(r.choice)}${sure}. The choice is yours to act on.`,
            );
          });
        }

        const [request, draft] =
          parts.length > 1 ? [parts[0], parts.slice(1).join(" | ")] : [undefined, parts[0]!];
        const evidence = deps.resolveEvidence?.({ name: me.name, id: me.id }, draft!) ?? [];
        return checkDraft(provider, draft!, evidence, request || undefined).then((v) => {
          emit({
            stage: "check",
            verdict: v.error ? "unavailable" : v.action === "accept" ? "meets" : "below",
            reason: v.reason,
            signals: { ...v.signals, evidence: evidence.length },
            ...meta(v),
          });
          if (v.error) {
            ctx.send(input.entity, `No check — the judge is unavailable (${v.error}).`);
            return;
          }
          const nums = Object.entries(v.signals)
            .map(([k, n]) => `${k} ${n.toFixed(2)}`)
            .join(" · ");
          const cited = evidence.length
            ? `grounding checked against ${evidence.map((e) => e.ref).join(", ")}`
            : "no evidence cited (cite note:N, task:N or chronicle:N to check grounding)";
          ctx.send(
            input.entity,
            [
              `${v.action === "accept" ? "Meets the bar" : "Below the bar"} — ${nums}`,
              dim(`quality is 0–2 · ${cited}. Advisory: what you do next is up to you.`),
            ].join("\n"),
          );
        });
      }

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

function meta(r: {
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}) {
  return {
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.latencyMs === undefined ? {} : { latencyMs: r.latencyMs }),
    ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
    ...(r.error ? { error: r.error } : {}),
  };
}
