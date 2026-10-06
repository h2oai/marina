// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportTaskCache,
  m2w2Hash,
  m2w2StorageUrl,
  pyUnquote,
} from "../benchmarks/mind2web2/cache-export";
import { answerOutcome, itemId } from "../benchmarks/mind2web2/ledger";
import { ARMS, M2W2_DENY, M2W2_EXCLUDE } from "../benchmarks/mind2web2/run";
import { metrics, pairedDifference, scoredAnswers } from "../benchmarks/mind2web2/score";
import { parseCsv, splitTasks, taskFromScript, tasksFromCsv } from "../benchmarks/mind2web2/tasks";
import { excludedSource } from "../src/arena/research/web-search";
import type { SearchProvider } from "../src/engine/search-providers/index";
import { guardedFetch } from "../src/net/url-guard";
import { BARRED_REASON, deniedByPattern } from "../src/research/page-reader";
import { ProvenanceCache } from "../src/research/provenance-cache";
import { researchEnvironment, withLessons } from "../src/research/web-agent";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "m2w2-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("tasks", () => {
  test("reads TASK_ID and TASK_DESCRIPTION from a judge script and nothing else", () => {
    const src =
      'import x\nTASK_ID = "yu_lineage"\nTASK_DESCRIPTION = """\nTrace the lineage.\n"""\nGROUND_TRUTH = ["secret"]\n';
    expect(taskFromScript(src)).toEqual({ id: "yu_lineage", description: "Trace the lineage." });
    expect(taskFromScript("TASK_ID = 'x'")).toBeUndefined();
  });

  test("task-list CSV with quoted multi-line descriptions", () => {
    const csv =
      'task_id,domain,task_description\nt1,a,"Find ""two"" things,\nthen stop."\nt2,b,Simple\n';
    expect(parseCsv(csv)[1]).toEqual(["t1", "a", 'Find "two" things,\nthen stop.']);
    expect(tasksFromCsv(csv)).toEqual([
      { id: "t1", description: 'Find "two" things,\nthen stop.' },
      { id: "t2", description: "Simple" },
    ]);
    expect(() => tasksFromCsv("task_id,domain\nx,y\n")).toThrow("task list needs");
  });

  test("the pre-registered dev split is reproduced", () => {
    const ids = [
      "ad_patent",
      "animation_movies",
      "buy_monitor",
      "find_parks",
      "llava_commit",
      "lol_sylas",
      "nyc_sport_event",
      "overleaf_template",
      "spotify_artists",
      "yu_lineage",
    ].map((id) => ({ id }));
    const { tune, heldOut } = splitTasks(ids, 3, "m2w2-2026-10");
    expect(tune.map((t) => t.id)).toEqual(["llava_commit", "buy_monitor", "animation_movies"]);
    expect(heldOut).toHaveLength(7);
  });
});

describe("cache export", () => {
  test("storage form and md5 match the official CacheFileSys", () => {
    // Reference values computed with mind2web2/utils/cache_filesys.py (main @ 1fcbfda).
    expect(m2w2StorageUrl("https://example.com/a%20b/?q=1#frag")).toBe(
      "https://example.com/a b/?q=1",
    );
    expect(m2w2Hash("https://example.com/a%20b/?q=1#frag")).toBe(
      "802ad2819bda69b62a2b1db77024e04b",
    );
    expect(m2w2Hash("https://en.wikipedia.org/wiki/Caf%C3%A9/")).toBe(
      "8d59c7b0ecb6ec5be8ef6241ed1d9c63",
    );
    expect(m2w2Hash("https://x.org/")).toBe("36cbf341ff0fadb60ae571a6fad90022");
    expect(m2w2Hash("https://x.org/p%E9")).toBe("9e77ec24686a1842586bd4cf54f6ef79");
    expect(pyUnquote("a%2Fb%")).toBe("a/b%");
  });

  test("exports read pages (latest read wins), PDFs, and leaves unread URLs to the judge", () => {
    const a = new ProvenanceCache(join(tempDir(), "1"));
    const b = new ProvenanceCache(join(tempDir(), "2"));
    a.record({
      url: "https://s.org/p",
      status: 200,
      text: "old",
      fetchedAt: new Date("2026-10-01T00:00:00Z"),
    });
    b.record({
      url: "https://s.org/p",
      status: 200,
      text: "new",
      fetchedAt: new Date("2026-10-02T00:00:00Z"),
    });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    a.record({
      url: "https://s.org/d.pdf",
      status: 200,
      contentType: "application/pdf",
      body: pdf,
      text: "t",
    });
    a.record({ url: "https://s.org/blocked", status: 403, error: "HTTP 403" });
    const out = join(tempDir(), "task");
    const stats = exportTaskCache(
      [a, b],
      ["https://s.org/p#x", "https://s.org/d.pdf", "https://s.org/blocked", "https://s.org/never"],
      out,
    );
    expect(stats).toEqual({ urls: 4, exported: 2, pdf: 1, present: 0, notRead: 2 });
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(index).toEqual({ "https://s.org/p": "web", "https://s.org/d.pdf": "pdf" });
    expect(readFileSync(join(out, `${m2w2Hash("https://s.org/p")}.txt`), "utf8")).toBe("new");
    expect(existsSync(join(out, `${m2w2Hash("https://s.org/p")}.jpg`))).toBe(true);
    expect([...readFileSync(join(out, `${m2w2Hash("https://s.org/d.pdf")}.pdf`))]).toEqual([
      ...pdf,
    ]);
    // A second export keeps what is there.
    expect(exportTaskCache([a, b], ["https://s.org/p"], out).present).toBe(1);
  });
});

describe("arms and policy", () => {
  test("the benchmark's own pages are on the deny list", () => {
    for (const url of [
      "https://huggingface.co/datasets/osunlp/Mind2Web-2/blob/main/evaluation_scripts/2025_10_23/x.py",
      "https://github.com/OSU-NLP-Group/Mind2Web-2/tree/main/eval_scripts",
      "https://osu-nlp-group.github.io/Mind2Web-2/",
    ]) {
      expect(deniedByPattern(url, M2W2_DENY)).toBe(true);
    }
    expect(deniedByPattern("https://github.com/huggingface/transformers", M2W2_DENY)).toBe(false);
  });

  test("barred sources cover the dataset, forks, proxies, archives, the paper and mirrors by title", () => {
    const barred = excludedSource(M2W2_EXCLUDE);
    for (const url of [
      "https://huggingface.co/datasets/osunlp/Mind2Web-2/resolve/main/test_set.csv",
      "https://hf.co/datasets/osunlp/Mind2Web-2",
      "https://datasets-server.huggingface.co/rows?dataset=osunlp%2FMind2Web-2",
      "https://huggingface.co/datasets/someone/Mind2Web-2",
      "https://github.com/OSU-NLP-Group/Mind2Web-2/tree/main/eval_scripts",
      "https://github.com/a-fork-owner/Mind2Web-2/blob/main/run_eval.py",
      "https://raw.githubusercontent.com/OSU-NLP-Group/Mind2Web-2/main/README.md",
      "https://osu-nlp-group.github.io/Mind2Web-2/leaderboard_data.json",
      "https://arxiv.org/abs/2506.21506v2",
      "https://r.jina.ai/https://github.com/OSU-NLP-Group/Mind2Web-2",
      "https://web.archive.org/web/2025/https://osu-nlp-group.github.io/Mind2Web-2/",
      "https://web.archive.org/web/2025/github.com/OSU-NLP-Group/Mind2Web-2",
      "https://redirect.example.org/go?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Fosunlp%2FMind2Web-2",
      "https://github.com/RDI-Foundation/mind2web2-agentbeats-leaderboard",
      "https://github.zh-ak.com/OSU-NLP-Group/Mind2Web-2",
      "https://deepwiki.com/OSU-NLP-Group/Mind2Web-2",
      "https://openreview.net/forum?id=AUaW6DS9si&noteId=8JJiUryMhc",
      "https://proceedings.neurips.cc/paper_files/paper/2025/file/fdcec9f5b99aa4fc8f4fb8487802d737-Paper-Datasets_and_Benchmarks_Track.pdf",
      "https://hf-p-cfw.fyan.top/datasets/osunlp/Mind2Web-2/resolve/main/test_set.csv",
      "https://82.156.9.71:9000/OSU-NLP-Group/Mind2Web-2",
      "https://github.com/OSU-NLP-Group/QUEST/tree/main/evaluation/Mind2Web2/x/eval_scripts",
      "https://deepwiki.com/ace-agent/ace/5.1-mind2web2-task-overview-and-data",
      "https://mind2web.benchmarkhotline.org/",
      "https://www.scribd.com/document/885769297/Evaluating-Agentic-Search-With-Agent-As-A-Judge",
    ]) {
      expect([url, barred(url)]).toEqual([url, true]);
    }
    expect(
      barred(
        "https://mirror.example.org/x",
        "Mind2Web 2: Evaluating Agentic Search with Agent-as-a-Judge",
      ),
    ).toBe(true);
    expect(barred("https://example.org/x", "osunlp/Mind2Web-2 · Datasets at Hugging Face")).toBe(
      true,
    );
    // Not barred: the first Mind2Web, unrelated repositories, ordinary pages.
    for (const url of [
      "https://huggingface.co/datasets/osunlp/Mind2Web",
      "https://github.com/huggingface/transformers",
      "https://github.com/someone/Mind2Web",
      "https://www.imdb.com/title/tt0110357/",
    ]) {
      expect([url, barred(url)]).toEqual([url, false]);
    }
  });

  test("a research environment drops barred search results and refuses barred reads", async () => {
    const backend: SearchProvider = {
      name: "fake",
      engines: ["web"],
      search: async () => [
        {
          title: "Dataset",
          url: "https://huggingface.co/datasets/osunlp/Mind2Web-2",
          snippet: "",
          source: "f",
        },
        {
          title: "Mind2Web 2 Leaderboard",
          url: "https://elsewhere.example.org/lb",
          snippet: "",
          source: "f",
        },
        { title: "Good", url: "https://good.example.org/p", snippet: "", source: "f" },
      ],
    };
    const dir = mkdtempSync(join(tmpdir(), "m2w2-bar-"));
    try {
      const env = researchEnvironment({
        cache: new ProvenanceCache(dir),
        exclude: M2W2_EXCLUDE,
        backends: [backend],
      });
      const hits = await env.search("mind2web 2 test answers", 8);
      expect(hits.map((h) => h.url)).toEqual(["https://good.example.org/p"]);
      expect(env.stats.searchBarred).toBe(2);
      // The default reader refuses before any request (no network in this test).
      for (const url of [
        "https://github.com/OSU-NLP-Group/Mind2Web-2",
        "https://r.jina.ai/https://huggingface.co/datasets/osunlp/Mind2Web-2",
      ]) {
        const r = await env.read(url);
        expect(r.ok).toBe(false);
        expect(r.refused).toBe(true);
        expect(r.error).toBe(BARRED_REASON);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guardedFetch applies a caller's hop policy before any request", async () => {
    await expect(
      guardedFetch(
        "https://github.com/OSU-NLP-Group/Mind2Web-2",
        {},
        { refuseHop: () => "barred" },
      ),
    ).rejects.toThrow("barred");
  });

  test("the full arm turns on the swarm and a cross-vendor verifier", () => {
    expect(ARMS.full!.formation.kind).toBe("lead");
    expect(ARMS.full!.swarmReader).toBeDefined();
    expect(ARMS.full!.verifier!.split("/")[0]).not.toBe(ARMS.full!.lead.split("/")[0]);
  });

  test("lessons are appended to instructions only when there are some", () => {
    expect(withLessons("S", [])).toBe("S");
    expect(withLessons("S", ["cite pages you opened"])).toContain("- cite pages you opened");
  });

  test("the lead arm checks citations with a different model than it writes with", () => {
    expect(ARMS.lead!.verifier).toBeDefined();
    expect(ARMS.lead!.verifier!.split("/")[0]).not.toBe(ARMS.lead!.lead.split("/")[0]);
    expect(ARMS.single!.formation.kind).toBe("single");
  });
});

describe("scoring", () => {
  function writeResult(
    out: string,
    agent: string,
    task: string,
    k: number,
    score: number,
    ts = "2026",
  ) {
    const dir = join(out, "eval_results", agent, task, `answer_${k}`, "results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ts}_answer_${k}.md.json`), JSON.stringify({ final_score: score }));
  }
  function writeRecord(out: string, agent: string, task: string, k: number, status: string) {
    const dir = join(out, "runs", agent, task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `answer_${k}.json`),
      JSON.stringify({
        task,
        agent,
        k,
        status,
        costUsd: 1,
        seconds: 1,
        startedAt: "2026-10-05T00:00:00Z",
      }),
    );
  }

  test("latest result per answer; failed runs score 0; budget stops are not scored", () => {
    const out = tempDir();
    writeResult(out, "A", "t1", 1, 0.2, "2026-01");
    writeResult(out, "A", "t1", 1, 1, "2026-02");
    writeResult(out, "A", "t1", 2, 0.5);
    writeRecord(out, "A", "t2", 1, "error");
    writeRecord(out, "A", "t3", 1, "budget");
    const s = scoredAnswers(out, "A");
    expect(s.map((x) => `${x.task}#${x.k}=${x.score}`).sort()).toEqual([
      "t1#1=1",
      "t1#2=0.5",
      "t2#1=0",
    ]);
    const m = metrics(s);
    expect(m.tasks).toBe(2);
    expect(m.partial).toBeCloseTo((0.75 + 0) / 2);
    expect(m.success).toBeCloseTo((0.5 + 0) / 2);
    expect(m.passAtK).toBeCloseTo(0.5);
    expect(scoredAnswers(out, "A", new Set(["t2"]))).toHaveLength(1);
  });

  test("paired difference over shared tasks", () => {
    const a = [
      { task: "x", k: 1, score: 0.2, source: "judge" as const },
      { task: "y", k: 1, score: 0.4, source: "judge" as const },
    ];
    const b = [
      { task: "x", k: 1, score: 0.6, source: "judge" as const },
      { task: "y", k: 1, score: 0.4, source: "judge" as const },
      { task: "z", k: 1, score: 1, source: "judge" as const },
    ];
    const d = pairedDifference(a, b, { resamples: 2000 });
    expect(d.tasks).toBe(2);
    expect(d.diff).toBeCloseTo(0.2);
    expect(d.lo).toBeGreaterThanOrEqual(0);
    expect(d.hi).toBeCloseTo(0.4);
  });

  test("an outcome carries ids and numbers, never the task or answer text", () => {
    const o = answerOutcome({
      arm: ARMS.single!,
      score: { task: "yu_lineage", k: 2, score: 0.5, source: "judge" },
      resolvedAt: "2026-10-05T00:00:00Z",
      ledgerRunId: "bench_x",
      privateContext: "SECRET TASK TEXT",
    });
    expect(itemId("yu_lineage", 2)).toBe("yu_lineage#2");
    expect(o.refs).toEqual(["bench-item:mind2web2:yu_lineage#2", "bench:bench_x"]);
    expect(o.succeeded).toBe(false);
    const visible = JSON.stringify({ ...o, privateContext: undefined });
    expect(visible).not.toContain("SECRET");
  });
});
