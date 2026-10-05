// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Perception } from "../src/sdk/client";
import { terminalText } from "./code-presentation";

const LIMIT = 200;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    terminalText(value) === value &&
    !/[\r\n\t]/.test(value) &&
    !value.startsWith("/") &&
    !value.split(/[\\/]/).includes("..")
  );
}

/** Bounded hints from already-visible structured results. Never reads files or authorizes actions. */
export class CodeDiscovery {
  private session?: string;
  private entries = new Map<string, AutocompleteItem>();
  select(session?: string) {
    if (session !== this.session) this.entries.clear();
    this.session = session;
  }
  observe(p: Perception, session?: string) {
    this.select(session);
    if (p.kind === "auth_error") this.entries.clear();
    if (p.kind === "error" || p.kind === "auth_error") return;
    const code = record(p.data?.code);
    if (!session || code.sessionId !== session) return;
    if (code.event === "files_listed") {
      for (const key of this.entries.keys())
        if (key.startsWith("/world code ")) this.entries.delete(key);
    }
    const add = (value: string, description: string) => {
      this.entries.delete(value);
      this.entries.set(value, { value, label: value, description });
      if (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value!);
    };
    const artifact = (id: unknown) => {
      if (typeof id === "string" && ID.test(id)) add(`/show ${id}`, "Inspect observed artifact");
    };
    const attempt = (id: unknown) => {
      if (typeof id === "string" && ID.test(id))
        add(`/review ${id}`, "Inspect observed attempt; no decision");
    };
    artifact(code.artifactId);
    attempt(record(code.metadata).runId);
    for (const value of (Array.isArray(code.rows) ? code.rows : []).slice(0, LIMIT)) {
      const row = record(value);
      if (
        ["files_listed", "file_read", "workspace_searched"].includes(String(code.event)) &&
        safePath(row.path)
      ) {
        const directory = row.type === "dir";
        add(
          `/world code ${directory ? "files" : "read"} ${row.path}`,
          `Observed ${directory ? "directory" : "file"}`,
        );
      }
      if (["artifacts_listed", "patches_listed"].includes(String(code.event))) {
        artifact(row.id);
        if (row.kind === "task_run") attempt(row.id);
      }
    }
  }
  suggestions(session?: string): AutocompleteItem[] {
    this.select(session);
    return [...this.entries.values()];
  }
}
