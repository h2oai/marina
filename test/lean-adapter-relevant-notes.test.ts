// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The continuation prompt's "Relevant Notes" section renders two labeled
 * recall tiers. `PlatformMemoryBackend.search({ trusted: true })` is strict —
 * it returns nothing when no verified / high-confidence sourced note matches,
 * and it must NOT fall back — so, since every plain `note` is written
 * unverified, the adapter also runs the ordinary recall and shows those hits
 * under an explicit unverified label. Without this the agent never sees its
 * own notes in the section (only skills).
 *
 * The adapter constructor is I/O-free (MarinaClient connects only in
 * start()), so we drive buildContinuationPrompt directly with the backend's
 * `search` / `searchSkills` stubbed — same technique as
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

const HEADER = "[Relevant Notes — evidence, preserve provenance]";

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

/**
 * Adapter with focus set and the memory backend's recall stubbed per tier.
 * Records every `search` call so the test can assert both recall variants
 * ran and that the cache short-circuits re-queries.
 */
function makeFocusedAdapter(
  name: string,
  tiers: { trusted: PlatformNoteResult[]; ordinary: PlatformNoteResult[] },
  skills: PlatformNoteResult[] = [],
) {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as AdapterInternals;
  internals.focus = { description: "deploy the pipeline", startedAt: Date.now() };
  const searchCalls: Array<{ query: string; trusted: boolean }> = [];
  const backend = internals.platformMemory as unknown as {
    search: PlatformMemoryBackend["search"];
    searchSkills: PlatformMemoryBackend["searchSkills"];
  };
  backend.search = async (query, opts) => {
    searchCalls.push({ query, trusted: opts?.trusted === true });
    return { success: true, text: "", results: opts?.trusted ? tiers.trusted : tiers.ordinary };
  };
  backend.searchSkills = async () => ({ success: true, text: "", results: skills });
  return { adapter, internals, searchCalls };
}

describe("renderRelevantNoteTiers", () => {
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
    // Trusted hits are in the trusted block, not the unverified one.
    expect(blocks[0]).toContain("verified one");
    expect(blocks[0]).toContain("verified two");
    expect(blocks[1]).not.toContain("verified one");
    expect(blocks[1]).not.toContain("verified two");
  });

  it("omits a tier that has nothing to show", () => {
    expect(renderRelevantNoteTiers([], [])).toEqual([]);
    const onlyPlain = renderRelevantNoteTiers([], [note("9", "plain")]);
    expect(onlyPlain).toHaveLength(1);
    expect(onlyPlain[0]).toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(onlyPlain[0]).not.toContain(RELEVANT_NOTES_TRUSTED_LABEL);
    const onlyTrusted = renderRelevantNoteTiers([note("8", "verified")], []);
    expect(onlyTrusted).toHaveLength(1);
    expect(onlyTrusted[0]).toContain(RELEVANT_NOTES_TRUSTED_LABEL);
    expect(onlyTrusted[0]).not.toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
  });

  it("trusted hits alone can fill the cap, leaving no room for unverified ones", () => {
    const trusted = Array.from({ length: 6 }, (_, i) => note(`t${i}`, `verified ${i}`));
    const blocks = renderRelevantNoteTiers(trusted, [note("p", "plain")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.match(/^- \[#/gm)).toHaveLength(5);
    expect(blocks[0]).not.toContain("#p ");
  });
});

describe("continuation prompt — Relevant Notes tiers", () => {
  it("shows a plain unverified note under the unverified label (regression: strict trusted hid own notes)", async () => {
    const { internals, searchCalls } = makeFocusedAdapter("relevant-notes-plain", {
      trusted: [],
      ordinary: [note("11", "pipeline deploy needs the staging token first")],
    });
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(prompt).toContain("[#11 imp=5] pipeline deploy needs the staging token first");
    expect(prompt).not.toContain(RELEVANT_NOTES_TRUSTED_LABEL);
    // Both recall variants ran for the focus query; the trusted one stayed strict.
    expect(searchCalls.map((c) => c.trusted).sort()).toEqual([false, true]);
    for (const c of searchCalls) expect(c.query).toBe("deploy the pipeline");
    expect(internals.currentTrustSources.has("memory")).toBe(true);
  });

  it("shows a verified note under the trusted label, and a note in both tiers exactly once", async () => {
    const shared = note("21", "staging token lives in the vault");
    const { internals } = makeFocusedAdapter("relevant-notes-tiers", {
      trusted: [shared],
      ordinary: [shared, note("22", "guess: deploys fail on Fridays")],
    });
    const prompt = await internals.buildContinuationPrompt();
    const section = prompt.slice(prompt.indexOf(HEADER));
    const trustedAt = section.indexOf(RELEVANT_NOTES_TRUSTED_LABEL);
    const unverifiedAt = section.indexOf(RELEVANT_NOTES_UNVERIFIED_LABEL);
    expect(trustedAt).toBeGreaterThan(-1);
    expect(unverifiedAt).toBeGreaterThan(trustedAt);
    // #21 appears once, inside the trusted block; #22 only in the unverified block.
    expect(section.match(/#21 /g)).toHaveLength(1);
    expect(section.slice(trustedAt, unverifiedAt)).toContain("#21 ");
    expect(section.slice(unverifiedAt)).toContain("#22 ");
    expect(section.slice(trustedAt, unverifiedAt)).not.toContain("#22 ");
  });

  it("renders skills as <example> blocks ahead of both note tiers", async () => {
    const { internals } = makeFocusedAdapter(
      "relevant-notes-skills",
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

  it("caches per focus query — a second build with the same focus does not re-query", async () => {
    const { internals, searchCalls } = makeFocusedAdapter("relevant-notes-cache", {
      trusted: [],
      ordinary: [note("41", "plain")],
    });
    await internals.buildContinuationPrompt();
    const afterFirst = searchCalls.length;
    expect(afterFirst).toBe(2);
    await internals.buildContinuationPrompt();
    expect(searchCalls.length).toBe(afterFirst);
    expect(internals.lastNotesQuery).toBe("deploy the pipeline");
    expect(internals.notesCacheAge).toBe(1);
  });
});
