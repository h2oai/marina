// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Dated model snapshots the bundled pi-ai catalog does not list yet.
 *
 * Providers publish a dated snapshot of a model (`deepseek/deepseek-v4.1-flash-1017`,
 * `…-20261017`) before pi-ai's catalog lists it. Without an entry the id was
 * synthesized with `reasoning: false` and no thinking-level map, so the
 * snapshot lost what Marina knows about its family: the reasoning-effort
 * clamp (DeepSeek V4.1 Flash has no `medium`), the reasoning disable on a
 * summary call, image input, and DeepSeek's reasoning round-trip. An unlisted
 * id with a dated suffix whose base id IS listed takes the base entry's
 * capabilities under its own id. The price is never copied: it comes from
 * Marina's own list ({@link defaultModelPrice}), else it is $0 here and the
 * provider's reported `usage.cost` prices the call.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { defaultModelPrice } from "../../agent/provider-cost";

/** `-MMDD` or `-YYYYMMDD` at the end of an id. */
const SNAPSHOT_SUFFIX = /^(.+)-((?:\d{4})?(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

const UNPRICED = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** The id without its dated snapshot suffix, or `undefined` when it has none. */
export function snapshotBaseId(id: string): string | undefined {
  return SNAPSHOT_SUFFIX.exec(id)?.[1];
}

/**
 * The catalog entry for `id`: the listed one, else a dated snapshot of a
 * listed model under the snapshot's own id, else `undefined`.
 */
export function catalogModel(
  lookup: (id: string) => Model<Api> | undefined,
  id: string,
): Model<Api> | undefined {
  const listed = lookup(id);
  if (listed) return listed;
  const baseId = snapshotBaseId(id);
  const base = baseId ? lookup(baseId) : undefined;
  if (!base || !baseId) return undefined;
  return {
    ...base,
    id,
    name: `${base.name} (${id.slice(baseId.length + 1)})`,
    cost: defaultModelPrice(id) ?? { ...UNPRICED },
  };
}
