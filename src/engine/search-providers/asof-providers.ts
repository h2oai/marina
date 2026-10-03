// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The date-bounded provider set, registered by `initProviders*`. Each is free
 * and keyless and declares `dateBound: "strict"` (see each file for HOW the
 * bound is enforced).
 */

import { arxivAsOfProvider } from "./arxiv";
import { gdeltProvider } from "./gdelt";
import { hnProvider } from "./hn";
import type { SearchProvider } from "./index";
import { waybackProvider } from "./wayback";
import { wikipediaProvider } from "./wikipedia";

/** Provider names usable in `asof:` retriever specs and `engines:` lists. */
export const DATE_BOUND_PROVIDER_NAMES = ["gdelt", "wikipedia", "hn", "arxiv", "wayback"] as const;
export type DateBoundProviderName = (typeof DATE_BOUND_PROVIDER_NAMES)[number];

export function dateBoundProviders(): SearchProvider[] {
  return [
    gdeltProvider(),
    wikipediaProvider(),
    hnProvider(),
    arxivAsOfProvider(),
    waybackProvider(),
  ];
}

/** One provider by name (`asof:` specs build their own instances). */
export function dateBoundProvider(name: string): SearchProvider | undefined {
  switch (name) {
    case "gdelt":
      return gdeltProvider();
    case "wikipedia":
      return wikipediaProvider();
    case "hn":
      return hnProvider();
    case "arxiv":
      return arxivAsOfProvider();
    case "wayback":
      return waybackProvider();
    default:
      return undefined;
  }
}
