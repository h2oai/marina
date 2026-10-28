// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExerciseContext } from "./exercise";

/** A model must fix a real defect, add tests, pass candidate verification and an unseen contract. */
export async function exerciseProductiveCoding(ctx: ExerciseContext) {
  if (!ctx.live) {
    ctx.record({
      id: "productive-coding",
      status: "blocked",
      detail: "Native model work requires a provider; deterministic command coverage is separate.",
    });
    return;
  }
  await ctx.scenario("productive-coding", async () => {
    const source =
      'export function paginate<T>(items: readonly T[], page: number, size: number): T[] {\n  if (!Number.isInteger(page) || page < 1) throw new RangeError("page");\n  if (!Number.isInteger(size) || size < 1) throw new RangeError("size");\n  const start = (page - 1) * size;\n  return items.slice(start, start + size - 1);\n}\n';
    const acceptance =
      'import {test,expect} from "bun:test"; import {paginate} from "./pagination"; test("pagination full and partial pages",()=>{expect(paginate([1,2,3,4,5],1,2)).toEqual([1,2]);expect(paginate([1,2,3,4,5],3,2)).toEqual([5]);});\n';
    writeFileSync(join(ctx.workspace, "pagination.ts"), source);
    writeFileSync(join(ctx.workspace, "index.ts"), 'export {paginate} from "./pagination";\n');
    writeFileSync(join(ctx.workspace, "pagination-acceptance.test.ts"), acceptance);
    const baseline = Bun.spawnSync([process.execPath, "test", "pagination-acceptance.test.ts"], {
      cwd: ctx.workspace,
    });
    assert.notEqual(baseline.exitCode, 0, "Fixture must fail before model work");
    await ctx.command("operator", "code exit");
    await ctx.command("operator", "code start Productive pagination repair");
    const session = ctx.db
      .query(
        "SELECT id FROM coding_sessions WHERE title='Productive pagination repair' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { id: string };
    assert(session);
    let dispatched = "";
    const launchDeadline = Date.now() + 5000;
    do {
      dispatched = await ctx.command(
        "operator",
        "code do verification:candidate budget:10m -- Repair the boundary bug in pagination.ts. Preserve the API and existing acceptance tests. Add pagination-regression.test.ts covering size=1, empty input, out-of-range pages and invalid arguments. Run tests and obtain candidate verification before submitting. Do not change package.json or unrelated files. Do not commit, spawn agents, or claim approval.",
      );
      if (!/Spawn cooldown/.test(dispatched)) break;
      await Bun.sleep(250);
    } while (Date.now() < launchDeadline);
    const run = ctx.db
      .query(
        "SELECT id FROM coding_artifacts WHERE session_id=? AND kind='task_run' ORDER BY created_at DESC LIMIT 1",
      )
      .get(session.id) as { id: string } | null;
    assert(run, `No native task run: ${dispatched}`);
    const deadline = Date.now() + 600_000;
    let terminal: { status: string; metadata_json: string } | null = null;
    while (Date.now() < deadline) {
      terminal = ctx.db
        .query("SELECT status,metadata_json FROM coding_artifacts WHERE id=?")
        .get(run.id) as { status: string; metadata_json: string } | null;
      if (terminal && terminal.status !== "active") break;
      await Bun.sleep(250);
    }
    assert(terminal, "Missing task receipt");
    assert.equal(terminal.status, "submitted", terminal.metadata_json);
    const metadata = JSON.parse(terminal.metadata_json) as {
      verification?: string;
      taskId?: number;
    };
    assert.equal(metadata.verification, "passed", "Candidate-bound checks must pass");
    assert.notEqual(readFileSync(join(ctx.workspace, "pagination.ts"), "utf8"), source);
    assert.equal(
      readFileSync(join(ctx.workspace, "pagination-acceptance.test.ts"), "utf8"),
      acceptance,
      "Model may not weaken the provided acceptance tests",
    );
    assert(
      readdirSync(ctx.workspace).includes("pagination-regression.test.ts"),
      "Model-authored regression tests required",
    );
    const holdout = join(ctx.directory, "pagination-holdout.ts");
    writeFileSync(
      holdout,
      `import assert from "node:assert/strict"; import {paginate} from ${JSON.stringify(join(ctx.workspace, "pagination.ts"))};
for(let length=0;length<19;length++)for(let size=1;size<7;size++)for(let page=1;page<8;page++){const items=Array.from({length},(_,i)=>i);const before=[...items];assert.deepEqual(paginate(items,page,size),items.slice((page-1)*size,page*size));assert.deepEqual(items,before);}
for(const bad of [0,-1,1.5,NaN,Infinity]){assert.throws(()=>paginate([],bad,2),RangeError);assert.throws(()=>paginate([],1,bad),RangeError);}
console.log("798 held-out pagination combinations and invalid inputs passed");\n`,
    );
    const checked = Bun.spawnSync([process.execPath, holdout], { cwd: ctx.directory });
    writeFileSync(
      join(ctx.directory, "pagination-holdout.log"),
      checked.stdout.toString() + checked.stderr.toString(),
    );
    assert.equal(checked.exitCode, 0, checked.stderr.toString());
    const approval = await ctx.command("operator", `code review approve ${run.id}`);
    const task = ctx.db.query("SELECT status FROM tasks WHERE id=?").get(metadata.taskId!) as {
      status: string;
    };
    assert.equal(task?.status, "completed", approval);
    await ctx.command("operator", "code exit");
    return JSON.stringify({
      run: run.id,
      session: session.id,
      task: metadata.taskId,
      verification: metadata.verification,
      holdout: checked.stdout.toString(),
      review: "Owner approval only after independent hidden contract checks",
      scope: "Small real bugfix; no general productivity or long-horizon reliability inference.",
    });
  });
}
