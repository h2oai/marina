// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `challenge` — answer the asks that refusals raise (src/engine/challenges.ts).
 * The requester's owner and the operators — people, never agents — see held actions here and approve them
 * once, for good (`always` grants the gate), or deny them. The requester never
 * waits: approval re-runs the action and delivers its output.
 */

import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity } from "../../types";
import {
  agentPrincipalReason,
  CHALLENGE_SUMMARY_WINDOW_MS,
  type Challenge,
  type ChallengeAnswer,
  challengeSummary,
  EARNED_MIN_N,
  EARNED_MIN_PRECISION,
  judgeMode,
  listAnswerable,
  listJudgeRecords,
  listRaisedBy,
  settleChallenge,
} from "../challenges";
import { canonicalSub, unknownSubcommand } from "../parse-input";

const USAGE = `challenge — held actions waiting on an answer.
Usage:
  challenge                               — what you can answer + what you asked
  challenge approve <token> [once|always] [note]
                                          — run it now; always also grants its gate
  challenge deny <token> [reason]         — decline; the requester is told why
  challenge stats                         — the judge's record per gate vs people's answers
  challenge summary [days]                — what happened to recent holds (default 7 d):
                                            answered, denied, expired unanswered, by class
People answer: the owner of the agent that asked (the person who started its
spawn chain) or an operator — only for what they could do themselves. Agents
never answer another's hold, and nobody answers their own ask. Offline
approvers find holds here and in \`ops inbox\`; holds survive a restart. Set
MARINA_OPS_NOTIFY (a webhook URL or cmd:<program>) to be told the moment one opens.`;

function line(c: Challenge, now: number): string {
  const left = Math.max(0, Math.round((c.expiresAt - now) / 60_000));
  return `  ${bold(c.token)} ${c.requesterName} → ${c.summary}\n    ${dim(`${c.reason} · ${left} min left`)}`;
}

export function challengeCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "challenge",
    aliases: ["challenges"],
    category: "Civic",
    minRank: 0,
    help: USAGE,
    usage: [
      { syntax: "challenge", effect: "read" },
      { syntax: "challenge approve <token> [once|always] [note]", effect: "execute" },
      { syntax: "challenge deny <token> [reason]", effect: "write" },
      { syntax: "challenge stats", effect: "read" },
      { syntax: "challenge summary [days]", effect: "read" },
    ],
    handler: (ctx, input) => {
      const me = deps.getEntity(input.entity);
      if (!me) return;
      const sub = canonicalSub(input.tokens[0]?.toLowerCase() ?? "list", [
        "list",
        "approve",
        "deny",
        "stats",
        "summary",
      ]);

      if (sub === "summary") {
        const days = Number(input.tokens[1]);
        const windowMs =
          Number.isFinite(days) && days > 0
            ? Math.min(days, 90) * 86_400_000
            : CHALLENGE_SUMMARY_WINDOW_MS;
        const s = challengeSummary(Date.now(), windowMs);
        if (!s) {
          ctx.send(input.entity, "No challenge history (this world keeps no database).");
          return;
        }
        const window = `${Math.round(windowMs / 86_400_000)} d`;
        const lines = [
          header(`Challenges — last ${window}`),
          separator(),
          `  ${s.total} held · ${s.approved} approved · ${s.denied} denied · ${bold(String(s.unanswered))} expired unanswered · ${s.open} open`,
        ];
        if (s.operatorOnly)
          lines.push(
            dim(
              `  ${s.operatorOnly} had no owner — only an operator (a person at rank 9) could answer.`,
            ),
          );
        if (s.byClass.length) {
          lines.push("", dim("By class (unanswered / held):"));
          for (const c of s.byClass.slice(0, 10))
            lines.push(`  ${c.class.padEnd(28)} ${c.unanswered}/${c.total}`);
        }
        if (s.byRequester.length) {
          lines.push("", dim("By requester (unanswered / held):"));
          for (const r of s.byRequester.slice(0, 10))
            lines.push(`  ${r.name.padEnd(28)} ${r.unanswered}/${r.total}`);
        }
        if (s.unanswered > 0)
          lines.push(
            "",
            dim(
              "Nobody saw these in time. Set MARINA_OPS_NOTIFY to push new holds to a webhook or a desktop notifier.",
            ),
          );
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "stats") {
        const records = listJudgeRecords();
        const mode = judgeMode();
        const lines = [
          header("Challenge judge"),
          separator(),
          dim(
            `MARINA_CHALLENGE_JUDGE=${mode} · a class is earned after ${EARNED_MIN_N}+ allow calls people approved at ≥ ${Math.round(EARNED_MIN_PRECISION * 100)}% (95% lower bound); core gates never`,
          ),
        ];
        if (records.length === 0) {
          lines.push(
            mode === "off"
              ? "No judged answers yet. Set MARINA_CHALLENGE_JUDGE=observe to start measuring."
              : "No judged answers yet — every answered challenge adds one.",
          );
        }
        for (const r of records) {
          lines.push(
            `  ${bold(r.class)} ${r.earned ? "earned" : "not earned"} · allow ${r.allowApproved}/${r.allowSaid} approved (≥ ${(r.precisionLower * 100).toFixed(0)}%) · hold ${r.holdDenied}/${r.holdSaid} denied`,
          );
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "list") {
        const now = Date.now();
        const answerable = listAnswerable(me);
        const mine = listRaisedBy(me.id);
        if (answerable.length === 0 && mine.length === 0) {
          ctx.send(input.entity, "No open challenges.");
          return;
        }
        const out: string[] = [];
        if (answerable.length) {
          out.push(
            header("Waiting on your answer"),
            separator(),
            ...answerable.map((c) => line(c, now)),
          );
        }
        if (mine.length) {
          out.push(header("You asked"), separator(), ...mine.map((c) => line(c, now)));
        }
        ctx.send(input.entity, out.join("\n"));
        return;
      }

      if (sub === "approve" || sub === "deny") {
        const token = input.tokens[1];
        if (!token) {
          ctx.send(input.entity, USAGE);
          return;
        }
        let rest = input.tokens.slice(2);
        let answer: ChallengeAnswer = "deny";
        if (sub === "approve") {
          const mode = rest[0]?.toLowerCase();
          answer = mode === "always" ? "always" : "once";
          if (mode === "always" || mode === "once") rest = rest.slice(1);
        }
        const note = rest.join(" ").trim() || undefined;
        const result = settleChallenge(token, me, answer, note);
        if (!result.ok) {
          const why: Record<typeof result.error, string> = {
            self: "You can't answer your own ask, or one raised by the agent that spawned you.",
            agent: `People answer held actions, agents don't (whatever their rank): the requester's owner or an operator decides. ${agentPrincipalReason(me)}`,
            not_authorized:
              "Only the requester's creator or an admin can answer it — and only for what they could do themselves.",
            absent:
              result.detail ?? "The requester is not in the world right now; the hold stays open.",
            not_found: `No open challenge ${token} (it may have been answered or expired).`,
            grant_only: result.detail ?? "That gate is operator-grant only; no approval runs it.",
          };
          ctx.send(input.entity, why[result.error]);
          return;
        }
        const c = result.challenge;
        ctx.send(
          input.entity,
          result.answer === "deny"
            ? `Declined ${c.requesterName}'s ${c.summary} (${c.token}).`
            : `Approved ${c.requesterName}'s ${c.summary} (${c.token})${result.answer === "always" ? `; ${c.gateId} granted` : ""}${result.detail ? ` — ${result.detail}` : ""}.`,
        );
        return;
      }

      ctx.send(input.entity, unknownSubcommand("challenge", sub, USAGE));
    },
  };
}
