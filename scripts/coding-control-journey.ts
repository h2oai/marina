// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AgentHandle } from "../src/agent/agent-types";
import { codingRunMetadata } from "../src/coding/task-run";
import { residentMemoryOperation } from "../src/memory/resident-service";
import type { MarinaDB } from "../src/persistence/database";
import type { MarinaAgent, Perception } from "../src/sdk/client";
import { CodeConsole } from "./code-console";
import { HarnessStore } from "./code-harness";

/** Real terminal command controller, WS admission, resident and canonical ledgers.
 * PTY/bootstrap acceptance is separate; no fake command or tool implementation. */
export class CodingControlJourney {
  readonly console: CodeConsole;
  readonly output: string[] = [];
  readonly evidence: Record<string, unknown> = {};
  private readonly unsubscribe: () => void;
  private readonly nonce = `continuity-${crypto.randomUUID()}`;

  constructor(
    private options: {
      owner: MarinaAgent;
      url: string;
      root: string;
      directory: string;
      sessionId: string;
      db: MarinaDB;
      worker: AgentHandle;
      timeoutMs: number;
    },
  ) {
    this.console = new CodeConsole({
      agent: options.owner,
      url: options.url,
      root: options.root,
      directory: options.directory,
      connected: true,
      sessionId: options.sessionId,
      harness: { version: 1, agent: "marina", model: "marina/default" },
      store: new HarnessStore(options.directory),
      finish: () => undefined,
      plainOutput: new Writable({
        write: (chunk, _encoding, done) => {
          this.output.push(String(chunk));
          done();
        },
      }),
    });
    const receive = (p: Perception) => this.console.receive(p);
    options.owner.onPerception(receive);
    this.unsubscribe = () => options.owner.offPerception(receive);
  }

  async close() {
    this.unsubscribe();
    await this.console.close(0);
  }

  private snapshot(): string {
    const listed = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: this.options.root },
    );
    assert.equal(listed.exitCode, 0, "Cannot snapshot plan workspace");
    const hash = createHash("sha256");
    for (const path of listed.stdout.toString().split("\0").filter(Boolean).sort()) {
      hash
        .update(path)
        .update("\0")
        .update(readFileSync(join(this.options.root, path)));
    }
    return hash.digest("hex");
  }

  private async wait(check: () => boolean, label: string) {
    const deadline = Date.now() + this.options.timeoutMs;
    while (!check()) {
      assert.ok(Date.now() < deadline, `${label}: deadline reached`);
      assert.ok(!this.options.worker.getStatus().budgetExhausted, `${label}: budget exhausted`);
      await Bun.sleep(25);
    }
  }

  async plan(task: string, followup = false) {
    const { db, sessionId } = this.options;
    const before = this.snapshot();
    const known = new Set(db.listCodingRuns({ sessionId }).map((run) => run.id));
    await this.console.submit(`/plan ${task}`);
    const run = db.listCodingRuns({ sessionId }).find((run) => !known.has(run.id));
    assert.ok(run, "Plan command did not create a task attempt");
    await this.wait(() => db.getCodingArtifact(run.id)?.status !== "active", "read-only plan");
    const current = db.getCodingArtifact(run.id)!;
    assert.equal(current.status, "submitted", "Plan did not submit a proposal");
    assert.equal(this.snapshot(), before, "Read-only plan changed project files");
    const summary = db.getCodingArtifact(codingRunMetadata(current).summaryId!)?.content_text ?? "";
    assert.ok(summary.length > 0, "Plan has no saved proposal");
    if (followup) assert.ok(summary.includes(this.nonce), "Compaction lost the continuity marker");
    await this.console.submit(`/review approve ${run.id}`);
    assert.equal(db.getTask(codingRunMetadata(current).taskId)?.status, "completed");
    this.evidence[followup ? "followup" : "plan"] = {
      run_id: run.id,
      unchanged_workspace: true,
      submitted: true,
    };
  }

  async beforeTask(task: string) {
    await this.console.start(false);
    await this.plan(
      `Inspect source.ts and propose how to handle this request, without editing or executing commands: ${task} Only submit a read-only proposal using code summary; implementation and candidate checks happen in the next task. Remember this unresolved continuity marker for a later request: ${this.nonce}.`,
    );
  }

  async afterReview() {
    await this.wait(
      () => this.options.worker.getStatus().healthState !== "busy",
      "worker idle before compaction",
    );
    const start = this.output.length;
    await this.console.submit("/compact");
    const text = this.output.slice(start).join("");
    const match = /Context compacted: (\d+) → (\d+) messages/.exec(text);
    assert.ok(
      match && Number(match[2]) < Number(match[1]),
      `Manual compaction did not reduce eligible history: ${text}`,
    );
    const { db, worker } = this.options;
    const checkpoint = (
      await residentMemoryOperation(db, worker.name, { operation: "checkpoint", id: "resident" })
    ).result as { data: { archive?: { source_ids?: string[] } } };
    const sources = checkpoint.data.archive?.source_ids;
    assert.ok(sources?.length, "Compaction did not preserve original sources");
    let original = "";
    for (const id of sources)
      original += (
        (await residentMemoryOperation(db, worker.name, { operation: "source_range", id }))
          .result as { text: string }
      ).text;
    assert.ok(
      original.includes(this.nonce),
      "Original continuity marker is not retrievable from the archive",
    );
    this.evidence.compaction = {
      before: Number(match[1]),
      after: Number(match[2]),
      archived_sources: sources.length,
      original_retrieved: true,
    };
    await this.plan(
      "Recall the unresolved continuity marker from the earlier proposal. Submit that exact marker in a code summary, with no project changes or command execution.",
      true,
    );
    const costStart = this.output.length;
    await this.console.submit("/cost");
    assert.match(this.output.slice(costStart).join(""), /cost|spend|spent|tokens/i);
    const usage = this.options.worker.getStatus();
    assert.ok(
      (usage.totalInputTokens ?? 0) > 0 && (usage.totalOutputTokens ?? 0) > 0,
      "No measured model usage",
    );
    assert.ok(
      Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd! > 0,
      "Priced model usage was not accounted",
    );
    this.evidence.cost_command = {
      input_tokens: usage.totalInputTokens,
      output_tokens: usage.totalOutputTokens,
      recorded_usd: usage.totalCostUsd,
    };
  }
}
