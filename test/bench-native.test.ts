// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AggOracle,
  generateAggregation,
  scoreAggregation,
} from "../benchmarks/native/aggregation";
import { generateAuction, scoreAuction, solveAssignment } from "../benchmarks/native/auction";
import {
  type CspConstraint,
  countSolutions,
  generateCsp,
  holds,
  scoreCsp,
} from "../benchmarks/native/csp";
import { expectedCrps, generateDelphi, scoreDelphi } from "../benchmarks/native/delphi";
import {
  DEFAULT_MEMBERS,
  environmentSpec,
  GENERATORS,
  makeRng,
  parseFields,
  resolveTask,
} from "../benchmarks/native/index";
import { generatePipeline, runPipeline, scorePipeline } from "../benchmarks/native/pipeline";
import { exactOkRe, loadCrewMembers, readDeliverables } from "../benchmarks/native/runner";

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

describe("shared", () => {
  test("rng streams are deterministic and salt-separated", () => {
    const a = makeRng(7, "x");
    const b = makeRng(7, "x");
    const c = makeRng(7, "y");
    const sa = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
  });

  test("parseFields reads the tagged line only", () => {
    const f = parseFields("noise CSP3 SCHEDULE: M1=2; m2 = 3.", "CSP3", "SCHEDULE");
    expect(f?.get("m1")).toBe("2");
    expect(f?.get("m2")).toBe("3");
    expect(parseFields("CSP4 SCHEDULE: M1=2", "CSP3", "SCHEDULE")).toBeNull();
  });

  test("every generator is deterministic and seed-sensitive", () => {
    for (const g of Object.values(GENERATORS)) {
      const a = g.generate(5);
      expect(g.generate(5)).toEqual(a);
      expect(g.generate(6).text).not.toBe(a.text);
      expect(a.text).toContain(a.tag);
      expect(new RegExp(a.deliverableRe).test(a.answer)).toBe(true);
      expect(a.text).not.toContain("\n");
    }
  });

  test("resolveTask accepts ids and aliases", () => {
    expect(resolveTask("agg")).toBe("aggregation");
    expect(resolveTask("CSP")).toBe("csp");
    expect(() => resolveTask("nope")).toThrow();
  });

  test("environmentSpec carries the room-hostable view", () => {
    const inst = generateCsp(2);
    const env = environmentSpec(inst);
    expect(env.roomId).toBe("native/csp2");
    expect(env.privateMaterial).toEqual(inst.privateMaterial);
    expect(env.deliverable.pattern).toBe(inst.deliverableRe);
  });
});

describe("csp", () => {
  test("unique solution, every constraint necessary, nobody solves alone", () => {
    for (const seed of SEEDS) {
      const { oracle: o } = generateCsp(seed);
      expect(countSolutions(o.meetings, o.slots, o.constraints, 3)).toBe(1);
      expect(o.constraints.every((c) => holds(c, o.solution))).toBe(true);
      o.constraints.forEach((_, i) => {
        const without = o.constraints.filter((_, j) => j !== i);
        expect(countSolutions(o.meetings, o.slots, without)).toBeGreaterThan(1);
      });
      for (const idx of Object.values(o.shares)) {
        const mine: CspConstraint[] = idx.map((i) => o.constraints[i]!);
        expect(countSolutions(o.meetings, o.slots, mine)).toBeGreaterThan(1);
      }
      // Every constraint is dealt exactly once.
      expect(
        Object.values(o.shares)
          .flat()
          .sort((a, b) => a - b),
      ).toEqual(o.constraints.map((_, i) => i));
    }
  });

  test("oracle: known-good scores 1, known-bad loses credit", () => {
    const inst = generateCsp(3);
    expect(scoreCsp(inst.answer, inst.oracle)).toMatchObject({ correct: true, score: 1 });
    const o = inst.oracle;
    const wrong = o.solution.map((s, i) => (i === 0 ? (s % o.slots) + 1 : s));
    const bad = `${o.tag} SCHEDULE: ${wrong.map((s, i) => `M${i + 1}=${s}`).join("; ")}`;
    const r = scoreCsp(bad, o);
    expect(r.correct).toBe(false);
    expect(r.score).toBeLessThan(1);
    expect(scoreCsp("nothing here", o)).toMatchObject({ correct: false, score: 0 });
    const missing = scoreCsp(`${o.tag} SCHEDULE: M1=${o.solution[0]}`, o);
    expect(missing.correct).toBe(false);
  });

  test("private material names the tag and is dealt to each member", () => {
    const inst = generateCsp(4, { members: ["A", "B", "C"] });
    expect(Object.keys(inst.privateMaterial).sort()).toEqual(["A", "B", "C"]);
    for (const msgs of Object.values(inst.privateMaterial))
      expect(msgs[0]).toContain(`PRIVATE ${inst.tag}`);
  });
});

/** Independent solver: recompute the aggregation from the dealt private material only. */
function solveAggFromMaterial(material: Record<string, string[]>, o: AggOracle) {
  const seen = new Map<string, { region: string; status: string; qty: number }>();
  for (const msgs of Object.values(material))
    for (const m of msgs) {
      if (!m.includes(" SHARD ")) continue;
      const body = m.slice(m.indexOf("):") + 2).replace(/\.$/, "");
      for (const rec of body.split(",")) {
        const [id, region, status, qty] = rec.trim().split(" ");
        seen.set(id!, { region: region!, status: status!, qty: Number(qty) });
      }
    }
  const hits = [...seen.values()].filter((r) => r.region === o.region && r.status === o.status);
  return { count: hits.length, sum: hits.reduce((a, r) => a + r.qty, 0), records: seen.size };
}

describe("aggregation", () => {
  test("answer is recoverable from the dealt shards alone", () => {
    for (const seed of SEEDS) {
      const inst = generateAggregation(seed);
      const got = solveAggFromMaterial(inst.privateMaterial, inst.oracle);
      expect(got).toEqual({
        count: inst.oracle.count,
        sum: inst.oracle.sum,
        records: inst.oracle.records,
      });
      expect(inst.oracle.records).toBeGreaterThanOrEqual(200);
      expect(inst.oracle.records).toBeLessThanOrEqual(300);
    }
  });

  test("crash mode replicates every shard and survives losing the faulted member", () => {
    for (const seed of SEEDS) {
      const inst = generateAggregation(seed, { crash: true });
      expect(inst.fault).toBeDefined();
      expect(inst.fault!.member).not.toBe(DEFAULT_MEMBERS[0]);
      for (const owners of Object.values(inst.oracle.holders)) expect(new Set(owners).size).toBe(2);
      const survivors = Object.fromEntries(
        Object.entries(inst.privateMaterial).filter(([m]) => m !== inst.fault!.member),
      );
      expect(solveAggFromMaterial(survivors, inst.oracle)).toMatchObject({
        count: inst.oracle.count,
        sum: inst.oracle.sum,
      });
    }
    expect(generateAggregation(1).fault).toBeUndefined();
  });

  test("void distractors would change the answer if not ignored", () => {
    let differs = 0;
    for (const seed of SEEDS) {
      const inst = generateAggregation(seed);
      const withVoid = Object.fromEntries(
        Object.entries(inst.privateMaterial).map(([m, msgs]) => [
          m,
          msgs.map((t) => t.replace(" VOID ", " SHARD ")),
        ]),
      );
      const got = solveAggFromMaterial(withVoid, inst.oracle);
      if (got.sum !== inst.oracle.sum) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  test("oracle: exact match only", () => {
    const inst = generateAggregation(2);
    const o = inst.oracle;
    expect(scoreAggregation(inst.answer, o)).toMatchObject({ correct: true, score: 1 });
    const off = scoreAggregation(`${o.tag} RESULT: count=${o.count}; sum=${o.sum + 1}`, o);
    expect(off).toMatchObject({ correct: false, score: 0.5 });
    expect(scoreAggregation(`${o.tag} RESULT: count=x; sum=y`, o).score).toBe(0);
  });
});

describe("auction", () => {
  test("unique optimum; exact search agrees with permutation enumeration", () => {
    for (const seed of SEEDS) {
      const { oracle: o } = generateAuction(seed);
      expect(o.secondBestCost).toBeGreaterThan(o.optimalCost);
      const again = solveAssignment(o.cost, o.capacity);
      expect(again.bestCost).toBe(o.optimalCost);
      // Brute-force cross-check over every capacity-respecting map.
      const m = o.members.length;
      const n = o.subtasks.length;
      let best = Number.POSITIVE_INFINITY;
      for (let code = 0; code < m ** n; code++) {
        const a: number[] = [];
        let c = code;
        for (let t = 0; t < n; t++) {
          a.push(c % m);
          c = Math.floor(c / m);
        }
        const load = new Array(m).fill(0);
        for (const i of a) load[i]++;
        if (load.some((k) => k > o.capacity)) continue;
        best = Math.min(
          best,
          a.reduce((s, i, t) => s + o.cost[i]![t]!, 0),
        );
      }
      expect(best).toBe(o.optimalCost);
    }
  });

  test("oracle: optimal scores 1, a swap scores < 1, invalid scores 0", () => {
    const inst = generateAuction(3);
    const o = inst.oracle;
    expect(scoreAuction(inst.answer, o)).toMatchObject({ correct: true, score: 1 });
    const swapped = o.optimal.slice();
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const line = `${o.tag} ASSIGN: ${o.subtasks.map((s, t) => `${s}=${o.members[swapped[t]!]}`).join("; ")}`;
    const r = scoreAuction(line, o);
    if (swapped[0] !== swapped[1]) {
      expect(r.correct).toBe(false);
      expect(r.score).toBeLessThan(1);
      expect(r.score).toBeGreaterThan(0);
    }
    const all = `${o.tag} ASSIGN: ${o.subtasks.map((s) => `${s}=${o.members[0]}`).join("; ")}`;
    expect(scoreAuction(all, o)).toMatchObject({ correct: false, score: 0 });
    expect(scoreAuction(`${o.tag} ASSIGN: S1=Nobody`, o).score).toBe(0);
  });
});

describe("delphi", () => {
  test("true predictive beats persistence; windows cover the series and reach x[T]", () => {
    for (const seed of SEEDS) {
      const inst = generateDelphi(seed);
      const o = inst.oracle;
      expect(o.optimalSkill).toBeGreaterThanOrEqual(0.05);
      const covered = new Set<number>();
      for (const [a, b] of Object.values(o.windows)) for (let i = a; i < b; i++) covered.add(i);
      expect(covered.size).toBe(o.series.length);
      expect(Math.max(...Object.values(o.windows).map((w) => w[1]))).toBe(o.series.length);
    }
  });

  test("oracle: true predictive is correct; persistence and far-off forecasts are not", () => {
    const inst = generateDelphi(4);
    const o = inst.oracle;
    const good = scoreDelphi(inst.answer, o);
    expect(good.correct).toBe(true);
    expect(good.score).toBeGreaterThan(0);
    const pers = scoreDelphi(
      `${o.tag} FORECAST: mean=${o.persistence.mean}; sd=${o.persistence.sd}`,
      o,
    );
    expect(pers.correct).toBe(false);
    const far = scoreDelphi(`${o.tag} FORECAST: mean=${o.predictive.mean + 50}; sd=1`, o);
    expect(far).toMatchObject({ correct: false, score: 0 });
    expect(scoreDelphi(`${o.tag} FORECAST: mean=abc; sd=1`, o).score).toBe(0);
  });

  test("expected CRPS is minimised at the truth", () => {
    const at = expectedCrps(0, 1, 0, 1);
    expect(expectedCrps(0.5, 1, 0, 1)).toBeGreaterThan(at);
    expect(expectedCrps(0, 2, 0, 1)).toBeGreaterThan(at);
  });
});

describe("pipeline", () => {
  test("report is recoverable from the private raw input via the stated contract", () => {
    for (const seed of SEEDS) {
      const inst = generatePipeline(seed);
      const raw = Object.values(inst.privateMaterial).flat();
      expect(raw).toHaveLength(1);
      const lines = raw[0]!.slice(raw[0]!.indexOf("in order: ") + 10).split(" ");
      expect(runPipeline(lines)).toEqual(inst.oracle.expected);
      expect(Number(inst.oracle.expected.rejected)).toBeGreaterThanOrEqual(3);
      const owners = inst.oracle.owners;
      expect(new Set([owners.parse, owners.transform, owners.report]).size).toBe(3);
    }
  });

  test("oracle: exact report, partial credit per field, extra fields penalised", () => {
    const inst = generatePipeline(5);
    const o = inst.oracle;
    expect(scorePipeline(inst.answer, o)).toMatchObject({ correct: true, score: 1 });
    const bad = inst.answer.replace(/rejected=\d+/, "rejected=999");
    const r = scorePipeline(bad, o);
    expect(r.correct).toBe(false);
    const n = Object.keys(o.expected).length;
    expect(r.score).toBeCloseTo((n - 1) / n);
    expect(scorePipeline(`${inst.answer}; zz=1`, o).correct).toBe(false);
  });
});

describe("runner helpers", () => {
  test("exactOkRe matches the canonical answer with loose spacing", () => {
    const inst = generateAggregation(3);
    const re = new RegExp(exactOkRe(inst));
    expect(re.test(inst.answer)).toBe(true);
    expect(re.test(inst.answer.replace("; ", " ;  ").replace("=", " = "))).toBe(true);
    expect(re.test(inst.answer.replace(/sum=\d+/, "sum=0"))).toBe(false);
    expect(exactOkRe(generateDelphi(1))).toBe("");
  });

  test("reads roster and deliverables from a world DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-db-"));
    try {
      const path = join(dir, "w.db");
      const db = new Database(path);
      db.exec(`CREATE TABLE crews (id TEXT, name TEXT);
        CREATE TABLE crew_members (crew_id TEXT, agent_name TEXT, role TEXT);
        CREATE TABLE memory_pools (id TEXT, name TEXT);
        CREATE TABLE numeric_notes (id INTEGER, content TEXT, created_at INTEGER, pool_id TEXT);
        INSERT INTO crews VALUES ('c1', 'answerer');
        INSERT INTO crew_members VALUES ('c1', 'Zed', 'specialist'), ('c1', 'Answerer', 'lead'), ('c1', 'Bo', 'specialist');
        INSERT INTO memory_pools VALUES ('p1', 'eval-artifacts');
        INSERT INTO numeric_notes VALUES (1, 'CSP9 SCHEDULE: M1=1', 1, 'p1'), (2, 'other', 2, 'p1'), (3, 'CSP9 SCHEDULE: M1=2', 3, 'p2');`);
      db.close();
      expect(loadCrewMembers(path, "answerer")).toEqual(["Answerer", "Bo", "Zed"]);
      const notes = readDeliverables(path, "eval-artifacts", generateCsp(9).deliverableRe);
      expect(notes.map((n) => n.id)).toEqual([1]);
      expect(readDeliverables(path, "missing-pool", "x")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
