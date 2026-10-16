// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { investigationActor, investigationRecipient } from "../../investigations/identity";
import { resolveInvestigation } from "../../investigations/resolve";
import { investigationService } from "../../investigations/service";
import { InvestigationError, parseInvestigationRequest } from "../../investigations/validation";
import type { MarinaDB } from "../../persistence/database";
import { type InvestigationView, investigationAttemptText } from "../../sdk/investigation-text";
import { INVESTIGATION_SCHEMA, type InvestigationAttempt } from "../../sdk/investigation-types";
import type { CommandDef, Entity } from "../../types";
import { getErrorMessage } from "../errors";
import { parseModifiers, splitOnTerminator } from "../parse-input";

const usage = [
  "inquiry predict [type:binary|number|choice] [unit:<unit>] [options:<a,b,c>] [runs:<n>] [case:<id>] [parent:<attempt>] [key:<key>] [horizon:<date>] [asof:<date>] -- <question>",
  "inquiry research [case:<id>] [parent:<attempt>] [key:<key>] -- <question>",
  "inquiry list",
  "inquiry show <case-id> [attempt-id]",
  "inquiry why <case-id> [attempt-id]",
  "inquiry sources <case-id> [attempt-id]",
  "inquiry report <case-id> [attempt-id]",
  "inquiry events <attempt-id> [cursor]",
  "inquiry cancel <attempt-id>",
  "inquiry select <attempt-id>",
  "inquiry grant <case-id> <account> <read|work>",
  "inquiry revoke <case-id> <account>",
  "inquiry delete <case-id>",
  "inquiry review <attempt-id> -- <review>",
  "inquiry resolve <attempt-id> -- <outcome-json>",
];

export function inquiryCommand(deps: {
  db: MarinaDB;
  getEntity(id: string): Entity | undefined;
}): CommandDef {
  return {
    name: "inquiry",
    category: "Cognition",
    minRank: 0,
    usage,
    help: `Private predictions and deep research, with durable evidence and agent delegation.\n${usage.join("\n")}\nWork runs in the background. Inspect it with show/events. A grant permits an account (human or agent) to read or initiate work; it never broadcasts private evidence to a room. New attempts use configured forecast/research providers and work limits; costs may be incomplete.`,
    handler: (ctx, input) => {
      const say = (text: string, attempt?: InvestigationAttempt) =>
        ctx.send(
          input.entity,
          text,
          "investigation",
          attempt
            ? {
                investigation: {
                  schema: INVESTIGATION_SCHEMA,
                  caseId: attempt.caseId,
                  attemptId: attempt.id,
                },
              }
            : undefined,
        );
      try {
        const { db } = deps;
        const actor = investigationActor(db, deps.getEntity(input.entity)?.name);
        const service = investigationService(db);
        const [head, question] = splitOnTerminator(input.args);
        const [sub = "list", id, other, access] = head.split(/\s+/).filter(Boolean);
        if (sub === "predict" || sub === "research") {
          if (!question)
            throw new InvestigationError("invalid_request", "Put the question after --");
          const { values, rest, errors } = parseModifiers(head.split(/\s+/).slice(1), {
            type: { type: "string" },
            unit: { type: "string" },
            options: { type: "string" },
            runs: { type: "int" },
            case: { type: "string" },
            parent: { type: "string" },
            key: { type: "string" },
            horizon: { type: "string" },
            asof: { type: "string" },
          });
          if (errors.length || rest.length)
            throw new InvestigationError(
              "invalid_request",
              [...errors, ...rest.map((value) => `Unexpected modifier: ${value}`)].join("; "),
            );
          const shape =
            values.type === "choice"
              ? {
                  type: "choice",
                  options: String(values.options ?? "")
                    .split(",")
                    .map((label, i) => ({ id: `option-${i + 1}`, label })),
                }
              : { type: values.type ?? "binary", ...(values.unit ? { unit: values.unit } : {}) };
          const request = parseInvestigationRequest({
            kind: sub === "predict" ? "prediction" : "research",
            question,
            ...(sub === "predict" ? { answer: shape } : {}),
            caseId: values.case,
            parentAttemptId: values.parent,
            runs: values.runs,
            horizon: values.horizon,
            asOf: values.asof,
          });
          const { attempt } = service.start(
            actor,
            request,
            typeof values.key === "string" ? values.key : randomUUID(),
          );
          say(
            `${attempt.state === "queued" ? "Started" : "Existing attempt"}: ${attempt.request.question}\nCase ${attempt.caseId}\nAttempt ${attempt.id}\nFollow: inquiry show ${attempt.caseId}`,
            attempt,
          );
          return;
        }
        if (sub === "list") {
          const cases = db.listInvestigations(actor.key);
          say(
            cases.length
              ? cases.map((item) => `${item.id} · ${item.kind} · ${item.question}`).join("\n")
              : "No investigations yet. Try inquiry predict -- <question>",
          );
          return;
        }
        if (!id)
          throw new InvestigationError("invalid_request", `Give an ID.\n${usage.join("\n")}`);
        if (sub === "review") {
          db.reviewInvestigation(actor, id, question ?? "");
          say("Review added to the private case journal.");
          return;
        }
        if (sub === "resolve") {
          const result = resolveInvestigation(db, actor, id, JSON.parse(question ?? "null"));
          say(
            `Outcome recorded for answer ${result.answerId}; loss ${result.loss ?? "unavailable"}.`,
          );
          return;
        }
        if (["show", "why", "sources", "report"].includes(sub)) {
          const snapshot = db.getInvestigation(actor.key, id, other);
          say(
            investigationAttemptText(
              snapshot.attempt,
              sub === "show" ? "answer" : (sub as InvestigationView),
            ),
            snapshot.attempt,
          );
        } else if (sub === "events") {
          const page = db.readInvestigationEvents(actor.key, id, Number(other ?? 0));
          say(
            [
              ...page.events.map(
                (event) =>
                  `${event.sequence} ${event.actor} · ${event.kind}${event.message ? ` · ${event.message}` : ""}`,
              ),
              `Cursor ${page.cursor}${page.more ? " · more available" : ""}${page.reset ? " · reset; reload the case" : ""}`,
            ].join("\n"),
          );
        } else if (sub === "cancel")
          say(`Cancelled ${service.cancel(actor.key, id).length} active attempt(s).`);
        else if (sub === "select") {
          const snapshot = db.selectInvestigationAttempt(actor.key, id);
          say(investigationAttemptText(snapshot.attempt), snapshot.attempt);
        } else if (sub === "grant" || sub === "revoke") {
          if (sub === "grant" && access !== "read" && access !== "work")
            throw new InvestigationError("invalid_request", "Access must be read or work");
          const recipient = investigationRecipient(db, other);
          db.grantInvestigation(
            actor.key,
            id,
            recipient.key,
            sub === "revoke" ? null : (access as "read" | "work"),
          );
          say(
            `${recipient.name}: ${sub === "revoke" ? "access revoked" : `${access} access granted`}.`,
          );
        } else if (sub === "delete") {
          db.eraseInvestigation(actor.key, id);
          say("Investigation and owned evidence erased.");
        } else
          throw new InvestigationError(
            "invalid_request",
            `Unknown inquiry action.\n${usage.join("\n")}`,
          );
      } catch (error) {
        say(`Inquiry: ${getErrorMessage(error)}`);
      }
    },
  };
}
