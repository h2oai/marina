// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactEdit, ArtifactRuleInput } from "../../../coordination/task-artifact";
import type { TaskWork, WorkActor } from "../../../coordination/task-work";
import type { WorkAction, WorkConstraint } from "../../../coordination/task-work-types";
import type { CommandInput, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";

function integer(text: string, zero = false): number {
  if (!/^\d+$/.test(text)) throw new Error("Expected a whole-number id or revision.");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new Error("Invalid id or revision.");
  return value;
}

function object(text: string, keys: string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`Allowed properties: ${keys.join(", ")}.`);
  return value as Record<string, unknown>;
}

function textProperty(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string") throw new Error(`${key} must be a string.`);
  return value[key];
}

function action(kind: string, payload: string): WorkAction {
  if (kind === "patch" || kind === "propose") return { kind, patch: JSON.parse(payload) };
  if (kind === "accept") {
    if (!/^p\d+$/.test(payload)) throw new Error("Expected a proposal id, e.g. p3.");
    return { kind, id: payload };
  }
  if (kind === "retire") {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(payload);
    if (!match) throw new Error("Usage: task work <id> retire <revision> <entry_id> <reason>");
    return { kind, id: match[1]!, reason: match[2]! };
  }
  if (kind === "cite") {
    const value = object(payload, ["field", "ref", "quote"]);
    return {
      kind,
      field: textProperty(value, "field"),
      ref: textProperty(value, "ref"),
      quote: textProperty(value, "quote"),
    };
  }
  if (kind === "expect") {
    const value = object(payload, ["field", "op", "expected", "citation"]);
    return {
      kind,
      field: textProperty(value, "field"),
      op: textProperty(value, "op") as WorkConstraint["op"],
      expected: value.expected as WorkConstraint["expected"],
      citation: textProperty(value, "citation"),
    };
  }
  throw new Error(
    "Unknown work action. Use show, patch, propose, accept, cite, expect, retire, check, render, handoff, artifact-edit, artifact-source, artifact-rule, artifact-rules, artifact-evidence, artifact-unrule, artifact-check, artifact-review, artifact-review-fresh, prose-review, prose-review-fresh, artifact-audit or artifact-assess.",
  );
}

export async function handleTaskWork(
  work: TaskWork | undefined,
  ctx: RoomContext,
  input: CommandInput,
  actor: WorkActor,
): Promise<void> {
  try {
    if (!work) throw new Error("Shared work requires a persistent world.");
    const match = /^work\s+(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(input.args);
    if (!match)
      throw new Error(
        "Usage: task work <id> [show|render|handoff|patch|propose|accept|cite|expect|retire|check|artifact-edit|artifact-source|artifact-rule|artifact-rules|artifact-evidence|artifact-unrule|artifact-check|artifact-review|artifact-review-fresh|prose-review|prose-review-fresh|artifact-audit|artifact-assess …]",
      );
    const taskId = integer(match[1]!);
    const kind = (match[2] ?? "show").toLowerCase();
    const rest = (match[3] ?? "").trim();
    let result: unknown;
    if (kind === "show") result = work.show(taskId, actor, rest ? integer(rest, true) : undefined);
    else if (kind === "render")
      result = work.renderArtifact(taskId, actor, rest ? integer(rest, true) : undefined);
    else if (kind === "handoff")
      result = work.renderHandoff(taskId, actor, rest ? integer(rest, true) : undefined);
    else if (kind === "artifact-review-fresh")
      result = await work.reviewFreshArtifact(taskId, actor, JSON.parse(rest));
    else if (kind === "artifact-review")
      result = work.reviewArtifact(taskId, actor, JSON.parse(rest));
    else if (kind === "artifact-assess")
      result = work.assessArtifact(taskId, actor, JSON.parse(rest));
    else if (kind === "artifact-audit")
      result = work.auditArtifactFile(taskId, actor, JSON.parse(rest));
    else if (kind === "prose-review") result = work.reviewProse(taskId, actor, JSON.parse(rest));
    else if (kind === "prose-review-fresh")
      result = await work.reviewFreshProse(taskId, actor, JSON.parse(rest));
    else if (kind === "check" || kind === "artifact-check") {
      if (rest && rest !== "fresh") throw new Error("Usage: task work <id> check [fresh]");
      result =
        kind === "check"
          ? work.check(taskId, actor, rest === "fresh")
          : work.checkArtifact(taskId, actor, rest === "fresh");
    } else {
      const mutation = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      if (!mutation)
        throw new Error(
          `Usage: task work <id> ${kind} <revision> <payload>. Read task work <id> to get its revision.`,
        );
      const revision = integer(mutation[1]!, true);
      const payload = mutation[2]!;
      if (kind === "artifact-edit")
        result = work.editArtifact(taskId, actor, revision, JSON.parse(payload) as ArtifactEdit[]);
      else if (kind === "artifact-source")
        result = work.publishArtifactSource(taskId, actor, revision, JSON.parse(payload));
      else if (kind === "artifact-evidence")
        result = work.declareArtifactEvidence(taskId, actor, revision, JSON.parse(payload));
      else if (kind === "artifact-rule")
        result = work.declareArtifactRule(
          taskId,
          actor,
          revision,
          JSON.parse(payload) as ArtifactRuleInput,
        );
      else if (kind === "artifact-rules")
        result = work.declareArtifactRules(taskId, actor, revision, JSON.parse(payload));
      else if (kind === "artifact-unrule") {
        const removed = /^(\S+)\s+([\s\S]+)$/.exec(payload);
        if (!removed) throw new Error("Supply a check id and removal reason.");
        result = work.removeArtifactRule(taskId, actor, revision, removed[1]!, removed[2]!);
      } else result = work.apply(taskId, actor, revision, action(kind, payload));
    }
    ctx.send(input.entity, JSON.stringify(result, null, 2));
  } catch (error) {
    ctx.send(input.entity, `task work: ${getErrorMessage(error)}`);
  }
}
