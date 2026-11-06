// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every playbook use case that needs no model, network, long run or other
 * world runs here on each test run, in an in-process engine under the local
 * trust profile (a person on their own machine). The live runner
 * (`bun run playbook`) runs the rest against a real server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inProcess, PLAYBOOK, type PlaybookUseCase } from "../scripts/playbook/catalog";
import { judgeStep, type StepOutcome, stepCommand, stripAnsi } from "../scripts/playbook/step";
import { withCommandResponse } from "../src/engine/command-response";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

async function runStep(
  fixture: ReturnType<typeof createTestEngine>,
  who: { entityId: EntityId; connection: { id: string; messages: { data: unknown }[] } },
  command: string,
): Promise<StepOutcome> {
  const before = who.connection.messages.length;
  let error: string | undefined;
  await withCommandResponse(
    who.connection.id,
    `playbook-${crypto.randomUUID().slice(0, 8)}`,
    () => fixture.engine.processCommand(who.entityId, command),
    (p) => {
      const result = (p.data as { command_result?: { ok?: boolean; error?: string } })
        .command_result;
      if (result && result.ok === false) error = result.error ?? "refused";
    },
  );
  const text = who.connection.messages
    .slice(before)
    .map((p) => stripAnsi(String((p.data as { text?: string }).text ?? "")))
    .join("\n");
  return { ok: error === undefined, text, ...(error ? { error } : {}) };
}

const cases = PLAYBOOK.filter(inProcess);

describe("the playbook, in-process", () => {
  let state: DisposableStack;
  let dir: string;
  beforeAll(() => {
    state = scopeProcessState({ trustProfile: "local", rateLimitBypass: true });
    dir = mkdtempSync(join(tmpdir(), "marina-playbook-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    state.dispose();
  });

  test("covers a model-free slice of the catalogue", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const useCase of cases) {
    test(`${useCase.id}: ${useCase.title}`, async () => {
      const fixture = createTestEngine();
      try {
        for (const [name, content] of Object.entries(useCase.files ?? {}))
          writeFileSync(join(dir, name), content);
        const person = fixture.login(personName(useCase));
        const problems: string[] = [];
        for (const step of useCase.steps) {
          const who = step.as ? fixture.login(step.as) : person;
          const command = stepCommand(step, dir);
          const outcome = await runStep(fixture, who, command);
          for (const p of judgeStep(step, outcome)) problems.push(`${command} → ${p}`);
        }
        expect(problems).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    });
  }
});

function personName(useCase: PlaybookUseCase): string {
  return `p_${useCase.id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
}
