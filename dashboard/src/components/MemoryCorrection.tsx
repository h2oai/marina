// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { MemoryClaim, MemoryRecord } from "../../../src/sdk/memory-types";

/** Corrections append a version; the expected version protects concurrent edits. */
export function MemoryCorrection({
  record,
  disabled,
  save,
}: {
  record: MemoryRecord;
  disabled: boolean;
  save: (content: string, claim: MemoryClaim | null, sources: string[]) => void;
}) {
  const [content, setContent] = useState(record.content);
  const [subject, setSubject] = useState(record.claim?.subject ?? "");
  const [predicate, setPredicate] = useState(record.claim?.predicate ?? "");
  const object = record.claim?.object;
  const initialKind =
    object?.kind === "entity" ? "entity" : object?.value === null ? "null" : typeof object?.value;
  const [kind, setKind] = useState(initialKind);
  const [value, setValue] = useState(
    object?.kind === "entity" ? object.id : String(object?.value ?? ""),
  );
  const [sources, setSources] = useState(record.source_ids.join("\n"));
  const field = "block w-full rounded border border-border bg-bg p-2";
  const valid =
    !!content.trim() &&
    (!record.claim ||
      (!!subject.trim() &&
        !!predicate.trim() &&
        (kind === "null" || !!value.trim()) &&
        (kind !== "number" || Number.isFinite(Number(value))) &&
        (kind !== "boolean" || ["true", "false"].includes(value))));
  return (
    <details className="rounded border border-border p-3">
      <summary>Correct this memory</summary>
      <form
        className="space-y-3 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          const claim: MemoryClaim | null = record.claim
            ? {
                subject,
                predicate,
                object:
                  kind === "entity"
                    ? { kind: "entity", id: value }
                    : {
                        kind: "literal",
                        value:
                          kind === "number"
                            ? Number(value)
                            : kind === "boolean"
                              ? value === "true"
                              : kind === "null"
                                ? null
                                : value,
                      },
              }
            : null;
          save(content.trim(), claim, sources.split(/\s+/).filter(Boolean));
        }}
      >
        <p className="text-xs text-text-dim">
          Save a new revision. Earlier evidence and history remain available. A correction does not
          automatically make a claim verified.
        </p>
        <label className="block">
          Corrected content
          <textarea
            className={field}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            rows={3}
          />
        </label>
        {record.claim && (
          <fieldset className="space-y-2">
            <legend>Structured claim</legend>
            <label className="block">
              Subject
              <input
                className={field}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </label>
            <label className="block">
              Relationship
              <input
                className={field}
                value={predicate}
                onChange={(e) => setPredicate(e.target.value)}
                required
              />
            </label>
            <label className="block">
              Value type
              <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
                {["string", "number", "boolean", "null", "entity"].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            {kind !== "null" && (
              <label className="block">
                Value
                <input
                  className={field}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              </label>
            )}
          </fieldset>
        )}
        <label className="block">
          Source references
          <textarea
            className={field}
            value={sources}
            onChange={(e) => setSources(e.target.value)}
            rows={2}
          />
          <span className="text-xs text-text-dim">
            Keep references that support the correction. Source identifiers are available in
            Sources.
          </span>
        </label>
        <button
          type="submit"
          className="rounded border border-primary px-3 py-2"
          disabled={disabled || !valid}
        >
          Save correction
        </button>
      </form>
    </details>
  );
}
