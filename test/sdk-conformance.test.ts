// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// SDK conformance: every Marina SDK runs the same scenarios against a live server and must
// produce the same report. The contract is protocol/conformance.md; each SDK ships a driver
// program (TypeScript: test/conformance/typescript.ts). "Parity" is this list passing for
// every language, checked by the same assertions.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { grant } from "../src/engine/safety-gates";
import * as wire from "../src/protocol/wire";
import { MarinaClient } from "../src/sdk/client";
import type { EntityId } from "../src/types";
import {
  SCRIPTED_TASK,
  type ScriptedCodingServer,
  startScriptedCodingServer,
} from "./fixtures/scripted-coding-server";

const ROOT = resolve(import.meta.dir, "..");
/** The environment as it was before any fixture scoped its own settings into it. */
const BASE_ENV = { ...process.env };

/** A driver's report: JSON from another process, checked field by field below. */
// biome-ignore lint/suspicious/noExplicitAny: an untyped JSON report from another language's driver
type Report = Record<string, any>;

/** One SDK: how to build its driver once, and how to run one scenario. */
interface Language {
  id: string;
  /** The login name its driver uses: 2-20 letters or digits. */
  name: string;
  build?: () => Promise<void>;
  argv: (scenario: string, url: string, args: string) => string[];
}

export const LANGUAGES: Language[] = [
  {
    id: "typescript",
    name: "tsdriver",
    argv: (scenario, url, args) => [
      process.execPath,
      join(ROOT, "test/conformance/typescript.ts"),
      scenario,
      url,
      args,
    ],
  },
];

function check(schema: TSchema, value: unknown, what: string): void {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => JSON.stringify(e));
  throw new Error(
    `${what} is not on the wire schema:\n${errors.join("\n")}\n${JSON.stringify(value)}`,
  );
}

/** A running driver: read its lines, answer its "ready" with a "go", collect its report. */
async function drive(
  language: Language,
  scenario: string,
  url: string,
  args: Record<string, unknown>,
  onReady: (
    info: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined> = async () => ({}),
  env: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(
    language.argv(scenario, url, JSON.stringify({ name: language.name, ...args })),
    {
      cwd: ROOT,
      env: { ...BASE_ENV, PYTHONDONTWRITEBYTECODE: "1", ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let report: Record<string, unknown> | undefined;
  let error: string | undefined;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      continue;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as {
      ready?: Record<string, unknown>;
      report?: Record<string, unknown>;
      error?: string;
    };
    if (message.ready) {
      const go = (await onReady(message.ready)) ?? {};
      child.stdin.write(`${JSON.stringify({ go })}\n`);
      child.stdin.flush();
    }
    if (message.report) report = message.report;
    if (message.error) error = message.error;
  }
  const code = await child.exited;
  if (error || code !== 0 || !report)
    throw new Error(
      `${language.id} ${scenario} failed (exit ${code}): ${error ?? "no report"}\n${(await stderr).slice(-3000)}`,
    );
  return report;
}

const selected = (process.env.MARINA_CONFORMANCE_LANGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const language of LANGUAGES.filter((l) => !selected.length || selected.includes(l.id))) {
  describe(`SDK conformance: ${language.id}`, () => {
    let fixture: ScriptedCodingServer;
    let peer: MarinaClient;
    const peerHeard: string[] = [];
    beforeAll(async () => {
      await language.build?.();
      fixture = await startScriptedCodingServer([language.name]);
      // The agent scenario's other participant: answers "ping" with "pong", echoing the tag.
      peer = new MarinaClient(fixture.url, { autoReconnect: false, pingInterval: 0 });
      await peer.connect("Peer");
      peer.onPerception((p) => {
        if (p.tag !== "tell" || typeof p.data?.senderName !== "string") return;
        const text = String(p.data.message ?? p.data.text ?? "");
        peerHeard.push(text);
        const tag = /\[re:[a-z0-9]+\]/.exec(text)?.[0];
        if (text.startsWith("ping"))
          void peer.command(`tell ${p.data.senderName} pong${tag ? ` ${tag}` : ""}`);
      });
    }, 900_000);
    afterAll(async () => {
      peer?.disconnect();
      await fixture?.dispose();
    });

    it("coding: a task to its result, every frame on the wire schema", async () => {
      const report = (await drive(
        language,
        "coding",
        fixture.url,
        { task: SCRIPTED_TASK },
        async (info) => {
          grant(fixture.db, info.entity as EntityId, "code.exec");
          return {};
        },
      )) as Report;
      expect(report.run_id).toStartWith("task_run_");
      expect(report.result).toMatchObject({
        runId: report.run_id,
        terminal: true,
        phase: "completed",
        outcome: "submitted",
      });
      check(wire.RunResult, report.result, "the Run result");
      check(wire.RunResult, report.typed_result, "the typed Run result");
      expect(report.typed_result).toMatchObject({ runId: report.run_id, outcome: "submitted" });
      expect(report.submitted).toBe(true);
      expect(report.summary).toContain("rounds up");
      expect(report.last_event_run).toBe(report.run_id);
      expect(report.steps.find((s: { kind: string }) => s.kind === "edit")).toMatchObject({
        path: "source.ts",
        diff: ["-Math.floor(total / size)", "+Math.ceil(total / size)"],
      });
      for (const step of report.steps) check(wire.CodingActivity, step, "a step");
      expect(report.frames.length).toBeGreaterThan(5);
      for (const frame of report.frames) check(wire.CodeFrame, frame, "a code frame");
      expect(report.diff).toContain("+  return Math.ceil(total / size);");
    }, 180_000);

    it("commands: world commands in Code Mode, refusals, capabilities, typed forms", async () => {
      const report = (await drive(language, "commands", fixture.url, {})) as Report;
      expect(report.look).toContain("Start");
      expect(report.refused).toBeString();
      expect(report.refused.length).toBeGreaterThan(0);
      expect(report.capability_count).toBeGreaterThan(20);
      expect(report.composed).toBe(`say hello from ${language.name}`);
      expect(report.missing_errors).toBe(1);
      expect(report.said).toContain(`hello from ${language.name}`);
    }, 60_000);

    it("reconnect: back on its own after the server drops the socket, same entity, new token", async () => {
      const report = (await drive(language, "reconnect", fixture.url, {}, async (info) => {
        expect(fixture.dropConnection(String(info.entity))).toBe(true);
        return {};
      })) as Report;
      expect(report).toEqual({
        reconnected: true,
        same_entity: true,
        token_changed: true,
        look_ok: true,
      });
    }, 90_000);

    it("agent: asks and waits for the answer; waits for a question and answers it", async () => {
      peerHeard.length = 0;
      const report = (await drive(language, "agent", fixture.url, { peer: "Peer" }, async () => {
        // Answer "go" first; the question follows once the driver is waiting for it.
        setTimeout(() => void peer.command(`tell ${language.name} question?`), 750);
        return {};
      })) as Report;
      expect(report.reply).toBe("pong");
      expect(report.heard).toBe("question?");
      expect(peerHeard.some((t) => t.startsWith("answer: question?"))).toBe(true);
    }, 60_000);

    it("memory: typed calls, a replayed write, and retry through a real rate limit", async () => {
      const principal = fixture.db.ensurePrincipal({
        type: "service",
        displayName: `${language.id}Memory`,
      });
      const credential = fixture.db.issueMemoryCredential(principal.principal_id).token;
      const report = (await drive(language, "memory", fixture.url, {
        credential,
        burst: 140,
      })) as Report;
      expect(report.replayed).toBe(true);
      expect(report.content).toBe("Deploys run from main");
      expect(report.found).toBe(true);
      expect(report.written).toBe(140);
      expect(report.rate_limit_waits).toBeGreaterThan(0);
    }, 120_000);

    it("panels: the live event stream", async () => {
      const report = (await drive(language, "panels", fixture.url, {})) as Report;
      expect(report).toMatchObject({ snapshot: true, got_canvas_event: true });
    }, 60_000);

    it("routing: typed sessions, publish, send, inbox, acknowledge", async () => {
      const report = (await drive(language, "routing", fixture.url, {})) as Report;
      expect(report.session_a).toBeString();
      expect(report.inbox_has_message).toBe(true);
      expect(report.published).toBe(true);
    }, 60_000);

    it("local: the folder's own server, on a clean machine", async () => {
      const folder = mkdtempSync(join(tmpdir(), `marina-conf-${language.id}-`));
      const home = mkdtempSync(join(tmpdir(), `marina-conf-home-${language.id}-`));
      try {
        const report = (await drive(
          language,
          "local",
          fixture.url,
          { folder, command: [process.execPath, "run", join(ROOT, "scripts/marina.ts")] },
          undefined,
          {
            HOME: home,
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            OPENROUTER_API_KEY: "",
            GEMINI_API_KEY: "",
          },
        )) as Report;
        expect(report.name).toBe("coder");
        expect(report.refused).toContain("No model provider configured");
        expect(report.look).toBe(true);
        expect(report.stopped).toBe(true);
        expect(report.missing).toContain("Not a folder");
      } finally {
        rmSync(folder, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
