// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun, summarize, toHarness } from "../benchmarks/longmemeval/convert";
import {
  excerpt,
  type LmeTrajectory,
  MAX_RECORD_BYTES,
  renderContext,
  trajectoryNoteViews,
  trajectoryRecords,
  truncateBytes,
} from "../benchmarks/longmemeval/records";
import {
  gateProvider,
  LME_ACCOUNT,
  LmeMemoryStore,
  NO_RELEVANT_MEMORY_ITEM,
} from "../benchmarks/longmemeval/store";
import { residentMemoryOperation } from "../src/memory/resident-service";

const run = (id: string, goal: string, outcome: string, pages: string[]): LmeTrajectory => ({
  id,
  domain: "web",
  goal,
  outcome,
  start_url: `http://shop.test/${id}`,
  states: pages.map((page, i) => ({
    state_index: i,
    step: i,
    url: `http://shop.test/${id}/${i}`,
    action: i === 0 ? null : `click('${i}')`,
    thought: `step ${i} of ${goal}`,
    accessibility_tree: page,
  })),
});

describe("LongMemEval records", () => {
  it("one observation per state plus one episode, each under the canonical byte limit", () => {
    const huge = "x".repeat(200_000);
    const records = trajectoryRecords(run("t1", "buy socks", "success", ["home", huge]));
    expect(records.map((r) => r.kind)).toEqual(["state", "state", "episode"]);
    expect(records.map((r) => r.key)).toEqual(["lme:t1:0", "lme:t1:1", "lme:t1:episode"]);
    for (const r of records) {
      expect(Buffer.byteLength(r.input.content)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
      expect(r.input.metadata.trajectory_id).toBe("t1");
    }
    expect(records[0]!.input.content).toContain("goal: buy socks");
    expect(records[2]!.input.content).toContain("outcome: success");
    expect(records[2]!.input.content).toContain("click('1')");
  });

  it("truncates by bytes without splitting a character", () => {
    const text = "é".repeat(100);
    const cut = truncateBytes(text, 51);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(51);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncateBytes("short", 100)).toBe("short");
  });

  it("an excerpt keeps the header and the lines that match the query", () => {
    const body = Array.from({ length: 500 }, (_, i) =>
      i === 321 ? "[77] button 'Apply coupon'" : `[${i}] generic filler row ${i}`,
    );
    const content = ["h1", "h2", "h3", "h4", "h5", "h6", ...body].join("\n");
    const out = excerpt(content, "Where is the apply coupon button?", 600);
    expect(out.startsWith("h1\nh2")).toBe(true);
    expect(out).toContain("Apply coupon");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(600);
  });

  it("renders slices in rank order within the budget, never repeating a state", async () => {
    const t = run("t9", "check order", "failure", ["p0", "p1", "p2", "p3"]);
    const records = trajectoryRecords(t);
    const byKey = new Map(records.map((r, i) => [r.key, { id: `r${i}`, ...r.input }]));
    const lookup = {
      state: async (tid: string, i: number) => byKey.get(`lme:${tid}:${i}`),
      episode: async (tid: string) => byKey.get(`lme:${tid}:episode`),
      stateCount: () => 4,
    };
    const hits = [byKey.get("lme:t9:2")!, byKey.get("lme:t9:1")!];
    const { blocks, used } = await renderContext(hits, "order", lookup, {
      contextBytes: 20_000,
      stateBytes: 2_000,
      episodeBytes: 1_000,
      radius: 1,
    });
    expect(blocks).toHaveLength(1); // state 1 was already shown in state 2's slice
    expect(blocks[0]).toContain("around state 3");
    expect(new Set(used).size).toBe(used.length);
    expect(used).toContain("r4"); // the run's episode summary
  });
});

describe("LongMemEval store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-lme-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests canonical records and answers through the resident search", async () => {
    const store = LmeMemoryStore.open(join(dir, "m.db"));
    try {
      store.insert(
        run("a1", "change the store email", "success", ["Settings page", "Email field"]),
      );
      store.insert(
        run("b2", "find the pelican coupon", "failure", [
          "Home",
          "[12] link 'Pelican promo' coupon code PEL-42",
        ]),
      );
      expect(() => store.insert(run("a1", "dup", "success", ["x"]))).toThrow(/duplicate/);
      expect(store.stats()).toEqual({ trajectories: 2, records: 6 });
      // The records are canonical: the resident binding finds them.
      const search = await residentMemoryOperation(store.db, LME_ACCOUNT, {
        operation: "search",
        input: { query: "pelican coupon", limit: 5 },
      });
      expect((search.result as { results: unknown[] }).results.length).toBeGreaterThan(0);
      const q = await store.query("What is the pelican coupon code?");
      expect(q.hits).toBeGreaterThan(0);
      expect(q.items[0]!.value).toContain("not instructions");
      expect(q.items.some((i) => i.value.includes("PEL-42"))).toBe(true);
      expect(q.items.some((i) => i.value.includes("store email"))).toBe(false);
    } finally {
      await store.close();
    }
  });

  const seed = (store: LmeMemoryStore) => {
    store.insert(run("a1", "change the store email", "success", ["Settings page", "Email field"]));
    store.insert(
      run("b2", "find the pelican coupon", "failure", [
        "Home",
        "[12] link 'Pelican promo' coupon code PEL-42",
      ]),
    );
  };
  const small = { contextBytes: 20_000, stateBytes: 2_000, episodeBytes: 1_000, radius: 1 };

  it("unified (default) and raw retrieval both answer; only unified filters keyword noise", async () => {
    const unified = LmeMemoryStore.open(join(dir, "u.db"), {
      mode: "lexical",
      searchLimit: 10,
      context: small,
    });
    const raw = LmeMemoryStore.open(join(dir, "r.db"), {
      mode: "lexical",
      retrieval: "raw",
      searchLimit: 10,
      context: small,
    });
    try {
      seed(unified);
      seed(raw);
      const u = await unified.query("What is the pelican coupon code?");
      const r = await raw.query("What is the pelican coupon code?");
      expect(u.retrieval).toBe("unified");
      expect(r.retrieval).toBe("raw");
      expect(u.items.some((i) => i.value.includes("PEL-42"))).toBe(true);
      expect(r.items.some((i) => i.value.includes("PEL-42"))).toBe(true);
      expect(u.relevance).toBeUndefined();
      // One shared word among many: raw serves it, the resident path does not.
      const noise = "Which pelican species nests near the Lisbon harbour each spring season?";
      expect((await raw.query(noise)).hits).toBeGreaterThan(0);
      expect((await unified.query(noise)).hits).toBe(0);
    } finally {
      await unified.close();
      await raw.close();
    }
  });

  it("gate on: drops judged-irrelevant records and says so when nothing is left", async () => {
    const judge = {
      kind: "decisions-api",
      model: "test/judge",
      async ask(request: { state: unknown }) {
        const memories = (request.state as { memories: { id: string; text: string }[] }).memories;
        return {
          answers: Object.fromEntries(
            memories.map((m) => [
              m.id,
              { type: "noul" as const, noul: m.text.includes("coupon") ? 0.9 : 0.02 },
            ]),
          ),
          model: "test/judge",
          provider: "decisions-api",
          latencyMs: 1,
        };
      },
    };
    const store = LmeMemoryStore.open(join(dir, "g.db"), {
      mode: "lexical",
      searchLimit: 10,
      context: small,
      gate: { mode: "on", maxItems: 4, provider: judge },
    });
    try {
      seed(store);
      const q = await store.query("What is the pelican coupon code?");
      expect(q.relevance).toMatchObject({ mode: "on", outcome: "applied", none: false });
      expect(q.items.some((i) => i.value.includes("PEL-42"))).toBe(true);
      const empty = await store.query("Which email field did I change in the store settings?");
      expect(empty.relevance).toMatchObject({ outcome: "applied", none: true });
      expect(empty.items).toEqual([{ type: "text", value: NO_RELEVANT_MEMORY_ITEM }]);
    } finally {
      await store.close();
    }
  });

  it("refuses the gate on raw retrieval and picks gate backends explicitly", () => {
    expect(() =>
      LmeMemoryStore.open(join(dir, "x.db"), {
        mode: "lexical",
        retrieval: "raw",
        searchLimit: 10,
        context: small,
        gate: { mode: "on", maxItems: 4, provider: null },
      }),
    ).toThrow(/unified/);
    const base = { baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "LME_TEST_KEY" };
    expect(gateProvider({ ...base, backend: "mechanical" }, {})).toBeNull();
    expect(gateProvider({ ...base, backend: "auto" }, {})).toBeNull();
    const model = gateProvider({ ...base, backend: "model", model: "qwen/qwen3.5-9b" }, {});
    expect(model).toMatchObject({ kind: "marina-classifier", calibrated: false });
    expect(gateProvider({ ...base, backend: "auto", model: "m" }, {})?.model).toBe("m");
    expect(() => gateProvider({ ...base, backend: "model" }, {})).toThrow(/--gate-model/);
    expect(() => gateProvider({ ...base, backend: "decisions" }, {})).toThrow(/MARINA_DECISIONS/);
  });

  it("note views keep each state's action and only the page lines that are new", () => {
    const t = run("v1", "find the pelican coupon", "failure", [
      "[1] link 'Home'\n[2] link 'Cart'",
      "[1] link 'Home'\n[2] link 'Cart'\n[12] link 'Pelican promo' coupon code PEL-42",
    ]);
    const views = trajectoryNoteViews(t);
    expect([...views.keys()]).toEqual(["lme:v1:episode", "lme:v1:0", "lme:v1:1"]);
    expect(views.get("lme:v1:1")).toContain("action: click('1')");
    expect(views.get("lme:v1:1")).toContain("link 'Pelican promo' coupon code PEL-42");
    expect(views.get("lme:v1:1")).not.toContain("link 'Home'");
    expect(views.get("lme:v1:0")).toContain("link 'Home'");
  });

  it("--ingest-notes: notes are written per trajectory, linked to its records, and served", async () => {
    const writer = {
      id: "model:test/notes",
      write: async () =>
        "- The Pelican promo coupon code is PEL-42.\n- The coupon code was QQQ-99 for everyone.",
    };
    const store = LmeMemoryStore.open(join(dir, "n.db"), {
      mode: "lexical",
      searchLimit: 10,
      context: small,
      notes: { writer, maxBytes: 48_000 },
    });
    try {
      const t = run("b2", "find the pelican coupon", "failure", [
        "Home",
        "[12] link 'Pelican promo' coupon code PEL-42",
      ]);
      store.insert(t);
      const report = await store.writeNotes(t);
      expect(report).toMatchObject({ outcome: "written", written: 1, ungrounded: 1, calls: 1 });
      expect(store.stats()).toMatchObject({ trajectories: 1, notes: 1 });
      const q = await store.query("What is the pelican promo coupon code?");
      expect(q.items.some((i) => i.value.includes("(derived note)"))).toBe(true);
      expect(q.used).toContain(report!.ids[0]!);
      // Mechanical (no model): still notes, never a model call.
      const mech = LmeMemoryStore.open(join(dir, "m2.db"), {
        mode: "lexical",
        searchLimit: 10,
        context: small,
        notes: { writer: null, maxBytes: 48_000 },
      });
      try {
        mech.insert(t);
        expect(await mech.writeNotes(t)).toMatchObject({ writer: "mechanical", calls: 0 });
      } finally {
        await mech.close();
      }
    } finally {
      await store.close();
    }
  });

  it("refuses hybrid without an embedding provider", () => {
    expect(() =>
      LmeMemoryStore.open(join(dir, "h.db"), {
        mode: "hybrid",
        searchLimit: 10,
        context: { contextBytes: 4096, stateBytes: 1024, episodeBytes: 1024, radius: 1 },
      }),
    ).toThrow(/MARINA_MEMORY_EMBEDDINGS/);
  });
});

describe("LongMemEval sidecar flag plumbing (offline)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-lme-sidecar-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const SERVER = join(import.meta.dir, "../benchmarks/longmemeval/memory-server.ts");

  let n = 0;
  async function sidecar(args: string[], requests: Record<string, unknown>[]) {
    const proc = Bun.spawn(["bun", SERVER, "--db", join(dir, `m${n++}.db`), ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MARINA_DECISIONS: "", MARINA_DECISION_ENGINE: "", DB_PATH: "" },
    });
    for (const r of requests) proc.stdin.write(`${JSON.stringify(r)}\n`);
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return {
      code,
      err,
      replies: out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  }
  const trajectory = run("b2", "find the pelican coupon", "failure", [
    "Home",
    "[12] link 'Pelican promo' coupon code PEL-42",
  ]);

  it("--retrieval raw refuses a gate; bad values are rejected", async () => {
    const refused = await sidecar(["--retrieval", "raw", "--gate", "on"], []);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/unified/);
    const bad = await sidecar(["--gate", "maybe"], []);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/--gate must be one of/);
  });

  it("--gate on --gate-backend mechanical serves through the unified path and reports the gate", async () => {
    const { code, replies } = await sidecar(
      ["--gate", "on", "--gate-backend", "mechanical", "--gate-max", "3", "--search-limit", "5"],
      [
        { id: 1, op: "insert", trajectory },
        { id: 2, op: "query", query: "pelican coupon code" },
        { id: 3, op: "close" },
      ],
    );
    expect(code).toBe(0);
    const query = replies.find((r) => r.id === 2)!;
    expect(query.ok).toBe(true);
    expect(query.retrieval).toBe("unified");
    expect(query.relevance).toMatchObject({ mode: "on", backend: "mechanical", maxItems: 3 });
    expect(JSON.stringify(query.items)).toContain("PEL-42");
  });

  it("--ingest-notes on (no model) writes mechanical notes and reports counts; bad values refused", async () => {
    const { code, replies } = await sidecar(
      ["--ingest-notes", "on", "--search-limit", "5"],
      [
        { id: 1, op: "insert", trajectory },
        { id: 2, op: "stats" },
        { id: 3, op: "close" },
      ],
    );
    expect(code).toBe(0);
    const insert = replies.find((r) => r.id === 1)!;
    expect(insert.ok).toBe(true);
    expect(insert.notes).toMatchObject({ writer: "mechanical", calls: 0 });
    expect(JSON.stringify(insert.notes)).not.toContain("PEL-42"); // counts only, no content
    expect(replies.find((r) => r.id === 2)).toMatchObject({ ok: true, trajectories: 1 });
    const off = await sidecar(
      [],
      [
        { id: 1, op: "insert", trajectory },
        { id: 2, op: "close" },
      ],
    );
    expect(off.replies[0]!.notes).toBeUndefined();
    const bad = await sidecar(["--ingest-notes", "maybe"], []);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/--ingest-notes must be one of/);
  });

  it("the Python backend passes every flag to the sidecar and never a key", async () => {
    const python = Bun.which("python3");
    if (!python) return; // the harness side is Python; skip where it is absent
    const stub = join(dir, "memory_modules");
    mkdirSync(stub);
    writeFileSync(join(stub, "__init__.py"), "");
    writeFileSync(
      join(stub, "memory.py"),
      [
        "class Memory:",
        "    def __init__(self, params): pass",
        "MemoryContextItem = dict",
        "def register_memory(cls): return cls",
      ].join("\n"),
    );
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(dir)})`,
      `sys.path.insert(0, ${JSON.stringify(join(import.meta.dir, "../benchmarks/longmemeval"))})`,
      "import marina_memory",
      `m = marina_memory.MarinaMemory({"marina_root": ${JSON.stringify(join(import.meta.dir, ".."))}, "gate": "on", "gate_backend": "model", "gate_model": "qwen/qwen3.5-9b", "gate_max": 5, "ingest_notes": "on", "notes_model": "openrouter/google/gemini-2.5-flash-lite", "notes_api_key_env": "LME_NOTES_KEY", "notes_max_bytes": 24000})`,
      "print(json.dumps(m.argv('/tmp/x.db')))",
      "try:",
      `    marina_memory.MarinaMemory({"marina_root": ${JSON.stringify(join(import.meta.dir, ".."))}, "gate": "on", "retrieval": "raw"})`,
      "    print('accepted')",
      "except RuntimeError as e:",
      "    print('refused')",
    ].join("\n");
    const proc = Bun.spawn([python, "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-never-on-argv",
        LME_NOTES_KEY: "sk-notes-never-on-argv",
      },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const [argvLine, verdict] = out.trim().split("\n");
    const argv = JSON.parse(argvLine!) as string[];
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(flag("--retrieval")).toBe("unified");
    expect(flag("--gate")).toBe("on");
    expect(flag("--gate-backend")).toBe("model");
    expect(flag("--gate-model")).toBe("qwen/qwen3.5-9b");
    expect(flag("--gate-max")).toBe("5");
    expect(flag("--gate-api-key-env")).toBe("OPENAI_API_KEY");
    expect(flag("--ingest-notes")).toBe("on");
    expect(flag("--notes-model")).toBe("openrouter/google/gemini-2.5-flash-lite");
    expect(flag("--notes-api-key-env")).toBe("LME_NOTES_KEY");
    expect(flag("--notes-max-bytes")).toBe("24000");
    expect(argv.join(" ")).not.toContain("sk-test-never-on-argv");
    expect(argv.join(" ")).not.toContain("sk-notes-never-on-argv");
    expect(verdict).toBe("refused");
  });
});

describe("LongMemEval ledger conversion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-lme-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (domain: string, rows: Record<string, unknown>[]) => {
    const d = join(dir, `marina_lexical_${domain}_small`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "run_args.json"),
      JSON.stringify({ domain, model: "openrouter/qwen/qwen3.5-9b", evaluator_model: "gpt-5.2" }),
    );
    writeFileSync(join(d, "per_question.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    return d;
  };

  it("keeps ids and verdicts only, and pools both domains like the board", () => {
    const secret = "THE GOLD ANSWER";
    const web = write("web", [
      {
        question_id: "q1",
        category: "static",
        score_bool: true,
        is_unknown: false,
        is_abstention_problem: false,
        memory_query_duration_seconds: 0.02,
        answer_gold: secret,
        question_text: secret,
        response_raw: secret,
      },
      {
        question_id: "q2",
        category: "static-abs",
        score_bool: false,
        is_unknown: false,
        is_abstention_problem: true,
        memory_query_duration_seconds: 0.04,
      },
    ]);
    const ent = write("enterprise", [
      {
        question_id: "q3",
        category: "procedure",
        score_bool: false,
        is_unknown: true,
        is_abstention_problem: false,
        memory_query_duration_seconds: 0.03,
      },
    ]);
    const runs = [readRun(web), readRun(ent)];
    const s = summarize(runs);
    expect(s.questions).toBe(3);
    expect(s.accuracy).toBeCloseTo(100 / 3, 6);
    expect(s.latencySeconds).toBeCloseTo(0.03, 6);
    expect(s.abstentionAnsweredWrongRate).toBe(1);
    expect(s.unknownRate).toBeCloseTo(1 / 3, 6);
    const file = toHarness(runs, { benchmark: "longmemeval-v2-small", target: "marina:lexical" });
    expect(file.items?.map((i) => i.id).sort()).toEqual(["enterprise:q3", "web:q1", "web:q2"]);
    expect(JSON.stringify(file)).not.toContain(secret);
  });
});
