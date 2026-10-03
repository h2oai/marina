// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A FutureX submission file and the email the operator sends with it.
 *
 *   file    org-<org>-agent-<agent>-model-<model>.json  —  [{ "id", "prediction" }, …]
 *   email   to, subject, dataset sha and display fields, printed for the operator
 *
 * Nothing here sends anything. Submitting is an operator act (or an approved
 * connector's); this module only writes the file and describes the email.
 */

import { createHash } from "node:crypto";

export const SUBMISSION_EMAIL = "FutureX-ai@outlook.com";

/** Marina files as its own agent under the H2O.ai organization label. */
export const DEFAULT_IDENTITY = { org: "h2o.ai", agent: "Marina" } as const;

export interface Identity {
  org: string;
  agent: string;
  /** The model segment, one per variant. */
  model: string;
  /** Shown in the email: the agent framework. */
  framework?: string;
}

/**
 * A filename segment: letters, digits, `.` and `_` (and `-` only where allowed).
 * The org and agent segments are followed by `-agent-` / `-model-` markers, so a
 * dash inside them would make the name ambiguous; the model segment comes last
 * and may keep its dashes (`deepseek-v4-pro`).
 */
export function segment(s: string, opts: { dashes?: boolean } = {}): string {
  const out = s
    .trim()
    .replace(opts.dashes ? /[^A-Za-z0-9._-]+/g : /[^A-Za-z0-9._]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!out) throw new Error(`"${s}" is empty as a filename segment`);
  return out.slice(0, 80);
}

export function submissionFileName(id: Identity): string {
  return `org-${segment(id.org)}-agent-${segment(id.agent)}-model-${segment(id.model, { dashes: true })}.json`;
}

export interface Prediction {
  id: string;
  prediction: string;
}

export function submissionBody(predictions: Prediction[]): string {
  return `${JSON.stringify(
    predictions.map((p) => ({ id: p.id, prediction: p.prediction })),
    null,
    1,
  )}\n`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface EmailFields {
  to: string;
  subject: string;
  attachment: string;
  body: string;
}

/** The email the operator sends (never sent by Marina). */
export function emailFields(
  id: Identity,
  datasetSha: string,
  attachmentPath: string,
  date: string,
): EmailFields {
  const name = `${id.agent} (${id.model})`;
  return {
    to: SUBMISSION_EMAIL,
    subject: `FutureX Challenge Submission — ${name} ${date}`,
    attachment: attachmentPath,
    body: [
      `Dataset commit: ${datasetSha}`,
      `Model Name: ${id.model}`,
      `Agent Framework: ${id.framework ?? id.agent}`,
      `Organization: ${id.org}`,
      `File: ${attachmentPath.split("/").pop()}`,
    ].join("\n"),
  };
}
