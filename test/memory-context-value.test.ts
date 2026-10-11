// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import { judgeContextValue, orderContextValue } from "../src/memory/context-value";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import type { UnifiedContextItem } from "../src/sdk/memory-context";

function provider(): DecisionProvider & { calls: number } {
  return {
    kind: "test",
    model: "test/value",
    calibrated: false,
    calls: 0,
    async ask(request) {
      this.calls++;
      const memories = (request.state as { memories: { id: string; text: string }[] }).memories;
      return {
        provider: "test",
        model: "test/value",
        latencyMs: 1,
        answers: Object.fromEntries(
          memories.map((m) => [
            m.id,
            { type: "score", score: m.text.includes("exception") ? 3 : 1 },
          ]),
        ),
      };
    },
  };
}
const item = (id: string, pinned = false): UnifiedContextItem => ({
  id,
  tier: "trusted",
  content: id,
  provenance: id,
  bytes: id.length,
  score: 1,
  ...(pinned ? { meta: { pinned: true } } : {}),
});

describe("context added value", () => {
  it("keeps pinned positions and baseline ties, and does not rewrite records", async () => {
    const items = [item("general"), item("pinned", true), item("exception"), item("other")];
    const before = structuredClone(items);
    const { values, receipt } = await judgeContextValue("query", items, "on", {
      providers: [provider()],
    });
    expect(orderContextValue(items, values).map((x) => x.id)).toEqual([
      "exception",
      "pinned",
      "general",
      "other",
    ]);
    expect(items).toEqual(before);
    expect(receipt?.calibration).toBe("unmeasured");
    expect(Object.keys(receipt!.signals)).toHaveLength(3);
  });

  it("observation and backend failure preserve selection", async () => {
    const items = [item("general"), item("exception")];
    const observed = await judgeContextValue("query", items, "observe", {
      providers: [provider()],
    });
    expect(orderContextValue(items, observed.values)).toEqual(items);
    expect(observed.receipt?.applied).toBe(false);
    const failed = await judgeContextValue("query", items, "on", { providers: [] });
    expect(orderContextValue(items, failed.values)).toEqual(items);
    expect(failed.receipt?.status).toBe("unavailable");
  });

  it("integrates with byte budgeting, receipts and the context cache; off makes no calls", async () => {
    const db = new MarinaDB(":memory:");
    try {
      db.createUser({ id: "u_value", name: "Ada" });
      const exception = db.createNote(
        "Ada",
        "Amber deployment port exception: production needs port 7419.",
        undefined,
        { importance: 3 },
      );
      const general = db.createNote(
        "Ada",
        "Amber deployment port guide: normally the production port is 3300.",
        undefined,
        { importance: 9 },
      );
      const judge = provider();
      const opts = {
        scope: "legacy" as const,
        budgetBytes: 65,
        itemMaxBytes: 65,
        creditReflections: false,
      };
      const run = (mode: string) =>
        buildUnifiedContext(db, "Ada", "Amber deployment port", opts, {
          env: { MARINA_MEMORY_CONTEXT_VALUE: mode },
          valueOptions: { providers: [judge] },
        });
      const baseline = await run("off");
      expect(judge.calls).toBe(0);
      expect(baseline.tiers.flatMap((t) => t.items)[0]?.id).toBe(String(general));
      const observed = await run("observe");
      const selection = (r: typeof baseline) =>
        r.tiers.map((t) => ({
          tier: t.tier,
          omitted: t.omitted,
          items: t.items.map((i) => ({ id: i.id, content: i.content, bytes: i.bytes })),
        }));
      expect(selection(observed)).toEqual(selection(baseline));
      const applied = await run("on");
      expect(applied.tiers.flatMap((t) => t.items)[0]?.id).toBe(String(exception));
      expect(applied.usedBytes).toBeLessThanOrEqual(65);
      expect(applied.tiers.map((t) => t.tier)).toEqual(baseline.tiers.map((t) => t.tier));
      const calls = judge.calls;
      const again = await run("on");
      expect(judge.calls).toBe(calls);
      expect(again.valueDecision?.id).toBe(applied.valueDecision?.id);
      expect(db.listDecisionReceipts("Ada")).toHaveLength(2);
      expect(db.getNote(exception)?.content).toContain("exception");
    } finally {
      db.close();
    }
  });

  it("rechecks withdrawal during judging before serving any selected memory", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const retired = db.createNote("Ada", "Amber deployment port exception", undefined, {
        importance: 9,
      });
      db.createNote("Ada", "Amber deployment port general guide", undefined, { importance: 8 });
      const judge = provider();
      const ask = judge.ask.bind(judge);
      judge.ask = async (request, signal) => {
        db.deleteNote(retired, "Ada");
        return ask(request, signal);
      };
      const result = await buildUnifiedContext(
        db,
        "Ada",
        "Amber deployment port",
        { scope: "legacy" },
        {
          env: { MARINA_MEMORY_CONTEXT_VALUE: "on" },
          valueOptions: { providers: [judge] },
        },
      );
      expect(result.tiers.flatMap((t) => t.items).some((i) => i.id === String(retired))).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });
});
