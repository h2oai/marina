// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { EvidenceSource } from "../decisions/evidence";
import { canonicalFederationJson } from "../net/federation-crypto";

export interface ProseReviewInput {
  target: { name: string; content: string };
  refs: string[];
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

export function proseReviewPacket(input: {
  taskId: number;
  revision: number;
  requirements: unknown;
  artifact: unknown;
  reader: string;
  request: ProseReviewInput;
  resolve: (ref: string) => EvidenceSource;
}) {
  const { request } = input;
  if (
    !request?.target ||
    typeof request.target.name !== "string" ||
    !request.target.name.trim() ||
    typeof request.target.content !== "string" ||
    !request.target.content.trim() ||
    !Array.isArray(request.refs) ||
    !request.refs.length ||
    request.refs.some((ref) => typeof ref !== "string" || !ref.trim()) ||
    new Set(request.refs).size !== request.refs.length
  )
    throw new Error("Supply the actual named prose text and distinct original source references.");
  if (
    request.reasoningEffort !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.reasoningEffort)
  )
    throw new Error("Supply a supported reasoningEffort name; model support varies.");
  // Do not send a digest of inaccessible text: it would permit guessing private contents.
  const sources = request.refs.map((ref) => {
    const source = input.resolve(ref);
    if (source.ref !== ref) throw new Error("Source resolver returned a different reference.");
    return source.status === "current" && source.text !== undefined
      ? { ref, status: source.status, text: source.text, version: source.version }
      : { ref, status: source.status, ...(source.reason ? { reason: source.reason } : {}) };
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
    unavailable,
    scope:
      "Fresh assessment of the supplied prose against selected readable originals. Source selection and model interpretation can be incomplete or wrong. Exact target/source quotations are checked, not entailment or exhaustive coverage. No findings is not approval; read the limitations. An unavailable source means its claims were NOT checked: publish a readable copy or pass a reference you can read, then review again. No edits, submission gate or peer wake occurs.",
  };
}
