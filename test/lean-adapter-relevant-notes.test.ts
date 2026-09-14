// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The continuation prompt's §4 "Relevant Memory" section renders the unified
 * context the server returns for `recall <focus> all` — skills as <example>
 * blocks, then `[trusted]`, `[evidence]`, `[proposal]`, and `[unverified — own
 * notes, verify before relying]`, in that order, budgeted server-side.
 *
 * When the server predates the unified payload (`context === null`) the
 * adapter falls back to the previous two-tier legacy render, so those
 * expectations are kept here as the fallback contract.
 *
 * The adapter constructor is I/O-free (MarinaClient connects only in
 * start()), so we drive buildContinuationPrompt directly with the backend's
 * `unifiedContext` / `search` / `searchSkills` stubbed — same technique as
 * lean-adapter-coding-task.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  LeanAgentAdapter,
  RELEVANT_NOTES_TRUSTED_LABEL,
  RELEVANT_NOTES_UNVERIFIED_LABEL,
  renderRelevantNoteTiers,
} from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend, PlatformNoteResult } from "../src/agent/memory-platform";
import {
  byteLength,
  UNIFIED_CONTEXT_HEADER,
  UNIFIED_CONTEXT_SCHEMA,
  UNIFIED_TIER_LABELS,
  UNIFIED_TIER_ORDER,
  type UnifiedContextItem,
  type UnifiedContextResult,
  type UnifiedTier,
} from "../src/memory/unified-context";

const HEADER = UNIFIED_CONTEXT_HEADER;
const FOCUS = "deploy the pipeline";

type AdapterInternals = {
  buildContinuationPrompt(): Promise<string>;
  focus: { description: string; startedAt: number } | null;
  platformMemory: PlatformMemoryBackend;
  currentTrustSources: Set<string>;
  lastNotesQuery: string;
  notesCacheAge: number;
};

function note(id: string, content: string, importance = 5): PlatformNoteResult {
  return { id, content, importance, score: 0.9, noteType: "observation" };
}

type ItemSpec = Pick<UnifiedContextItem, "tier" | "id" | "content"> &
  Partial<Pick<UnifiedContextItem, "provenance" | "meta" | "score">>;

/** Hand-built unified payload with the given items (all five tiers present, empty when unused). */
function unified(
  items: ItemSpec[],
  degraded: UnifiedContextResult["degraded"] = [],
): UnifiedContextResult {
  const tiers = UNIFIED_TIER_ORDER.map((tier: UnifiedTier) => ({
    tier,
    label: UNIFIED_TIER_LABELS[tier],
    items: items
      .filter((i) => i.tier === tier)
      .map((i) => ({
        provenance: `#${i.id} imp=5`,
        score: 1,
        meta: { importance: 5 },
        ...i,
        bytes: byteLength(i.content),
      })),
    omitted: 0,
  }));
  return {
    schema: UNIFIED_CONTEXT_SCHEMA,
    entity: "tester",
    query: FOCUS,
    scope: "all",
    budgetBytes: 2048,
    usedBytes: tiers.reduce((n, t) => n + t.items.reduce((m, i) => m + i.bytes, 0), 0),
    truncated: false,
    tiers,
    degraded,
  };
}

/**
 * Adapter with focus set and the memory backend stubbed. `context` is what
 * `unifiedContext` returns (null → legacy fallback path using `search` /
 * `searchSkills`). Records every call so tests can assert which path ran and
 * that the cache short-circuits re-queries.
 */
function makeFocusedAdapter(
  name: string,
  context: UnifiedContextResult | null,
  fallback: { trusted: PlatformNoteResult[]; ordinary: PlatformNoteResult[] } = {
    trusted: [],
    ordinary: [],
  },
  skills: PlatformNoteResult[] = [],
) {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as AdapterInternals;
  internals.focus = { description: FOCUS, startedAt: Date.now() };
  const searchCalls: Array<{ query: string; trusted: boolean }> = [];
  const unifiedCalls: Array<{ query: string; budget?: number }> = [];
  const backend = internals.platformMemory as unknown as {
    search: PlatformMemoryBackend["search"];
    searchSkills: PlatformMemoryBackend["searchSkills"];
    unifiedContext: PlatformMemoryBackend["unifiedContext"];
  };
  backend.unifiedContext = async (query, budget) => {
    unifiedCalls.push({ query, budget });
    return { success: context !== null, text: "", context };
  };
  backend.search = async (query, opts) => {
    searchCalls.push({ query, trusted: opts?.trusted === true });
    return {
      success: true,
      text: "",
      results: opts?.trusted ? fallback.trusted : fallback.ordinary,
    };
  };
  backend.searchSkills = async () => ({ success: true, text: "", results: skills });
  return { adapter, internals, searchCalls, unifiedCalls };
}

describe("renderRelevantNoteTiers (legacy fallback renderer)", () => {
  it("labels trusted first, dedups ordinary hits already trusted, caps at 5 overall", () => {
    const trusted = [note("1", "verified one"), note("2", "verified two")];
    const ordinary = [
      note("2", "verified two"), // already trusted — must not repeat
      note("3", "plain three"),
      note("4", "plain four"),
      note("5", "plain five"),
      note("6", "plain six"), // would be the 6th note — over the cap
    ];
    const blocks = renderRelevantNoteTiers(trusted, ordinary);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.startsWith(RELEVANT_NOTES_TRUSTED_LABEL)).toBe(true);
    expect(blocks[1]!.startsWith(RELEVANT_NOTES_UNVERIFIED_LABEL)).toBe(true);
    const joined = blocks.join("\n");
    expect(joined.match(/^- \[#/gm)).toHaveLength(5);
    expect(joined.match(/#2 /g)).toHaveLength(1);
    expect(joined).not.toContain("#6 ");
    expect(blocks[0]).toContain("verified one");
    expect(blocks[1]).not.toContain("verified one");
  });

  it("omits a tier that has nothing to show", () => {
    expect(renderRelevantNoteTiers([], [])).toEqual([]);
    const onlyPlain = renderRelevantNoteTiers([], [note("9", "plain")]);
    expect(onlyPlain).toHaveLength(1);
    expect(onlyPlain[0]).toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(onlyPlain[0]).not.toContain(RELEVANT_NOTES_TRUSTED_LABEL);
  });

  it("labels are the shared unified-context labels", () => {
    expect(RELEVANT_NOTES_TRUSTED_LABEL).toBe(UNIFIED_TIER_LABELS.trusted);
    expect(RELEVANT_NOTES_UNVERIFIED_LABEL).toBe(UNIFIED_TIER_LABELS.unverified);
  });
});

describe("continuation prompt — unified Relevant Memory (§4)", () => {
  it("renders all five tier labels, in order, from the server payload — without legacy recalls", async () => {
    const payload = unified([
      {
        tier: "skill",
        id: "7",
        content: "run tests; verify health",
        provenance: "#7 imp=6",
        meta: { importance: 6 },
      },
      {
        tier: "trusted",
        id: "21",
        content: "staging token lives in the vault",
        provenance: "#21 imp=7 verified",
      },
      {
        tier: "evidence",
        id: "rec_1",
        content: "Pipeline deploys from the release branch",
        provenance: "record rec_1 v1",
      },
      {
        tier: "evidence",
        id: "src_1",
        content: "runbook excerpt: deploy after the smoke suite",
        provenance: "source src_1 sha256:0123456789ab seq=3 excerpt",
      },
      {
        tier: "proposal",
        id: "job_1",
        content: "Deploy from release/2026-09 per the runbook.",
        provenance: "proposal job_1 librarian 1 citation",
      },
      {
        tier: "unverified",
        id: "22",
        content: "guess: deploys fail on Fridays",
        provenance: "#22 imp=5",
      },
    ]);
    const { internals, searchCalls, unifiedCalls } = makeFocusedAdapter(
      "relevant-unified",
      payload,
    );
    const prompt = await internals.buildContinuationPrompt();

    expect(prompt).toContain(HEADER);
    const section = prompt.slice(prompt.indexOf(HEADER));
    const positions = UNIFIED_TIER_ORDER.map((tier) => section.indexOf(UNIFIED_TIER_LABELS[tier]));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(section).toContain('<example skill="#7" imp="6">\nrun tests; verify health\n</example>');
    expect(section).toContain("- [#21 imp=7 verified] staging token lives in the vault");
    expect(section).toContain("- [record rec_1 v1] Pipeline deploys from the release branch");
    expect(section).toContain("- [source src_1 sha256:0123456789ab seq=3 excerpt]");
    expect(section).toContain(
      "- [proposal job_1 librarian 1 citation] Deploy from release/2026-09",
    );
    expect(section).toContain("- [#22 imp=5] guess: deploys fail on Fridays");

    // One server round-trip, budgeted; no legacy tier queries.
    expect(unifiedCalls).toEqual([{ query: FOCUS, budget: 2048 }]);
    expect(searchCalls).toEqual([]);
    expect(internals.currentTrustSources.has("memory")).toBe(true);
  });

  it("surfaces a degraded durable tier without hiding the legacy tiers", async () => {
    const payload = unified(
      [{ tier: "unverified", id: "11", content: "pipeline deploy needs the staging token first" }],
      [
        {
          tier: "evidence",
          code: "world_identity_required",
          message: "An active durable world account is required",
        },
      ],
    );
    const { internals } = makeFocusedAdapter("relevant-degraded", payload);
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(prompt).toContain("[#11 imp=5] pipeline deploy needs the staging token first");
    expect(prompt).toContain("[degraded]");
    expect(prompt).toContain("evidence: world_identity_required");
    expect(prompt).not.toContain(RELEVANT_NOTES_TRUSTED_LABEL);
  });

  it("caches per focus query — a second build with the same focus does not re-query", async () => {
    const payload = unified([{ tier: "unverified", id: "41", content: "plain" }]);
    const { internals, unifiedCalls } = makeFocusedAdapter("relevant-cache", payload);
    await internals.buildContinuationPrompt();
    expect(unifiedCalls).toHaveLength(1);
    await internals.buildContinuationPrompt();
    expect(unifiedCalls).toHaveLength(1);
    expect(internals.lastNotesQuery).toBe(FOCUS);
    expect(internals.notesCacheAge).toBe(1);
  });

  it("omits the section entirely when the unified payload has nothing to show", async () => {
    const { internals } = makeFocusedAdapter("relevant-empty", unified([]));
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).not.toContain(HEADER);
    expect(internals.currentTrustSources.has("memory")).toBe(false);
  });
});

describe("continuation prompt — legacy fallback when the server lacks the unified payload", () => {
  it("shows a plain unverified note under the unverified label (strict trusted must not hide own notes)", async () => {
    const { internals, searchCalls, unifiedCalls } = makeFocusedAdapter("fallback-plain", null, {
      trusted: [],
      ordinary: [note("11", "pipeline deploy needs the staging token first")],
    });
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(prompt).toContain("[#11 imp=5] pipeline deploy needs the staging token first");
    expect(prompt).not.toContain(RELEVANT_NOTES_TRUSTED_LABEL);
    expect(unifiedCalls).toHaveLength(1);
    expect(searchCalls.map((c) => c.trusted).sort()).toEqual([false, true]);
    for (const c of searchCalls) expect(c.query).toBe(FOCUS);
    expect(internals.currentTrustSources.has("memory")).toBe(true);
  });

  it("shows a verified note under the trusted label, and a note in both tiers exactly once", async () => {
    const shared = note("21", "staging token lives in the vault");
    const { internals } = makeFocusedAdapter("fallback-tiers", null, {
      trusted: [shared],
      ordinary: [shared, note("22", "guess: deploys fail on Fridays")],
    });
    const prompt = await internals.buildContinuationPrompt();
    const section = prompt.slice(prompt.indexOf(HEADER));
    const trustedAt = section.indexOf(RELEVANT_NOTES_TRUSTED_LABEL);
    const unverifiedAt = section.indexOf(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(trustedAt).toBeGreaterThan(-1);
    expect(unverifiedAt).toBeGreaterThan(trustedAt);
    expect(section.match(/#21 /g)).toHaveLength(1);
    expect(section.slice(trustedAt, unverifiedAt)).toContain("#21 ");
    expect(section.slice(unverifiedAt)).toContain("#22 ");
  });

  it("renders skills as <example> blocks ahead of both note tiers", async () => {
    const { internals } = makeFocusedAdapter(
      "fallback-skills",
      null,
      { trusted: [note("31", "verified")], ordinary: [note("32", "plain")] },
      [{ id: "7", content: "run tests; verify health", importance: 6, noteType: "skill" }],
    );
    const prompt = await internals.buildContinuationPrompt();
    const section = prompt.slice(prompt.indexOf(HEADER));
    const skillAt = section.indexOf('<example skill="#7"');
    expect(skillAt).toBeGreaterThan(-1);
    expect(skillAt).toBeLessThan(section.indexOf(RELEVANT_NOTES_TRUSTED_LABEL));
    expect(section.indexOf(RELEVANT_NOTES_TRUSTED_LABEL)).toBeLessThan(
      section.indexOf(RELEVANT_NOTES_UNVERIFIED_LABEL),
    );
  });
});
