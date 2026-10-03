// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { panelOperationLabel, parsePanelOperation } from "./panel-actions";
import { validatePanelDocument } from "./panel-document";
import { type PanelSource, resolvePanelBindings } from "./panel-resources";

/** Compact readable snapshots, preserving recorded statuses rather than inferring success. */
export function panelResourceText(source: PanelSource, value: unknown): string {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const rows = (v: unknown) => (Array.isArray(v) ? v.map(record) : []);
  const excerpt = (v: unknown, limit = 1200) => String(v ?? "").slice(0, limit);
  const data = record(value);
  if (source.kind === "coding") {
    const session = record(data.session);
    if (!session.id) return "Coding session unavailable or access denied.";
    return [
      `${session.title} · ${session.status} · ${session.agent ?? "No coder attached"}`,
      "Recent activity:",
      ...rows(data.events)
        .slice(-10)
        .map((event) => `${event.actor} · ${event.kind}: ${excerpt(event.payload_json, 300)}`),
      "Artifacts & verification:",
      ...rows(data.artifacts)
        .slice(0, 10)
        .flatMap((artifact) => {
          let meta: Record<string, unknown> = {};
          try {
            meta = record(JSON.parse(String(artifact.metadata_json)));
          } catch {
            /* Older artifacts may not carry metadata. */
          }
          return [
            `${artifact.title} · ${artifact.kind} · ${artifact.status}${artifact.kind === "task_run" ? ` · recorded verification: ${meta.verification ?? "not recorded"}` : ""}`,
            excerpt(artifact.content_text),
          ];
        }),
      "Recorded checks describe an observed candidate. Later edits may need new verification.",
    ]
      .join("\n")
      .slice(0, 12000);
  }
  if (source.kind === "participant") {
    const session = record(data.session);
    return [
      `${session.label} · ${session.state}`,
      ...rows(data.events)
        .slice(-15)
        .map((event) => {
          const payload = record(event.payload);
          return `${event.kind}: ${excerpt(payload.text ?? JSON.stringify(payload))}`;
        }),
    ]
      .join("\n")
      .slice(0, 8000);
  }
  return JSON.stringify(value, null, 2)?.slice(0, 4000) ?? "Unavailable";
}

/** Bounded semantic projection for terminals, agents and accessible exports. */
export function panelText(input: unknown, sources: Record<string, unknown> = {}): string {
  const parsed = validatePanelDocument(input);
  if (!parsed.ok) return `Panel unavailable: ${parsed.error}`;
  const doc = resolvePanelBindings(parsed.document, sources);
  const map = new Map(doc.components.map((c) => [c.id, c]));
  const lines = [doc.title ?? "Published panel"];
  function visit(id: string, depth: number) {
    if (lines.length >= 100) return;
    const c = map.get(id)!;
    const indent = "  ".repeat(Math.min(depth, 5));
    const get = (key: string) => c[key];
    const operation = parsePanelOperation(c.operation);
    if (c.title) lines.push(`${indent}${c.title}`);
    switch (c.component) {
      case "Text":
        lines.push(`${indent}${String(get("text") ?? "")}`);
        break;
      case "Button":
        lines.push(
          `${indent}[${c.id}] ${String(c.label ?? "Action")}${operation ? ` → ${panelOperationLabel(operation)}` : " · notification"}`,
        );
        break;
      case "TextField":
      case "DateTimeInput":
      case "CheckBox":
        lines.push(
          `${indent}${c.label ?? c.id} (${c.id}): ${String(get(c.component === "CheckBox" ? "checked" : "value") ?? "")}`,
        );
        break;
      case "Resource":
        lines.push(`${indent}Resource ${c.id}: ${JSON.stringify(c.reference)}`);
        break;
      case "DataTable":
      case "Timeline":
        lines.push(
          `${indent}${JSON.stringify(get(c.component === "DataTable" ? "rows" : "items") ?? [])}`,
        );
        break;
    }
    for (const child of [...(c.child ? [c.child] : []), ...(c.children ?? [])])
      visit(child, depth + 1);
  }
  if (doc.rootId) visit(doc.rootId, 0);
  const text = lines.join("\n");
  return text.length > 16000 ? `${text.slice(0, 16000)}\n[Excerpt truncated]` : text;
}
