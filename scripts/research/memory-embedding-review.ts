// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Boundary diagnostic, not an answer-quality benchmark. Optional argv[2] is an
 * existing local model cache; localOnly prevents any model downloads. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localEmbeddings } from "../../src/memory/local-embeddings";
import { MemoryService } from "../../src/memory/service";
import { MemoryError } from "../../src/memory/service-types";
import { MarinaDB } from "../../src/persistence/database";

const directory = mkdtempSync(join(tmpdir(), "marina-memory-review-"));
const db = new MarinaDB(join(directory, "review.db"));
const native = new MemoryService(db);
try {
  const credential = db.issueMemoryCredential(
    db.ensurePrincipal({ type: "service", displayName: "review" }).principal_id,
  );
  const actor = db.verifyMemoryCredential(credential.token)!;
  const repo = native.repository;
  const space = repo.createSpace(actor, "review", "space").id;
  const cache = Bun.argv[2];
  const provider = cache ? await localEmbeddings(cache, true) : undefined;
  const indexed = provider ? new MemoryService(db, provider) : undefined;
  let attemptedEmbeddings = 0;
  const unavailable = new MemoryService(db, {
    id: "diagnostic:unavailable",
    async embed() {
      attemptedEmbeddings++;
      throw new Error("Embedding invocation forbidden in native diagnostic");
    },
  });
  const source = repo.capture(
    actor,
    space,
    { text: "archiveneedle: exact raw evidence" },
    "review",
    "source",
  );
  const records = [
    { content: "I avoid all animal products." },
    { content: "Travel from London to Paris on the Eurostar." },
    { content: "The release may proceed only after the security review is approved." },
    { content: "The telescope observes distant galaxies." },
    { content: "The orchestra rehearses on Mondays." },
    { content: "The database backup uses encrypted storage." },
    {
      content: "Project atlas is active.",
      claim: {
        subject: "project:atlas",
        predicate: "status",
        object: { kind: "literal" as const, value: "active" },
      },
    },
    {
      content: "Project atlas is paused.",
      claim: {
        subject: "project:atlas",
        predicate: "status",
        object: { kind: "literal" as const, value: "paused" },
      },
    },
  ];
  for (const [i, input] of records.entries())
    repo.remember(actor, space, input, `record-${i}`, provider?.id);
  const sourceSearch = await native.search(actor, space, { query: "archiveneedle" });
  const exact = unavailable.repository.query(actor, space, {
    subject: "project:atlas",
    predicate: "status",
  });
  const lexical = await unavailable.search(actor, space, { query: "Eurostar", mode: "lexical" });
  unavailable.repository.graph(actor, space, { subject: "project:atlas" });
  let beforeIndex: unknown = null;
  if (indexed) {
    try {
      await indexed.search(actor, space, { query: "Eurostar" });
      beforeIndex = { returned: true };
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      beforeIndex = { status: error.status, code: error.code, message: error.message };
    }
    await indexed.runIndexJobs(100);
  }
  const queries = [
    "vegan diet",
    "cross-channel rail journey",
    "conditions before shipping software",
    "quasizorbium",
    "What is the submarine captain's birthday?",
  ];
  const observations = [];
  for (const query of queries) {
    const lexicalResult = await native.search(actor, space, { query, limit: 3 });
    const hybridResult = indexed
      ? await indexed.search(actor, space, { query, limit: 3 })
      : undefined;
    observations.push({
      query,
      lexical: lexicalResult.results.map((record) => record.content),
      hybrid: hybridResult?.results.map((record) => record.content),
    });
  }
  console.log(
    JSON.stringify(
      {
        schema: "marina.memory.embedding-review.v1",
        observed_at: new Date().toISOString(),
        model: provider?.id ?? null,
        records: records.length,
        native_embedding_calls: attemptedEmbeddings,
        native_lexical_results: lexical.results.length,
        captured_source_retrievable_by_cursor: repo
          .sources(actor, space)
          .some((item) => item.id === source.id),
        captured_source_search_results: sourceSearch.results.length,
        contradictory_active_claims: exact.results.map((record) => record.claim?.object),
        default_search_before_index: beforeIndex,
        observations,
        limits:
          "Eight handcrafted records and five diagnostic queries; direct service calls, no task-quality, held-out retrieval, HTTP or scale benchmark. Nonempty results are candidates, not asserted answers.",
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true });
}
