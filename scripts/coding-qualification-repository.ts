// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** A real Marina checkout, with an independently checked, useful terminal task.
 * The qualification runner clones committed source; it never edits the operator's checkout. */
export function codingRepositoryFixture() {
  return {
    sourcePaths: ["scripts/code-views.ts"],
    regressionPaths: ["test/code-view-latest.test.ts"],
    files: {
      ".qualification/acceptance.test.ts": `import { expect, test } from "bun:test";
import { TerminalViews, TERMINAL_HISTORY_LIMITS } from "../scripts/code-views";
test("return from paged history directly to the newest retained output", () => {
  const views = new TerminalViews({ ...TERMINAL_HISTORY_LIMITS, pageEntries: 2 });
  for (let i = 0; i < 10; i++) views.append("coding", "entry-" + i);
  views.page("older");
  views.append("coding", "fresh-result");
  expect(views.stats().unread.coding).toBe(1);
  const latest = views.latest();
  expect(latest).toContain("fresh-result");
  expect(latest).toContain("recent");
  expect(views.stats().unread.coding).toBe(0);
});
`,
    },
    task: `Implement a useful terminal history improvement in this Marina repository.
Read the applicable repository instructions and scripts/code-views.ts.
Add TerminalViews.latest(): string to return directly to the newest retained local page in the focused Coding or World conversation and clear only that conversation's unread count.
Preserve the other conversation's position/unread state, all retained entries and eviction counters. Do not change focus. In Requests or Panel, return helpful guidance without changing any conversation state.
Only change scripts/code-views.ts and add test/code-view-latest.test.ts with regression coverage. Do not edit existing tests, configuration, or .qualification/acceptance.test.ts. Do not implement CLI wiring; the owner will review and integrate it separately.
The owner saved a default recipe: bun test ./.qualification/acceptance.test.ts ./test/code-view-latest.test.ts. These specific tests import only local files and Bun/Node builtins, so use code verify candidate dependencies:none (marina_code action=verify, verificationMode=candidate, dependencies=none). This disables the repository-wide dependency probe, not the checks. Inspect the completed receipt with action=show and artifactId=<receipt id>; background admission is not a passing result. Submit the exact verified candidate with a concise summary. Do not commit or push.`,
    recipe: "bun test ./.qualification/acceptance.test.ts ./test/code-view-latest.test.ts",
  };
}

/** Independent checks are outside the worker checkout and run only after submission. */
export function codingRepositoryHoldout(root: string) {
  return `import { strict as assert } from "node:assert";
import { TerminalViews, TERMINAL_HISTORY_LIMITS } from ${JSON.stringify(`${root}/scripts/code-views.ts`)};
for (const view of ["coding", "world"]) for (const pageEntries of [1, 2, 5]) {
  const other = view === "coding" ? "world" : "coding";
  const v = new TerminalViews({ ...TERMINAL_HISTORY_LIMITS, entries: 16, perView: 8, pageEntries });
  for (let i=0; i<20; i++) { v.append(view, view + i); v.append(other, other + i); }
  v.select(other); v.page("older"); v.append(other, "other-new");
  const otherPage = v.snapshot(other); const otherUnread = v.stats().unread[other];
  v.select(view); v.page("older"); v.append(view, "target-new");
  const before = v.stats();
  const latest = v.latest();
  assert.ok(latest.includes("target-new")); assert.ok(latest.includes("recent local history"));
  assert.equal(v.focus, view); assert.equal(v.stats().unread[view], 0);
  assert.equal(v.stats().unread[other], otherUnread); assert.equal(v.snapshot(other), otherPage);
  assert.deepEqual(v.stats().evicted, before.evicted); assert.equal(v.stats().bytes, before.bytes);
  assert.equal(v.stats().entries, before.entries); assert.equal(v.latest(), latest);
  for (const nonConversation of ["approvals", "panel"]) {
    v.select(nonConversation); const state = v.stats();
    assert.ok(v.latest().length > 0); assert.deepEqual(v.stats(), state);
    assert.equal(v.focus, nonConversation); assert.equal(v.snapshot(other), otherPage);
  }
}
console.log("Independent real-repository history contract passed");`;
}
