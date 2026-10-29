// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyModelResolution, resolveModel } from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";
import { modelAcceptsImageInput } from "../src/agent/vision-input";
import { catalogModel, snapshotBaseId } from "../src/net/model/catalog-snapshots";
import { openRouterEffortFor } from "../src/net/model/reasoning-effort";

const BASE = "deepseek/deepseek-v4.1-flash";
const SNAPSHOT = `${BASE}-1017`;
const listed = (id: string) => piModels.getModel("openrouter", id);
// The catalog as it was before pi-ai listed the snapshot, so the fallback stays exercised.
const lookup = (id: string) => (id === SNAPSHOT ? undefined : listed(id));

describe("dated snapshots the bundled catalog does not list", () => {
  it("strips a -MMDD or -YYYYMMDD suffix, nothing else", () => {
    expect(snapshotBaseId(SNAPSHOT)).toBe(BASE);
    expect(snapshotBaseId(`${BASE}-20261017`)).toBe(BASE);
    for (const id of [BASE, "gpt-oss-120b", "claude-haiku-5-5", "x-1399", "x-0000", "x-1232"])
      expect(snapshotBaseId(id)).toBeUndefined();
  });

  it("the base is listed, and a snapshot pi-ai lists itself is returned as listed", () => {
    expect(lookup(BASE)?.reasoning).toBe(true);
    const own = listed(SNAPSHOT);
    if (own) expect(catalogModel(listed, SNAPSHOT)).toBe(own);
  });

  it("takes the base entry's capabilities under its own id and price", () => {
    const base = lookup(BASE)!;
    const snap = catalogModel(lookup, SNAPSHOT)!;
    expect(snap.id).toBe(SNAPSHOT);
    expect(snap.reasoning).toBe(true);
    expect(snap.api).toBe(base.api);
    expect(snap.input).toEqual(base.input);
    expect(snap.compat).toEqual(base.compat);
    expect(snap.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
    // A listed id is returned as listed; an unknown base yields nothing.
    expect(catalogModel(lookup, BASE)).toBe(base);
    expect(catalogModel(lookup, "deepseek/no-such-model-1017")).toBeUndefined();
  });

  it("an unpriced snapshot is $0 here (the provider's usage.cost prices it), never the base's price", () => {
    const snap = catalogModel(lookup, `${BASE}-0101`)!;
    expect(snap.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("resolves exactly, with reasoning and image input, through every lookup site", () => {
    expect(classifyModelResolution(`openrouter/${SNAPSHOT}`)).toBe("exact");
    const model = resolveModel(`openrouter/${SNAPSHOT}`);
    expect(model.id).toBe(SNAPSHOT);
    expect(model.reasoning).toBe(true);
    expect(modelAcceptsImageInput(`openrouter/${SNAPSHOT}`)).toBe(true);
    // DeepSeek V4.1 Flash has no `medium`: the snapshot clamps like its base.
    expect(openRouterEffortFor(SNAPSHOT, "medium")).toBe(openRouterEffortFor(BASE, "medium"));
    expect(openRouterEffortFor(SNAPSHOT, "medium")).toBe("high");
  });
});
