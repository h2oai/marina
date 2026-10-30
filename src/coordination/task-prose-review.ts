// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { EvidenceSource } from "../decisions/evidence";
import { canonicalFederationJson } from "../net/federation-crypto";

export interface ProseReviewInput {
  target: { name: string; content: string };
  /** Extra sources to read. Optional: the reviewer also resolves every reference the
   *  prose and the task's own work name, by its own access, so a claim about a recorded
   *  fact is checkable whether or not the author listed the source. */
  refs?: string[];
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ProseFinding {
  quote: string;
  status: "contradicted" | "unverified";
  reason: string;
  citations: Array<{ ref: string; quote: string }>;
}

export interface ProseReviewAnswer {
  findings: ProseFinding[];
  limitations: string[];
}

const hash = (value: unknown) =>
  createHash("sha256").update(canonicalFederationJson(value)).digest("hex");

export type ProseSourceOrigin = "request" | "prose" | "work" | "task";

/** The task's recorded history the reviewer may rely on: who did what at which revision. */
export interface ProseReviewRecord {
  /** The task's own journal entries — authored claims by named participants, in order. */
  journal?: Array<{ id: string; author: string; at: number; text: string }>;
  revisions: Array<{ revision: number; author: string; action: string; at: number }>;
  claims: Array<{ entity: string; status: string; submittedAt: number | null }>;
}

/** Sources named by the prose and the work, read by access, after any the caller listed. */
export const MAX_PROSE_REVIEW_SOURCES = 24;

export function proseReviewPacket(input: {
  taskId: number;
  revision: number;
  requirements: unknown;
  artifact: unknown;
  reader: string;
  request: ProseReviewInput;
  resolve: (ref: string) => EvidenceSource;
  /** References the task's own work cites (citations, evidence bindings, rule selections). */
  workRefs?: string[];
  /** References the prose itself names. */
  proseRefs?: string[];
  record?: ProseReviewRecord;
}) {
  const { request } = input;
  const listed = request?.refs ?? [];
  if (
    !request?.target ||
    typeof request.target.name !== "string" ||
    !request.target.name.trim() ||
    typeof request.target.content !== "string" ||
    !request.target.content.trim() ||
    !Array.isArray(listed) ||
    listed.some((ref) => typeof ref !== "string" || !ref.trim()) ||
    new Set(listed).size !== listed.length
  )
    throw new Error(
      "Supply the actual named prose text; refs, when given, are distinct source references.",
    );
  // Every reference the reviewer will read, each with where it came from: the caller's
  // list first, then what the prose names, then what the work cites, then the task.
  const origins = new Map<string, ProseSourceOrigin>();
  const add = (refs: readonly string[] | undefined, origin: ProseSourceOrigin) => {
    for (const ref of refs ?? []) if (!origins.has(ref)) origins.set(ref, origin);
  };
  add(listed, "request");
  add(input.proseRefs, "prose");
  add(input.workRefs, "work");
  add([`task:${input.taskId}`], "task");
  const refs = [...origins.keys()].slice(0, MAX_PROSE_REVIEW_SOURCES);
  if (
    request.reasoningEffort !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.reasoningEffort)
  )
    throw new Error("Supply a supported reasoningEffort name; model support varies.");
  // Do not send a digest of inaccessible text: it would permit guessing private contents.
  const sources = refs.map((ref) => {
    const source = input.resolve(ref);
    if (source.ref !== ref) throw new Error("Source resolver returned a different reference.");
    const origin = origins.get(ref)!;
    return source.status === "current" && source.text !== undefined
      ? { ref, origin, status: source.status, text: source.text, version: source.version }
      : { ref, origin, status: source.status, ...(source.reason ? { reason: source.reason } : {}) };
  });
  const target = {
    ...request.target,
    sha256: createHash("sha256").update(request.target.content).digest("hex"),
  };
  const packet = {
    contract: "task-prose-review-v1" as const,
    taskId: input.taskId,
    revision: input.revision,
    requirements: input.requirements,
    // Candidate prose and artifact are both untrusted authored claims, not evidence.
    target,
    artifact: input.artifact,
    sources,
    // Recorded history is fact, not authored claim: the reviewer may rely on it.
    ...(input.record ? { record: input.record } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
  };
  return { ...packet, fingerprint: hash([packet, input.reader]) };
}

export type ProseReviewPacket = ReturnType<typeof proseReviewPacket>;
export type ProseReviewer = (
  packet: ProseReviewPacket,
  model: string,
) => Promise<ProseReviewAnswer & { model: string }>;

/** Verify provenance and wire shape, never pretend quote membership proves entailment. */
export function assessProseReview(packet: ProseReviewPacket, answer: ProseReviewAnswer) {
  if (
    !answer ||
    !Array.isArray(answer.findings) ||
    !Array.isArray(answer.limitations) ||
    answer.limitations.some((limitation) => typeof limitation !== "string" || !limitation.trim())
  )
    throw new Error("Prose review needs findings and limitations arrays; no assessment recorded.");
  for (const finding of answer.findings) {
    if (
      !finding ||
      typeof finding.quote !== "string" ||
      !finding.quote.trim() ||
      !packet.target.content.includes(finding.quote) ||
      !["contradicted", "unverified"].includes(finding.status) ||
      typeof finding.reason !== "string" ||
      !finding.reason.trim() ||
      !Array.isArray(finding.citations) ||
      (finding.status === "contradicted" && !finding.citations.length)
    )
      throw new Error(
        "Each prose finding needs an exact target quotation and reasoning; a contradiction needs original source citations.",
      );
    for (const citation of finding.citations) {
      const source = packet.sources.find((source) => source.ref === citation?.ref);
      if (
        source?.status !== "current" ||
        typeof citation.quote !== "string" ||
        !citation.quote.trim() ||
        !source.text?.includes(citation.quote)
      )
        throw new Error(
          "A prose finding cites unavailable or nonverbatim evidence; no assessment recorded.",
        );
    }
  }
  const unavailable = packet.sources
    .filter((source) => source.text === undefined)
    .map((s) => s.ref);
  // Every reference the review read or could not read, and why it was in the packet.
  const references = packet.sources.map((s) => ({
    ref: s.ref,
    origin: (s as { origin?: ProseSourceOrigin }).origin ?? "request",
    status: s.text === undefined ? ("unavailable" as const) : ("read" as const),
    ...((s as { reason?: string }).reason ? { reason: (s as { reason?: string }).reason } : {}),
  }));
  const unavailableReasons = Object.fromEntries(
    packet.sources
      .filter((source) => source.text === undefined)
      .map((s) => [s.ref, (s as { reason?: string }).reason ?? "unavailable"]),
  );
  // `unverified` means something was NOT checked: a source the reviewer could not read,
  // or a claim it could not place. The reviewer is asked to list limitations on every
  // run, so limitations alone are not that signal; they ride along with `no-findings`.
  return {
    advisory: true as const,
    fingerprint: packet.fingerprint,
    taskId: packet.taskId,
    revision: packet.revision,
    target: { name: packet.target.name, sha256: packet.target.sha256 },
    outcome: answer.findings.some((finding) => finding.status === "contradicted")
      ? ("findings" as const)
      : unavailable.length || answer.findings.length
        ? ("unverified" as const)
        : ("no-findings" as const),
    ...(unavailable.length ? { unavailableReasons } : {}),
    findings: answer.findings,
    limitations: answer.limitations,
    references,
    unavailable,
    scope:
      "Fresh assessment of the supplied prose against the originals this reviewer can read: any the caller listed, every reference the prose names, every source the task's work cites, and the task itself, plus the task's recorded history. Model interpretation can be incomplete or wrong. Exact target/source quotations are checked, not entailment or exhaustive coverage. No findings is not approval; read the limitations. An unavailable source means its claims were NOT checked: publish a readable copy or pass a reference you can read, then review again. No edits, submission gate or peer wake occurs.",
  };
}
