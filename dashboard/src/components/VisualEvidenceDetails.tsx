// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The same saved observation is shown in chat and a canvas coding desk. */
export function VisualEvidenceDetails({ metadata }: { metadata: Record<string, unknown> }) {
  return (
    <div className="mt-2 space-y-1 text-xs text-text-dim">
      <p>Saved image observation · model output, not independently verified</p>
      {typeof metadata.sourcePath === "string" && (
        <p className="break-all">Source: {metadata.sourcePath}</p>
      )}
      {typeof metadata.question === "string" && metadata.question && (
        <p>Question: {metadata.question}</p>
      )}
      {typeof metadata.model === "string" && <p>Model: {metadata.model}</p>}
      <p>Reopening this evidence does not run vision again.</p>
    </div>
  );
}
