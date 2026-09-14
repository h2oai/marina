// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_PATH,
  loadCorpus,
  type ParaphraseTriple,
  renderTable,
  runParaphraseBenchmark,
} from "../benchmarks/paraphrase/runner";
import {
  aliasRulesFromText,
  autoVocabularySeed,
  expandedFtsQueries,
  expansionForEntity,
  expansionFromVocabulary,
  fuseRecallResults,
  vocabularyRulesFromDefinition,
} from "../src/memory/query-expansion";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { worldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryQueryVocabulary } from "../src/sdk/memory-expansion";

const readme = readFileSync(
  join(import.meta.dir, "..", "benchmarks", "paraphrase", "README.md"),
  "utf8",
);

/** Five triples per domain — a balanced, deterministic 20-triple offline subset. */
function subset(triples: ParaphraseTriple[], perDomain = 5): ParaphraseTriple[] {
  const seen = new Map<string, number>();
  return triples.filter((triple) => {
    const count = seen.get(triple.domain) ?? 0;
    if (count >= perDomain) return false;
    seen.set(triple.domain, count + 1);
    return true;
  });
}

describe("paraphrase corpus", () => {
  it("is frozen: 200 authored triples across four domains, hash recorded in the README", () => {
    const { corpus, hash } = loadCorpus(CORPUS_PATH);
    expect(corpus.triples).toHaveLength(200);
    const byDomain = new Map<string, number>();
    for (const triple of corpus.triples)
      byDomain.set(triple.domain, (byDomain.get(triple.domain) ?? 0) + 1);
    expect([...byDomain.entries()].sort()).toEqual([
      ["dev", 50],
      ["ops", 50],
      ["personal-preference", 50],
      ["scheduling", 50],
    ]);
    expect(new Set(corpus.triples.map((t) => t.id)).size).toBe(200);
    for (const triple of corpus.triples) {
      expect(triple.fact.length).toBeGreaterThan(10);
      expect(triple.paraphrase.toLowerCase()).not.toBe(triple.fact.toLowerCase());
      expect(triple.distractor.toLowerCase()).not.toBe(triple.paraphrase.toLowerCase());
    }
    expect(readme).toContain(hash);
  });
});

describe("paraphrase gate (offline, 20-triple subset)", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-paraphrase-test-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("porter + stop-words is never worse than the pre-112 plain index, and hybrid skips without a provider", async () => {
    const { corpus } = loadCorpus();
    const triples = subset(corpus.triples);
    expect(triples).toHaveLength(20);
    const vocabulary = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "benchmarks", "paraphrase", "vocab.example.json"),
        "utf8",
      ),
    ) as MemoryQueryVocabulary;
    const results = await runParaphraseBenchmark({
      dbPath: join(directory, "bench.db"),
      triples,
      vocabulary,
    });
    const byPath = new Map(results.map((r) => [r.path, r]));
    const plain = byPath.get("legacy-fts-plain")!;
    const porter = byPath.get("legacy-fts-porter")!;
    expect(plain.evaluated).toBe(20);
    expect(porter.evaluated).toBe(20);
    expect(porter.hitAt3).toBeGreaterThanOrEqual(plain.hitAt3);
    expect(porter.hitAt3).toBeGreaterThan(0.5);
    expect(byPath.get("legacy-recall")!.evaluated).toBe(20);
    expect(byPath.get("legacy-recall+expansion")!.evaluated).toBe(20);
    expect(byPath.get("legacy-recall+expansion")!.hitAt3).toBeGreaterThanOrEqual(
      byPath.get("legacy-recall")!.hitAt3 - 0.1,
    );
    expect(byPath.get("durable-lexical")!.evaluated).toBe(20);
    expect(byPath.get("durable-lexical")!.hitAt3).toBeGreaterThan(0.5);
    expect(byPath.get("durable-hybrid")!.skipped).toContain("embeddings");
    // Every domain is represented in the per-domain breakdown.
    expect(Object.keys(porter.byDomain).sort()).toEqual([
      "dev",
      "ops",
      "personal-preference",
      "scheduling",
    ]);
    const table = renderTable(results);
    expect(table).toContain("legacy-fts-porter");
    expect(table).toContain("skipped");
  }, 60_000);
});

describe("query expansion", () => {
  it("mines alias phrasing deterministically and ignores glosses", () => {
    const rules = aliasRulesFromText(
      "Check the runbook (playbook) before the deployment, aka the rollout. " +
        "Note types: observation (what you see). The on-call engineer (also called the pager holder) rotates.",
    );
    const pairs = rules.flatMap((r) => r.alternatives.map((a) => `${r.term} -> ${a}`));
    expect(pairs).toEqual([
      "deployment -> rollout",
      "rollout -> deployment",
      "on-call engineer -> pager holder",
      "pager holder -> on-call engineer",
      "runbook -> playbook",
      "playbook -> runbook",
    ]);
    expect(aliasRulesFromText("Plain prose without any alias markers at all.")).toEqual([]);
    expect(aliasRulesFromText("Use recall (recall) twice")).toEqual([]);
  });

  it("derives rules from a durable vocabulary definition", () => {
    const rules = vocabularyRulesFromDefinition({
      closed: false,
      predicates: {
        deploy_target: {
          object: "string",
          cardinality: "one",
          description: "aka release environment. Where a service ships.",
        },
        status: { object: "string", cardinality: "one" },
      },
    });
    expect(rules.map((r) => r.term)).toEqual([
      "deploy_target",
      "deploy target",
      "release environment",
    ]);
    expect(rules[1]!.alternatives).toEqual(["deploy_target", "release environment"]);
    const expansion = expansionFromVocabulary("which deploy_target hosts billing", {
      version: 3,
      definition: {
        closed: false,
        predicates: { deploy_target: { object: "string", cardinality: "one" } },
      },
    });
    expect(expansion).toEqual({
      policy: "vocabulary:v3",
      queries: ["which deploy target hosts billing"],
    });
    expect(
      expansionFromVocabulary("unrelated question", {
        version: 3,
        definition: {
          closed: false,
          predicates: { deploy_target: { object: "string", cardinality: "one" } },
        },
      }),
    ).toBeUndefined();
  });

  it("caps expanded queries at five and fuses ranked lists deterministically", () => {
    const queries = expandedFtsQueries("a", {
      policy: "p",
      queries: ["b", "A", "c", "d", "e", "f"],
    });
    expect(queries).toEqual(["a", "b", "c", "d", "e"]);
    const fused = fuseRecallResults(
      [
        [{ id: 1 }, { id: 2 }, { id: 3 }],
        [{ id: 3 }, { id: 9 }],
        [{ id: 3 }, { id: 2 }],
      ],
      (row) => row.id,
      3,
    );
    // 3: 1/63 + 2*(0.5/61); 2: 1/62 + 0.5/62; 1: 1/61 — alternatives share one unit.
    expect(fused.map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("autoVocabularySeed + expansionForEntity", () => {
  let directory: string;
  let db: MarinaDB;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-vocab-seed-"));
    db = new MarinaDB(join(directory, "seed.db"));
    // Pin the world service to lexical regardless of the developer's .env.
    worldMemoryService(db, {});
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns [] without a guide pool or without alias phrasing", () => {
    expect(autoVocabularySeed(db)).toEqual([]);
    db.createMemoryPool("pool-guide", "guide", "system");
    db.addPoolNote("pool-guide", "system", "Use recall to search your notes.", 7);
    expect(autoVocabularySeed(db)).toEqual([]);
  });

  it("derives bounded synonym pairs from the guide's own phrasing", () => {
    db.createMemoryPool("pool-guide", "guide", "system");
    db.addPoolNote(
      "pool-guide",
      "system",
      "The compass (brief) shows pending intents. Standing, aka contribution score, decays.",
      7,
    );
    db.addPoolNote("pool-guide", "system", "A crew is also called a formation.", 6);
    const rules = autoVocabularySeed(db);
    const pairs = rules.flatMap((r) => r.alternatives.map((a) => `${r.term} -> ${a}`));
    expect(pairs).toContain("compass -> brief");
    expect(pairs).toContain("brief -> compass");
    expect(pairs).toContain("standing -> contribution score");
    expect(pairs).toContain("crew -> formation");
    expect(pairs.length).toBeLessThanOrEqual(50);
    expect(autoVocabularySeed(db)).toEqual(rules);
  });

  it("is undefined for unknown entities and version-0 vocabularies, then applies an authored one", async () => {
    expect(await expansionForEntity(db, "Nobody", "deploy_target for billing")).toBeUndefined();
    db.createUser({ id: crypto.randomUUID(), name: "Alice" });
    expect(await expansionForEntity(db, "Alice", "deploy_target for billing")).toBeUndefined();
    const saved = await residentMemoryOperation(db, "Alice", {
      operation: "save_vocabulary",
      input: {
        expected_version: 0,
        definition: {
          closed: false,
          predicates: {
            deploy_target: { object: "string", cardinality: "one", description: "aka release env" },
          },
        },
      },
      key: "vocab:1",
    });
    expect((saved.result as { version: number }).version).toBe(1);
    const expansion = await expansionForEntity(db, "Alice", "deploy_target for billing");
    expect(expansion?.policy).toBe("vocabulary:v1");
    expect(expansion?.queries).toEqual(["deploy target for billing", "release env for billing"]);
    expect(expandedFtsQueries("deploy_target for billing", expansion)).toHaveLength(3);
  });
});
